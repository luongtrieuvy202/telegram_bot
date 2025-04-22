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
import {checkMentionTimeouts, handleUnrespondedMentions, getGroupsByUserId, getUserGroupMessages} from "./utils.ts";

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
        console.log('[MENTION] Starting validation check');
        if (!state?.handle) {
            console.log('[MENTION] Validation failed: No state handle found');
            return false;
        }


        console.log('[MENTION] Fetching recent messages for context');
        const recentMessages = await runtime.messageManager.getMemories({
            roomId: message.roomId,
            count: 5
        });

        console.log('[MENTION] Creating context for AI analysis');
        const context = {
            recentMessages: recentMessages.map(m => m.content.text).join('\n'),
            currentMessage: message.content.text,
            currentState: state
        };

        console.log('[MENTION] Analyzing intent with AI');
        const analysis = await generateText({
            runtime,
            context: `You are a JSON-only response bot. Your task is to analyze if a message indicates an intent to find mentions in groups.
            IMPORTANT: This is ONLY for finding mentions, NOT for summarizing, sending messages, or finding unanswered questions.
            
            Recent messages: ${context.recentMessages}
            Current message: ${context.currentMessage}
            
            Return ONLY a JSON object with the following structure, no other text:
            {
                "hasIntent": boolean, // true ONLY if user wants to find mentions
                "targetGroup": string, // name of the group to check (if specified)
                "isAllGroups": boolean, // true if user wants to check all groups
                "confidence": number, // confidence score of the analysis
                "nextAction": string, // what the bot should do next
                "isSummaryRequest": boolean, // true if this is actually a request to summarize
                "isSendRequest": boolean, // true if this is actually a request to send a message
                "isQuestionRequest": boolean // true if this is actually a request to find unanswered questions
            }`,
            modelClass: ModelClass.SMALL
        });

        console.log('[MENTION] AI Analysis response:', analysis);

        const result = extractJsonFromResponse(analysis);
        if (!result) {
            console.error('[MENTION] Failed to extract valid JSON from analysis');
            return false;
        }

        console.log('[MENTION] Analysis result:', JSON.stringify(result, null, 2));

        if (result.isSummaryRequest || result.isSendRequest || result.isQuestionRequest) {
            console.log('[MENTION] Request type mismatch - rejecting');
            return false;
        }

        console.log('[MENTION] Validation successful:', result.hasIntent);
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
        console.log('[MENTION] Starting handler execution');
        const ctx = options.ctx as Context<Update>;

        console.log('[MENTION] Fetching recent messages for context');
        const recentMessages = await runtime.messageManager.getMemories({
            roomId: message.roomId,
            count: 5
        });

        console.log('[MENTION] Fetching user groups from Redis');
        const [groupIds, groupInfos] = await getGroupsByUserId(ctx.from.id.toString());
        console.log('[MENTION] Found groups:', groupInfos.map(g => g.title).join(', '));

        console.log('[MENTION] Analyzing message for specific action');
        const analysis = await generateText({
            runtime,
            context: `You are a JSON-only response bot. Your task is to analyze a message in the context of finding mentions.
            
            Recent conversation:
            ${recentMessages.map(m => m.content.text).join('\n')}
            
            Current message: ${message.content.text}
            Available groups: ${groupInfos.map(g => g.title).join(', ')}
            
            Return ONLY a JSON object with the following structure, no other text:
            {
                "intent": string, // MUST be one of: "find_specific" (for a specific group), "find_all" (for all groups), "cancel"
                "targetGroup": string, // name of the group to check (if specified)
                "isAllGroups": boolean, // true if user wants to check all groups
                "response": string // the exact message the bot should respond with
            }

            Rules for intent detection:
            1. If the message contains "all" or "every" or "any" group, set intent to "find_all"
            2. If the message specifies a group name, set intent to "find_specific"
            3. If the message contains "cancel" or "stop", set intent to "cancel"
            4. For "find_all", set isAllGroups to true and targetGroup to null
            5. For "find_specific", set isAllGroups to false and targetGroup to the group name
            6. For "cancel", set both isAllGroups to false and targetGroup to null

            Rules for response generation:
            1. For "find_all": "I'll check all your groups for mentions."
            2. For "find_specific": "I'll check groupA for mentions."
            3. For "cancel": "Mention search cancelled."
            4. If targetGroup is not found: "I couldn't find the group "groupA". Here are the groups you have access to: [list groups]"

            Additional guidelines:
            - Consider the recent conversation context when determining intent
            - If the user has been discussing a specific group, prioritize that group
            - If the user has been asking about mentions repeatedly, provide more detailed responses
            - If the user has been canceling frequently, be more explicit about the cancelation
            `,
            modelClass: ModelClass.SMALL
        });

        console.log('[MENTION] Handler analysis response:', analysis);

        const result = extractJsonFromResponse(analysis);
        if (!result) {
            console.error('[MENTION] Failed to extract valid JSON from handler analysis');
            await callback({
                text: "I'm having trouble understanding your request. Could you please rephrase?",
                action: "MENTION"
            });
            return;
        }

        console.log('[MENTION] Processing intent:', result.intent);

        const targetGroup = groupInfos.find(group =>
            group.title?.toLowerCase() === result.targetGroup?.toLowerCase()
        );

        switch (result.intent) {
            case 'find_specific':
                console.log('[MENTION] Processing find_specific intent for group:', result.targetGroup);
                if (!targetGroup) {
                    console.log('[MENTION] Target group not found:', result.targetGroup);
                    await callback({
                        text: result.response || `I couldn't find the group "${result.targetGroup}". Here are the groups you have access to:\n${groupInfos.map(g => g.title).join('\n')}`,
                        action: "MENTION"
                    });
                    return;
                }

                console.log('[MENTION] Fetching messages for group:', targetGroup.title);
                // Get message IDs from sorted set
                const messageIds = await redis.zrevrange(`group:${targetGroup.id}:messages`, 0, -1);
                console.log('[MENTION] Found message IDs:', messageIds);

                // Get message contents from hashes
                const messages = [];
                for (const messageId of messageIds) {
                    const messageData = await redis.hgetall(`group:${targetGroup.id}:message:${messageId}`);
                    if (messageData) {
                        messages.push(messageData);
                    }
                }

                const mentions = messages.filter(msg =>
                    msg.text && msg.text.includes(`@${ctx.from.username}`)
                );

                console.log('[MENTION] Found mentions:', mentions.length);

                if (mentions.length === 0) {
                    console.log('[MENTION] No mentions found');
                    await callback({
                        text: `No mentions found in ${targetGroup.title}.`,
                        action: "MENTION"
                    });
                    return;
                }

                const mentionsText = mentions.map((m, index) =>
                    `${index + 1}. Message: "${m.text}"\n   From: ${m.username || 'Unknown'}\n   Posted: ${new Date(m.date).toLocaleString()}\n`
                ).join('\n');

                console.log('[MENTION] Generated response text for', mentions.length, 'mentions');

                // Remove mentioned messages from Redis
                for (const mention of mentions) {
                    console.log('[MENTION] Removing mention from Redis:', JSON.stringify(mention));
                    
                    // Remove from sorted set
                    await redis.zrem(`group:${targetGroup.id}:messages`, mention.id);
                    
                    // Remove from hash
                    await redis.del(`group:${targetGroup.id}:message:${mention.id}`);
                    
                    console.log('[MENTION] Removed mention with ID:', mention.id);
                }

                await callback({
                    text: `📋 *Mentions in ${targetGroup.title}*\n\n${mentionsText}\n\nTotal: ${mentions.length} mention${mentions.length === 1 ? '' : 's'}\n\nThese mentions have been removed from the list.`,
                    action: "MENTION"
                });
                break;

            case 'find_all':
                console.log('[MENTION] Processing find_all intent');
                const allResponses = await getUserGroupMessages(ctx.message.from.id);
                console.log('[MENTION] Fetched messages from', Object.keys(allResponses).length, 'groups');

                const allMentions = [];
                const mentionsToRemove = [];

                for (const [groupId, groupData] of Object.entries(allResponses)) {
                    const mentions = (groupData as any).message.filter(msg =>
                        msg.text && msg.text.includes(`@${ctx.from.username}`)
                    );

                    if (mentions.length > 0) {
                        console.log('[MENTION] Found', mentions.length, 'mentions in group:', (groupData as any).groupInfo.title);
                        allMentions.push({
                            group: (groupData as any).groupInfo.title,
                            mentions: mentions.map((m, index) =>
                                `${index + 1}. Message: "${m.text}"\n   From: ${m.username || 'Unknown'}\n   Posted: ${new Date(m.date).toLocaleString()}\n`
                            ).join('\n')
                        });
                        // Store mentions for removal
                        mentionsToRemove.push(...mentions.map(m => ({ groupId, message: m })));
                    }
                }

                if (allMentions.length === 0) {
                    console.log('[MENTION] No mentions found in any group');
                    await callback({
                        text: "✅ No mentions found in any of your groups.",
                        action: "MENTION"
                    });
                    return;
                }

                const allMentionsText = allMentions.map(g =>
                    `📌 *${g.group}*\n${g.mentions}\n`
                ).join('\n');

                const totalMentions = allMentions.reduce((sum, group) => 
                    sum + group.mentions.split('\n').filter(line => line.includes('Message:')).length, 0);

                console.log('[MENTION] Generated response for', totalMentions, 'mentions across', allMentions.length, 'groups');

                // Remove all mentioned messages from Redis
                for (const { groupId, message } of mentionsToRemove) {
                    console.log('[MENTION] Removing mention from Redis:', JSON.stringify(message));
                    
                    // Remove from sorted set
                    await redis.zrem(`group:${groupId}:messages`, message.id);
                    
                    // Remove from hash
                    await redis.del(`group:${groupId}:message:${message.id}`);
                    
                    console.log('[MENTION] Removed mention with ID:', message.id);
                }

                await callback({
                    text: `📋 *All Mentions Summary*\n\n${allMentionsText}\n\nTotal: ${totalMentions} mention${totalMentions === 1 ? '' : 's'} across ${allMentions.length} group${allMentions.length === 1 ? '' : 's'}\n\nThese mentions have been removed from the list.`,
                    action: "MENTION"
                });
                break;

            case 'cancel':
                console.log('[MENTION] Processing cancel intent');
                await callback({
                    text: result.response || "Mention search cancelled. Let me know if you'd like to try again.",
                    action: "MENTION"
                });
                break;

            default:
                console.log('[MENTION] Unknown intent:', result.intent);
                await callback({
                    text: result.response || "I'm not sure what you'd like to do. Please specify a group or say 'all' to check all groups.",
                    action: "MENTION"
                });
        }
        console.log('[MENTION] Handler execution completed');
    },
    examples: [],
} as Action

