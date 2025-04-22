import {
    Action,
    IAgentRuntime,
    Memory,
    State,
    HandlerCallback,
    generateText,
    ModelClass
} from "@elizaos/core";
import {Context} from "telegraf";
import {Update, CallbackQuery} from "telegraf/types";
import redis from "../redis/redis.ts";
import {POLL_CONSTANTS} from "../telegram/constants.ts";
import {getGroupsByUserId} from "./utils.ts";

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


// Helper function to extract JSON from text response
function extractJsonFromResponse(text: string): any {
    try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
    } catch (error) {
        console.error('Error parsing JSON:', error);
    }
    return null;
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
            {text: `${i + 1}. ${opt}`, callback_data: `poll_vote:${pollId}:${opt}`}
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
    description: "Handle poll creation and management",
    validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        console.log('[POLL] Starting validation check');
        if (!state?.handle) {
            console.log('[POLL] Validation failed: No state handle found');
            return false;
        }


        console.log('[POLL] Fetching recent messages for context');
        const recentMessages = await runtime.messageManager.getMemories({
            roomId: message.roomId,
            count: 5
        });

        console.log('[POLL] Creating context for AI analysis');
        const context = {
            recentMessages: recentMessages.map(m => m.content.text).join('\n'),
            currentMessage: message.content.text,
            currentState: state
        };

        console.log('[POLL] Analyzing intent with AI');
        const analysis = await generateText({
            runtime,
            context: `You are a JSON-only response bot. Your task is to analyze if a message indicates an intent to manage polls.
            IMPORTANT: This is ONLY for poll management, NOT for summarizing, sending messages, or finding mentions.
            
            Recent messages: ${context.recentMessages}
            Current message: ${context.currentMessage}
            
            Return ONLY a JSON object with the following structure, no other text:
            {
                "hasIntent": boolean, // true ONLY if user wants to manage polls
                "pollType": string, // "create", "results", "close", "list", or null
                "confidence": number, // confidence score of the analysis
                "groupName": string, // name of the group if specified
                "pollDetails": { // only if pollType is "create"
                    "question": string,
                    "options": string[]
                }
            }`,
            modelClass: ModelClass.SMALL
        });

        console.log('[POLL] AI Analysis response:', analysis);

        const result = extractJsonFromResponse(analysis);
        if (!result) {
            console.error('[POLL] Failed to extract valid JSON from analysis');
            return false;
        }

        console.log('[POLL] Analysis result:', JSON.stringify(result, null, 2));

        if (!result.hasIntent || result.confidence < 0.7) {
            console.log('[POLL] Low confidence or no intent found');
            return false;
        }

        console.log('[POLL] Validation successful:', result.hasIntent);
        return result.hasIntent;
    },
    suppressInitialMessage: true,
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
        options?: any,
        callback?: HandlerCallback
    ): Promise<void> => {
        console.log('[POLL] Starting handler execution');
        const ctx = options.ctx as Context<Update>;

        console.log('[POLL] Fetching recent messages for context');
        const recentMessages = await runtime.messageManager.getMemories({
            roomId: message.roomId,
            count: 5
        });

        console.log('[POLL] Fetching user groups from Redis');
        const [groupIds, groupInfos] = await getGroupsByUserId(ctx.from.id.toString());
        console.log('[POLL] Found groups:', groupInfos.map(g => g.title).join(', '));

        console.log('[POLL] Analyzing message for specific action');
        const analysis = await generateText({
            runtime,
            context: `You are a JSON-only response bot. Your task is to analyze a message in the context of poll management.
            
            Recent conversation:
            ${recentMessages.map(m => m.content.text).join('\n')}
            
            Current message: ${message.content.text}
            Available groups: ${groupInfos.map(g => g.title).join(', ')}
            
            Return ONLY a JSON object with the following structure, no other text:
            {
                "pollType": string, // "create", "results", "close", "list"
                "targetGroup": string, // name of the group (if specified)
                "pollDetails": { // only if pollType is "create"
                    "question": string,
                    "options": string[]
                },
                "pollId": string, // only if pollType is "results" or "close"
                "response": string // the exact message the bot should respond with
            }

            Additional guidelines:
            - Consider the recent conversation context when determining poll type
            - If the user has been discussing a specific group, prioritize that group
            - If the user has been creating polls, look for question and options in the conversation
            - If the user has been checking results, look for poll IDs in the conversation
            - If the user has been canceling frequently, be more explicit about the cancelation
            `,
            modelClass: ModelClass.SMALL
        });

        await runtime.messageManager.createMemory({
            content: {
                text: message.content.text
            },
            roomId: message.roomId,
            userId: message.userId,
            agentId: message.agentId
        });

        console.log('[POLL] Handler analysis response:', analysis);

        const result = extractJsonFromResponse(analysis);
        if (!result) {
            console.error('[POLL] Failed to extract valid JSON from handler analysis');
            await callback({
                text: "I'm having trouble understanding your poll request. Could you please rephrase?",
                action: "POLL"
            });
            return;
        }

        console.log('[POLL] Processing intent:', result.pollType);

        const targetGroup = groupInfos.find(group =>
            group.title?.toLowerCase() === result.targetGroup?.toLowerCase()
        );

        switch (result.pollType) {
            case 'create':
                console.log('[POLL] Processing create intent for group:', result.targetGroup);
                if (!targetGroup) {
                    console.log('[POLL] Target group not found:', result.targetGroup);
                    await callback({
                        text: `I couldn't find the group "${result.targetGroup}". Here are the groups you have access to:\n${groupInfos.map(g => g.title).join('\n')}`,
                        action: "POLL"
                    });
                    return;
                }

                if (!result.pollDetails?.question || !result.pollDetails?.options?.length) {
                    console.log('[POLL] Missing poll details');
                    await callback({
                        text: "I need both a question and at least two options to create a poll. Please provide them.",
                        action: "POLL"
                    });
                    return;
                }

                console.log('[POLL] Creating poll with details:', JSON.stringify(result.pollDetails));
                await handlePollCreate(ctx, parseInt(targetGroup.id), result.pollDetails.question, result.pollDetails.options);
                break;

            case 'results':
                console.log('[POLL] Processing results intent for poll:', result.pollId);
                if (!result.pollId) {
                    console.log('[POLL] No poll ID specified');
                    await callback({
                        text: "Please specify which poll's results you want to see.",
                        action: "POLL"
                    });
                    return;
                }
                await handlePollResults(ctx, result.pollId);
                break;

            case 'close':
                console.log('[POLL] Processing close intent for poll:', result.pollId);
                if (!result.pollId) {
                    console.log('[POLL] No poll ID specified');
                    await callback({
                        text: "Please specify which poll you want to close.",
                        action: "POLL"
                    });
                    return;
                }
                await handlePollClose(ctx, result.pollId);
                break;

            case 'list':
                console.log('[POLL] Processing list intent for group:', targetGroup?.title);
                await handlePollList(ctx, targetGroup?.id);
                break;

            default:
                console.log('[POLL] Unknown intent:', result.pollType);
                await callback({
                    text: "I'm not sure what you'd like to do with the poll. Please specify create, results, close, or list.",
                    action: "POLL"
                });
        }
        console.log('[POLL] Handler execution completed');
    },
    examples: []
};

