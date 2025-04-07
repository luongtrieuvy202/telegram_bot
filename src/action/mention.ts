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
import { Context, Telegraf } from "telegraf";
import { Update } from "telegraf/types";
import { checkMentionTimeouts, handleUnrespondedMentions } from "./utils.ts";

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
    examples: [
    ],
}

export const mentionAction: Action = {
    name: 'MENTION',
    similes: [],
    description: "get message that mention",
    validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        return message.content.text.toLowerCase().includes("mention");
    },
    suppressInitialMessage: true,
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
        options?: any,
        callback?: HandlerCallback
    ): Promise<void> => {
            console.log("Hello")
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
            } catch (error) {
                console.error('Failed to handle mentions:', error);
            }
        }

    },
    examples: [
    ],
} as Action

function parseMentionCommand(command: string): { isMention: boolean; groupName?: string } {
    const regex = /(?:is there (?:any|anyone)|get) messages? mention(?:ing)? me in (?:this )?group (?:named )?(.+)/i;
    const match = command.match(regex);

    if (match) {
        return { isMention: true, groupName: match[1] };
    }

    return { isMention: false };
}

