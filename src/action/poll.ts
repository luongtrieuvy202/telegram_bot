import {
    Action,
    IAgentRuntime,
    Memory,
    State,
    HandlerCallback,
} from "@elizaos/core";
import { Context } from "telegraf";
import { Update, CallbackQuery } from "telegraf/types";
import redis from "../redis/redis.ts";
import { POLL_CONSTANTS } from "../telegram/constants.ts";
import { getGroupsByUserId } from "./utils.ts";

interface Poll {
    id: string;
    question: string;
    options: string[];
    creator: {
        id: number;
        username: string;
    };
    group: {
        id: number;
        title: string;
    };
    status: 'active' | 'closed';
    responses: {
        total: number;
        votes: Map<string, number>;
    };
    createdAt: number;
}

interface PollResponse {
    pollId: string;
    userId: number;
    option: string;
    timestamp: number;
}

export async function handlePollCallback(ctx: Context<Update>): Promise<void> {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
    
    const callbackData = ctx.callbackQuery.data;
    console.log('Received callback:', callbackData);
    
    if (callbackData.startsWith('poll_vote:')) {
        const [, pollId, option] = callbackData.split(':');
        if (!pollId || !option) {
            await ctx.answerCbQuery('Invalid vote data');
            return;
        }
        
        const poll = await getPoll(pollId);
        if (!poll || poll.status === 'closed') {
            await ctx.answerCbQuery('This poll is no longer active');
            return;
        }

        // Check if user has already voted
        const userVoteKey = `poll_user_vote:${pollId}:${ctx.from.id}`;
        const existingVote = await redis.get(userVoteKey);
        
        if (existingVote) {
            // If user voted for a different option, remove their previous vote
            if (existingVote !== option) {
                const currentVotes = poll.responses.votes.get(existingVote) || 0;
                poll.responses.votes.set(existingVote, Math.max(0, currentVotes - 1));
                poll.responses.total = Math.max(0, poll.responses.total - 1);
            } else {
                await ctx.answerCbQuery('You have already voted for this option');
                return;
            }
        }

        // Record the new vote
        const currentVotes = poll.responses.votes.get(option) || 0;
        poll.responses.votes.set(option, currentVotes + 1);
        poll.responses.total += 1;

        // Store the updated poll and user's vote
        await storePoll(poll);
        await redis.set(userVoteKey, option);
        await redis.expire(userVoteKey, POLL_CONSTANTS.POLL_EXPIRY);

        await ctx.answerCbQuery('Vote recorded!');
        
        // Update the poll message with new results
        const message = formatResultsMessage(poll);
        const keyboard = poll.options.map((opt, i) => [
            { text: `${i + 1}. ${opt}`, callback_data: `poll_vote:${pollId}:${opt}` }
        ]);

        try {
            await ctx.editMessageText(message, {
                reply_markup: {
                    inline_keyboard: keyboard
                }
            });
        } catch (error) {
            console.error('Failed to update poll message:', error);
        }
    }
}