async function handlePollCreate(ctx: Context<Update>, groupId: number, question: string, options: string[]) {
    if (options.length < POLL_CONSTANTS.MIN_OPTIONS || options.length > POLL_CONSTANTS.MAX_OPTIONS) {
        await ctx.reply(`Please provide between ${POLL_CONSTANTS.MIN_OPTIONS} and ${POLL_CONSTANTS.MAX_OPTIONS} options`);
        return;
    }

    // Get user's groups using existing function
    const [groupIds, groupInfos] = await getGroupsByUserId(ctx.from.id.toString());

    // Get group info
    const groupInfo = groupInfos.find(g => g.id === groupId.toString());
    if (!groupInfo) {
        await ctx.reply(`Group ID ${groupId} not found or you don't have access to it.`);
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
        {text: `${i + 1}. ${opt}`, callback_data: `poll_vote:${poll.id}:${opt}`}
    ]);

    try {
        // Send the poll to the group
        await ctx.telegram.sendMessage(parseInt(groupInfo.id), message, {
            reply_markup: {
                inline_keyboard: keyboard
            }
        });

        // Send private message to the creator with poll details
        const privateMessage = `📊 Your poll has been created!\n\nQuestion: ${question}\nGroup: @${groupInfo.title}\nPoll ID: ${poll.id}\n\nUse these commands to manage your poll:\n/poll results ${poll.id} - View results\n/poll close ${poll.id} - Close the poll`;
        await ctx.reply(privateMessage);
    } catch (error) {
        await ctx.reply(`Failed to create poll in @${groupInfo.title}. Make sure the bot is a member of the group and has permission to send messages.`);
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