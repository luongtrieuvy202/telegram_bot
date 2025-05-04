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
import { callOpenRouterText } from './utils.ts';
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

interface PollState {
    stage: 'initial' | 'confirmation' | 'creation';
    pollDetails?: {
        question: string;
        options: string[];
        targetGroup: string;
    };
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

async function getPollState(runtime: IAgentRuntime, roomId: string): Promise<PollState | null> {
    const state = await runtime.cacheManager.get(`poll:${roomId}`);
    if (!state) return null;
    try {
        return JSON.parse(state as string) as PollState;
    } catch (error) {
        console.error('Failed to parse poll state:', error);
        return null;
    }
}

async function setPollState(runtime: IAgentRuntime, roomId: string, state: PollState) {
    await runtime.cacheManager.set(`poll:${roomId}`, JSON.stringify(state));
}

async function clearPollState(runtime: IAgentRuntime, roomId: string) {
    await runtime.cacheManager.delete(`poll:${roomId}`);
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

        // Get current poll state
        const pollState = await getPollState(runtime, message.roomId);
        
        // If we're in confirmation stage, check if the message is a confirmation
        if (pollState?.stage === 'confirmation') {
            const isConfirmation = message.content.text.toLowerCase().includes('yes') || 
                                 message.content.text.toLowerCase().includes('confirm') ||
                                 message.content.text.toLowerCase().includes('create');
            return isConfirmation;
        }

        return true;
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

        // Get current poll state
        const pollState = await getPollState(runtime, message.roomId);

        console.log('[POLL] Fetching user groups from Redis');
        const [groupIds, groupInfos] = await getGroupsByUserId(ctx.from.id.toString());
        console.log('[POLL] Found groups:', groupInfos.map(g => g.title).join(', '));

        // If we're in confirmation stage and user confirmed, create the poll
        if (pollState?.stage === 'confirmation' && pollState.pollDetails) {
            const isConfirmation = message.content.text.toLowerCase().includes('yes') || 
                                 message.content.text.toLowerCase().includes('confirm') ||
                                 message.content.text.toLowerCase().includes('create');
            
            if (isConfirmation) {
                const targetGroup = groupInfos.find(group =>
                    group.title?.toLowerCase() === pollState.pollDetails.targetGroup?.toLowerCase()
                );

                if (!targetGroup) {
                    const groupNotFoundResponse = {
                        text: `I couldn't find the group "${pollState.pollDetails.targetGroup}". Here are the groups you have access to:\n${groupInfos.map(g => g.title).join('\n')}`,
                        action: "POLL"
                    };
                    await callback(groupNotFoundResponse);
                    await createMemory(runtime, message, groupNotFoundResponse, true);
                    await clearPollState(runtime, message.roomId);
                    return;
                }

                await handlePollCreate(
                    ctx,
                    parseInt(targetGroup.id),
                    pollState.pollDetails.question,
                    pollState.pollDetails.options
                );
                await clearPollState(runtime, message.roomId);
                return;
            } else {
                const cancelResponse = {
                    text: "Poll creation cancelled. Let me know if you'd like to try again.",
                    action: "POLL"
                };
                await callback(cancelResponse);
                await createMemory(runtime, message, cancelResponse, true);
                await clearPollState(runtime, message.roomId);
                return;
            }
        }

        const recentMessages = await runtime.messageManager.getMemories({
            roomId: message.roomId,
            count: 10
        });
        console.log('[POLL] Analyzing message for specific action');
        const prompt = `
        You are a strict JSON-only response bot that manages polls in group conversations. Your task is to analyze a message and respond with a valid JSON object following the rules below. DO NOT include any natural language or explanation — only the JSON.
        
        ### Context:
        - Recent conversation history (for reference): 
        ${recentMessages.map(m => m.content.text).join('\n')}
        
        - Current message: 
        ${message.content.text}
        
        - Available groups: 
        ${groupInfos.map(g => g.title).join(', ')}
        
        ### Instructions:
        Based on the current message and recent conversation, infer the user's intent and return one of the following pollTypes:
        
        - "create" — The user is trying to create a new poll.
        - "results" — The user is asking for results of a specific poll.
        - "close" — The user wants to close an existing poll.
        - "list" — The user wants to list all polls (active or historical).
        
        ### Output Format:
        Return ONLY a valid JSON object with this exact structure:
        
        {
          "pollType": "create" | "results" | "close" | "list",
          "targetGroup": string | null, // name of the group if mentioned; otherwise null
          "pollDetails": {
            "question": string,
            "options": string[]
          } | null, // required only for "create"
          "pollId": string | null, // required only for "results" and "close"
          "response": string // a human-readable response the bot should send back
        }
        
        ### Rules & Constraints:
        - All fields must be present. If a field is not applicable for the pollType, return null.
        - Use null instead of omitting fields.
        - Do not invent group names or poll IDs — only use what's provided or infer from the message if explicitly mentioned.
        - If necessary information is missing (e.g., question or options for create), return pollType: "create", but leave "pollDetails" fields as null and write a helpful message in "response" explaining what is missing.
        - Your response must be VALID JSON. No trailing commas, no additional text, no Markdown formatting.
        - DO NOT guess intent if the message is unclear — return pollType: "list" by default with a response asking for clarification.
        `;


        console.log(prompt)
        const analysis = await callOpenRouterText({
            prompt: prompt,
            model: 'google/gemini-2.0-flash-001'
        });

        runtime.messageManager.createMemory({
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
            const errorResponse = {
                text: "I'm having trouble understanding your poll request. Could you please rephrase?",
                action: "POLL"
            };
            await callback(errorResponse);
            await createMemory(runtime, message, errorResponse, true);
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
                    const groupNotFoundResponse = {
                        text: `What group would you like to create the poll in?`,
                        action: "POLL"
                    };
                    await callback(groupNotFoundResponse);
                    await createMemory(runtime, message, groupNotFoundResponse, true);
                    return;
                }

                if (!result.pollDetails?.question || !result.pollDetails?.options?.length) {
                    const missingDetailsResponse = {
                        text: "Please provide both a question and options for the poll.",
                        action: "POLL"
                    };
                    await callback(missingDetailsResponse);
                    await createMemory(runtime, message, missingDetailsResponse, true);
                    return;
                }

                // Store poll details and show confirmation message
                await setPollState(runtime, message.roomId, {
                    stage: 'confirmation',
                    pollDetails: {
                        question: result.pollDetails.question,
                        options: result.pollDetails.options,
                        targetGroup: targetGroup.title
                    }
                });

                const confirmationMessage = `I'll create a poll with the following details:\n\n` +
                    `Question: ${result.pollDetails.question}\n\n` +
                    `Options:\n${result.pollDetails.options.map((opt, i) => `${i + 1}. ${opt}`).join('\n')}\n\n` +
                    `Group: ${targetGroup.title}\n\n` +
                    `Please confirm by typing 'yes' or 'confirm' to create this poll, or 'no' to cancel.`;

                const confirmationResponse = {
                    text: confirmationMessage,
                    action: "POLL"
                };
                await callback(confirmationResponse);
                await createMemory(runtime, message, confirmationResponse, true);
                break;

            case 'results':
                console.log('[POLL] Processing results intent for poll:', result.pollId);
                if (!result.pollId) {
                    console.log('[POLL] No poll ID specified');
                    const missingIdResponse = {
                        text: "Please specify which poll's results you want to see.",
                        action: "POLL"
                    };
                    await callback(missingIdResponse);
                    await createMemory(runtime, message, missingIdResponse, true);
                    return;
                }
                await handlePollResults(ctx, result.pollId);
                break;

            case 'close':
                console.log('[POLL] Processing close intent for poll:', result.pollId);
                if (!result.pollId) {
                    console.log('[POLL] No poll ID specified');
                    const missingIdResponse = {
                        text: "Please specify which poll you want to close.",
                        action: "POLL"
                    };
                    await callback(missingIdResponse);
                    await createMemory(runtime, message, missingIdResponse, true);
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
                const unknownIntentResponse = {
                    text: "I'm not sure what you'd like to do with the poll. Please specify create, results, close, or list.",
                    action: "POLL"
                };
                await callback(unknownIntentResponse);
                await createMemory(runtime, message, unknownIntentResponse, true);
        }
        console.log('[POLL] Handler execution completed');
    },
    examples: []
};

async function handlePollCreate(ctx: Context<Update>, groupId: number, question: string, options: string[]) {
    try {
        const poll = await ctx.telegram.sendPoll(groupId, question, options, {
            is_anonymous: false,
            allows_multiple_answers: false
        });

        const chat = await ctx.telegram.getChat(groupId);
        if (!('title' in chat)) {
            throw new Error('Invalid chat type');
        }

        const pollId = poll.poll.id;

        // Store poll in Redis
        const newPoll: Poll = {
            id: pollId,
            question,
            options,
            creator: {
                id: ctx.from.id,
                username: ctx.from.username || ctx.from.first_name
            },
            group: {
                id: groupId,
                title: chat.title
            },
            status: 'active',
            responses: {
                total: 0,
                votes: new Map()
            },
            createdAt: Date.now()
        };

        await storePoll(newPoll);

        const privateMessage = `📊 Your poll has been created!\n\nQuestion: ${question}\nGroup: @${chat.title}\nPoll ID: ${pollId}\n`;
        await ctx.reply(privateMessage);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await ctx.reply(`Failed to create poll. ${errorMessage}`);
    }
}

async function handlePollResults(ctx: Context<Update>, pollId: string) {
    const poll = await getPoll(pollId);
    if (!poll) {
        await ctx.reply('Poll not found. Please check the poll ID and try again.');
        return;
    }

    await ctx.reply(formatResultsMessage(poll));
}

async function handlePollClose(ctx: Context<Update>, pollId: string) {
    const poll = await getPoll(pollId);
    if (!poll) {
        await ctx.reply('Poll not found. Please check the poll ID and try again.');
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
    const polls = await redis.keys('poll:*');
    const activePolls: Poll[] = [];

    for (const key of polls) {
        const poll = await getPoll(key.split(':')[1]);
        if (poll && poll.status === 'active' && (!groupName || poll.group.title === groupName)) {
            activePolls.push(poll);
        }
    }

    if (activePolls.length === 0) {
        await ctx.reply(`No active polls found${groupName ? ` in @${groupName}` : ''}.`);
        return;
    }

    const pollsList = activePolls.map(poll =>
        `📊 ${poll.question}\nID: ${poll.id}\nGroup: @${poll.group.title}\nCreated by: @${poll.creator.username}\n`
    ).join('\n');

    await ctx.reply(`Active Polls${groupName ? ` in @${groupName}` : ''}:\n\n${pollsList}\n\nUse /poll results <ID> to view results`);
}

// Add the createMemory function after the other helper functions
async function createMemory(
    runtime: IAgentRuntime,
    message: Memory,
    response: { text: string; action: string },
    isBotMessage: boolean
): Promise<void> {
    const prefix = isBotMessage ? 'Tely: ' : 'User: ';
    const prefixedText = `${prefix}${response.text}`;

    await runtime.messageManager.createMemory({
        content: { text: prefixedText },
        roomId: message.roomId,
        userId: message.userId,
        agentId: message.agentId
    });
} 