export const pollAction: Action = {
    name: 'POLL',
    similes: [],
    description: "Handle poll creation and voting",
    validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        const text = message.content.text?.toLowerCase() || '';
        return text.startsWith('/poll');
    },
    suppressInitialMessage: true,
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
        options?: any,
        callback?: HandlerCallback
    ): Promise<void> => {
        const ctx = options.ctx as Context<Update>;
        const text = message.content.text || '';
        const match = text.match(/^\/poll\s+(\w+)\s*(.*)$/);
        if (!match) {
            await ctx.reply('Invalid poll command format');
            return;
        }

        const [, command, rest] = match;
        let args: string[] = [];

        // For create command, parse the rest of the text differently
        if (command === 'create') {
            // Match group name and poll details
            const groupMatch = rest.match(/^@(\w+)\s+(.*)$/);
            if (!groupMatch) {
                await ctx.reply('Usage: /poll create @group_name "question" "option1" "option2" [option3] [option4]\n\nMake sure to specify the group and put the question and options in quotes.');
                return;
            }

            const [, groupName, pollText] = groupMatch;
            const matches = pollText.match(/"([^"]*)"/g);
            if (!matches || matches.length < 3) {
                await ctx.reply('Usage: /poll create @group_name "question" "option1" "option2" [option3] [option4]\n\nMake sure to put the question and options in quotes.');
                return;
            }
            args = [groupName, ...matches.map(m => m.replace(/"/g, '').trim())];
        } else {
            // For other commands, split by space
            args = rest.split(' ').filter(Boolean);
        }

        switch (command) {
            case 'create':
                await handlePollCreate(ctx, args);
                break;
            case 'vote':
                await handlePollVote(ctx, args[0], args[1]);
                break;
            case 'results':
                await handlePollResults(ctx, args[0]);
                break;
            case 'close':
                await handlePollClose(ctx, args[0]);
                break;
            case 'list':
                await handlePollList(ctx, args[0]);
                break;
            default:
                await ctx.reply('Invalid poll command. Use /poll create, vote, results, close, or list');
        }
    },
    examples: []
};

async function handlePollCreate(ctx: Context<Update>, args: string[]) {
    if (args.length < 4) {
        await ctx.reply('Usage: /poll create @group_name "question" "option1" "option2" [option3] [option4]\n\nMake sure to specify the group and put the question and options in quotes.');
        return;
    }

    const groupName = args[0].replace('@', '');
    const question = args[1];
    const options = args.slice(2);

    if (options.length < POLL_CONSTANTS.MIN_OPTIONS || options.length > POLL_CONSTANTS.MAX_OPTIONS) {
        await ctx.reply(`Please provide between ${POLL_CONSTANTS.MIN_OPTIONS} and ${POLL_CONSTANTS.MAX_OPTIONS} options`);
        return;
    }

    // Get user's groups using existing function
    const [groupIds, groupInfos] = await getGroupsByUserId(ctx.from.id);
    const groupInfo = groupInfos.find(g => g.title.toLowerCase() === groupName.toLowerCase());
    
    if (!groupInfo) {
        await ctx.reply(`Group @${groupName} not found or you don't have access to it.`);
        return;
    }

    // Initialize votes Map with all options set to 0
    const votesMap = new Map<string, number>();
    options.forEach(opt => votesMap.set(opt, 0));

    const poll: Poll = {
        id: `poll_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        question,
        options,
        creator: {
            id: ctx.from.id,
            username: ctx.from.username || 'unknown'
        },
        group: {
            id: parseInt(groupInfo.id),
            title: groupInfo.title
        },
        status: 'active',
        responses: {
            total: 0,
            votes: votesMap
        },
        createdAt: Date.now()
    };

    await storePoll(poll);

    // Send poll to the specified group
    const message = formatPollMessage(poll);
    const keyboard = options.map((opt, i) => [
        { text: `${i + 1}. ${opt}`, callback_data: `poll_vote:${poll.id}:${opt}` }
    ]);

    try {
        // Send the poll to the group
        await ctx.telegram.sendMessage(groupInfo.id, message, {
            reply_markup: {
                inline_keyboard: keyboard
            }
        });

        // Send private message to the creator with poll details
        const privateMessage = `📊 Your poll has been created!\n\nQuestion: ${question}\nGroup: @${groupName}\nPoll ID: ${poll.id}\n\nUse these commands to manage your poll:\n/poll results ${poll.id} - View results\n/poll close ${poll.id} - Close the poll`;
        await ctx.reply(privateMessage);
    } catch (error) {
        await ctx.reply(`Failed to create poll in @${groupName}. Make sure the bot is a member of the group and has permission to send messages.`);
    }
}

async function handlePollVote(ctx: Context<Update>, pollId: string, option: string) {
    console.log('Handling vote:', { pollId, option });
    const poll = await getPoll(pollId);
    if (!poll || poll.status === 'closed') {
        console.log('Poll not found or closed:', pollId);
        await ctx.answerCbQuery('This poll is no longer active');
        return;
    }

    // Check if user has already voted
    const userVoteKey = `poll_user_vote:${pollId}:${ctx.from.id}`;
    const existingVote = await redis.get(userVoteKey);
    
    if (existingVote) {
        // If user voted for a different option, remove their previous vote
        if (existingVote !== option) {
            const currentVotes = poll.responses.votes.get(existingVote) || 0;
            poll.responses.votes.set(existingVote, Math.max(0, currentVotes - 1));
            poll.responses.total = Math.max(0, poll.responses.total - 1);
        } else {
            await ctx.answerCbQuery('You have already voted for this option');
            return;
        }
    }

    // Record the new vote
    const currentVotes = poll.responses.votes.get(option) || 0;
    poll.responses.votes.set(option, currentVotes + 1);
    poll.responses.total += 1;

    // Store the updated poll and user's vote
    await storePoll(poll);
    await redis.set(userVoteKey, option);
    await redis.expire(userVoteKey, POLL_CONSTANTS.POLL_EXPIRY);

    await ctx.answerCbQuery('Vote recorded!');
    
    // Update the poll message with new results
    const message = formatResultsMessage(poll);
    const keyboard = poll.options.map((opt, i) => [
        { text: `${i + 1}. ${opt}`, callback_data: `poll_vote:${pollId}:${opt}` }
    ]);

    try {
        if (ctx.callbackQuery?.message?.message_id) {
            await ctx.editMessageText(message, {
                reply_markup: {
                    inline_keyboard: keyboard
                }
            });
        } else {
            console.log('No message_id found in callback query');
        }
    } catch (error) {
        console.error('Failed to update poll message:', error);
    }
}

async function handlePollResults(ctx: Context<Update>, pollId: string) {
    const poll = await getPoll(pollId);
    if (!poll) {
        await ctx.reply('Poll not found');
        return;
    }

    await ctx.reply(formatResultsMessage(poll));
}

async function handlePollClose(ctx: Context<Update>, pollId: string) {
    const poll = await getPoll(pollId);
    if (!poll) {
        await ctx.reply('Poll not found');
        return;
    }

    if (poll.creator.id !== ctx.from.id) {
        await ctx.reply('Only the poll creator can close the poll');
        return;
    }

    poll.status = 'closed';
    await storePoll(poll);
    await ctx.reply('Poll closed! Final results:\n\n' + formatResultsMessage(poll));
}

function formatPollMessage(poll: Poll): string {
    return `📊 ${poll.question}\n\n${poll.options.map((opt, i) => `${i + 1}. ${opt}`).join('\n')}\n\nClick a number to vote!`;
}

function formatResultsMessage(poll: Poll): string {
    const total = poll.responses.total;
    const results = poll.options.map(opt => {
        const votes = poll.responses.votes.get(opt) || 0;
        const percentage = total > 0 ? Math.round((votes / total) * 100) : 0;
        return `${opt}: ${percentage}% (${votes} votes)`;
    }).join('\n');
    
    return `📊 ${poll.question}\n\n${results}\n\nTotal votes: ${total}`;
}

async function storePoll(poll: Poll): Promise<void> {
    // Convert Map to plain object for storage
    const pollToStore = {
        ...poll,
        responses: {
            total: poll.responses.total,
            votes: Object.fromEntries(poll.responses.votes)
        }
    };
    await redis.set(`${POLL_CONSTANTS.GROUP_POLL_PREFIX}${poll.group.id}:${poll.id}`, JSON.stringify(pollToStore));
    await redis.expire(`${POLL_CONSTANTS.GROUP_POLL_PREFIX}${poll.group.id}:${poll.id}`, POLL_CONSTANTS.POLL_EXPIRY);
}

async function getPoll(pollId: string): Promise<Poll | null> {
    // Search across all groups for the poll
    const keys = await redis.keys(`${POLL_CONSTANTS.GROUP_POLL_PREFIX}*:${pollId}`);
    if (keys.length === 0) return null;
    
    const data = await redis.get(keys[0]);
    if (!data) return null;

    const pollData = JSON.parse(data);
    // Convert plain object back to Map
    return {
        ...pollData,
        responses: {
            total: pollData.responses.total,
            votes: new Map(Object.entries(pollData.responses.votes))
        }
    };
}

async function handlePollList(ctx: Context<Update>, groupName?: string) {
    const [groupIds, groupInfos] = await getGroupsByUserId(ctx.from.id);
    let keys: string[] = [];

    if (groupName) {
        const groupInfo = groupInfos.find(g => g.title.toLowerCase() === groupName.replace('@', '').toLowerCase());
        if (!groupInfo) {
            await ctx.reply(`Group @${groupName} not found or you don't have access to it.`);
            return;
        }
        keys = await redis.keys(`${POLL_CONSTANTS.GROUP_POLL_PREFIX}${groupInfo.id}:*`);
    } else {
        // Get all polls from user's groups
        for (const groupId of groupIds) {
            const groupKeys = await redis.keys(`${POLL_CONSTANTS.GROUP_POLL_PREFIX}${groupId}:*`);
            keys.push(...groupKeys);
        }
    }

    const polls: Poll[] = [];
    
    for (const key of keys) {
        const data = await redis.get(key);
        if (data) {
            const poll = JSON.parse(data);
            if (poll.status === 'active') {
                polls.push(poll);
            }
        }
    }

    if (polls.length === 0) {
        await ctx.reply('No active polls found.');
        return;
    }

    const message = polls.map(poll => 
        `📊 ${poll.question}\nID: ${poll.id}\nGroup: @${poll.group.title}\nCreated by: @${poll.creator.username}\n`
    ).join('\n');

    await ctx.reply(`Active Polls${groupName ? ` in @${groupName}` : ''}:\n\n${message}\n\nUse /poll results <ID> to view results`);
} 