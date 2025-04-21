import {
    Action,
    IAgentRuntime,
    Memory,
    State,
    HandlerCallback,
    generateText,
    ModelClass,
} from "@elizaos/core";


import redis from "../redis/redis.ts";
import {Context, Telegraf} from "telegraf";
import {Update} from "telegraf/types";
import {checkMentionTimeouts, handleUnrespondedMentions} from "./utils.ts";

export const autoMention: Action = {
    name: 'MENTION_AUTO',
    similes: [],
    description: "get message that mention",
    validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        return message.content.text.toLowerCase().includes("test")
    },
    suppressInitialMessage: true,
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
        options?: any,
        callback?: HandlerCallback
    ): Promise<void> => {
        const bot = await runtime.clients[0].bot as Telegraf
        checkMentionTimeouts(bot);
    },
    examples: [],
}

// Helper function to extract JSON from AI response
function extractJsonFromResponse(response: string): any {
    try {
        // First try direct parse
        return JSON.parse(response);
    } catch (error) {
        // If direct parse fails, try to extract JSON from the response
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                return JSON.parse(jsonMatch[0]);
            } catch (e) {
                console.error('Failed to parse extracted JSON:', e);
                return null;
            }
        }
        return null;
    }
}

export const mentionAction: Action = {
    name: 'MENTION',
    similes: ['mention', 'tag', 'notify'],
    description: "Get messages where you were mentioned",
    validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        if (!state?.handle) return false;

        await runtime.messageManager.createMemory({
            roomId: message.roomId,
            userId: message.userId,
            agentId: message.agentId,
            content: {
                text: message.content.text,
                type: "text"
            }
        });

        // Get recent messages for context
        const recentMessages = await runtime.messageManager.getMemories({
            roomId: message.roomId,
            count: 5
        });

        // Create context for AI analysis
        const context = {
            recentMessages: recentMessages.map(m => m.content.text).join('\n'),
            currentMessage: message.content.text,
            currentState: state
        };

        // Use AI to analyze the intent
        const analysis = await generateText({
            runtime,
            context: `You are a JSON-only response bot. Your task is to analyze if a message indicates an intent to find messages where the user was mentioned.
            IMPORTANT: This is ONLY for finding messages where the user was @mentioned, NOT for summarizing or sending messages.
            
            Recent messages: ${context.recentMessages}
            Current message: ${context.currentMessage}
            
            Return ONLY a JSON object with the following structure, no other text:
            {
                "hasIntent": boolean, // true ONLY if user wants to find messages where they were mentioned
                "targetGroup": string, // name of the group to check (if specified)
                "isAllGroups": boolean, // true if user wants to check all groups
                "confidence": number, // confidence score of the analysis
                "nextAction": string, // what the bot should do next
                "isSummaryRequest": boolean, // true if this is actually a request to summarize
                "isSendRequest": boolean // true if this is actually a request to send a message
            }`,
            modelClass: ModelClass.SMALL
        });

        console.log('Mention analysis response:', analysis);

        const result = extractJsonFromResponse(analysis);
        if (!result) {
            console.error('Failed to extract valid JSON from analysis');
            return false;
        }

        // Explicitly reject other types of requests
        if (result.isSummaryRequest || result.isSendRequest) {
            return false;
        }

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
        const ctx = options.ctx as Context<Update>
        const userKey = `user:${ctx.message.from.id.toString()}:pending_mentions`

        const userId = userKey.split(':')[1];
        const mentions = await redis.zrange(userKey, 0, -1, 'WITHSCORES');

        // Group mentions by user and collect data
        const mentionsToNotify = [];
        const mentionsToDelete = [];


        for (const mention of mentions) {
            const [chatId, messageId] = mention.split(':');
            const mentionData = await redis.hgetall(`mention:${chatId}:${messageId}`);

            if (mentionData.status === 'unresponded') {
                mentionsToNotify.push(mentionData);
                mentionsToDelete.push({
                    userKey,
                    mentionKey: mention,
                    hashKey: `mention:${chatId}:${messageId}`
                });
            }
        }

        // If we have mentions to notify
        if (mentionsToNotify.length > 0) {
            try {
                await handleUnrespondedMentions(userId, mentionsToNotify, runtime.clients[0].bot);

                // Clean up all processed mentions
                const pipeline = redis.pipeline();
                for (const {userKey, mentionKey, hashKey} of mentionsToDelete) {
                    pipeline.zrem(userKey, mentionKey);
                    pipeline.del(hashKey);
                }
                await pipeline.exec();
                return
            } catch (error) {
                console.error('Failed to handle mentions:', error);
            }
        }

        callback({
            text: "Seems like you haven't been mentioned in any messages recently. Check back later!",
            action: "MENTION"
        })

    },
    examples: [],
} as Action

function parseMentionCommand(command: string): { isMention: boolean; groupName?: string } {
    const regex = /(?:is there (?:any|anyone)|get) messages? mention(?:ing)? me in (?:this )?group (?:named )?(.+)/i;
    const match = command.match(regex);

    if (match) {
        return {isMention: true, groupName: match[1]};
    }

    return {isMention: false};
}

