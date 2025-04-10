import {
    Action,
    IAgentRuntime,
    Memory,
    State,
    HandlerCallback,
} from "@elizaos/core";
import { Context, Telegraf } from "telegraf";
import { Update } from "telegraf/types";
import { getGroupsByUserId } from "./utils.ts";
import redis from "../redis/redis.ts";

export const sendToGroupAction: Action = {
    name: 'SEND_TO_GROUP',
    similes: ['send', 'message', 'post'],
    description: "Send a message to a specific group",
    validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        // Check if it's a direct message and starts with /send
        return message.content.text.startsWith('/send');
    },
    suppressInitialMessage: true,
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
        options?: any,
        callback?: HandlerCallback
    ): Promise<void> => {
        const bot = runtime.clients[0].bot as Telegraf;
        const ctx = options.ctx as Context<Update>;
        
        // Format: /send "group name" "message content"
        const match = message.content.text.match(/^\/send\s+"([^"]+)"\s+"([^"]+)"$/);
        
        if (!match) {
            await callback({
                text: 'Usage: /send "group name" "message content"\nExample: /send "Agentlauncher x Solana (project)" "Hello everyone!"',
                action: "SEND_TO_GROUP"
            });
            return;
        }
        
        const [, groupName, messageContent] = match;
        
        try {
            // Get user's groups from Redis
            const [groupIds, groupInfos] = await getGroupsByUserId(ctx.from.id.toString());
            
            // Find the target group
            const targetGroup = groupInfos.find(group => 
                group.title?.toLowerCase().includes(groupName.toLowerCase())
            );
            
            if (!targetGroup) {
                await callback({
                    text: `Group "${groupName}" not found or you don't have access to it.`,
                    action: "SEND_TO_GROUP"
                });
                return;
            }
            
            // Check if the group is authorized
            const config = runtime.character.clientConfig?.telegram;
            if (config?.shouldOnlyJoinInAllowedGroups) {
                const allowedGroups = config.allowedGroupIds || [];
                if (!allowedGroups.includes(targetGroup.id)) {
                    await callback({
                        text: `Group "${groupName}" is not authorized.`,
                        action: "SEND_TO_GROUP"
                    });
                    return;
                }
            }
            
            // Send the message to the group
            await bot.telegram.sendMessage(targetGroup.id, messageContent);
            
            // Log the message in Redis
            const messageId = Date.now().toString();
            await redis.multi()
                .hset(`group:${targetGroup.id}:message:${messageId}`, {
                    id: messageId,
                    from: ctx.from.id.toString(),
                    text: messageContent,
                    date: Date.now().toString(),
                    username: ctx.from.username || ctx.from.first_name
                })
                .zadd(`group:${targetGroup.id}:messages`, Date.now(), messageId)
                .exec();
            
            await callback({
                text: `Message sent successfully to ${targetGroup.title}`,
                action: "SEND_TO_GROUP"
            });
        } catch (error) {
            await callback({
                text: `Failed to send message: ${error.message}`,
                action: "SEND_TO_GROUP"
            });
        }
    },
    examples: []
} as Action; 