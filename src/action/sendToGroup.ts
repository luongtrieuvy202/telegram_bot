import {
    Action,
    IAgentRuntime,
    Memory,
    State,
    HandlerCallback,
    ModelClass,
} from "@elizaos/core";
import {Context, Telegraf} from "telegraf";
import {Update} from "telegraf/types";
import {getGroupsByUserId} from "./utils.ts";
import redis from "../redis/redis.ts";
import {generateText} from "@elizaos/core";

// Helper functions for conversation state management
interface ConversationState {
    stage: 'initial' | 'group_selection' | 'message_collection' | 'confirmation';
    targetGroup?: {
        id: string;
        title: string;
    };
    messageContent?: string;
}

async function setConversationState(runtime: IAgentRuntime, roomId: string, state: ConversationState) {
    await runtime.cacheManager.set(`send_to_group:${roomId}`, JSON.stringify(state));
}

async function getConversationState(runtime: IAgentRuntime, roomId: string): Promise<ConversationState | null> {
    const state = await runtime.cacheManager.get(`send_to_group:${roomId}`);
    if (!state) return null;
    try {
        return JSON.parse(state as string) as ConversationState;
    } catch (error) {
        console.error('Failed to parse conversation state:', error);
        return null;
    }
}

async function clearConversationState(runtime: IAgentRuntime, roomId: string) {
    await runtime.cacheManager.delete(`send_to_group:${roomId}`);
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

export const sendToGroupAction: Action = {
    name: 'SEND_TO_GROUP',
    similes: ['send', 'message', 'post'],
    description: "Send a message to a specific group",
    validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        if (!state?.handle) return false;


        // Get recent messages for context
        const recentMessages = await runtime.messageManager.getMemories({
            roomId: message.roomId,
            count: 4
        });

        // Create context for AI analysis
        const context = {
            recentMessages: recentMessages.map(m => m.content.text).join('\n'),
            currentMessage: message.content.text,
            currentState: state
        };

        // Use AI to analyze the intent and state
        const analysis = await generateText({
            runtime,
            context: `You are a JSON-only response bot. Your task is to analyze if a message indicates an intent to send a message to a group or is a confirmation of sending.
            Recent messages: ${context.recentMessages}
            Current message: ${context.currentMessage}
            
            Return ONLY a JSON object with the following structure, no other text:
            {
                "hasIntent": boolean,
                "isConfirmation": boolean,
                "currentStage": string,
                "confidence": number
            }`,
            modelClass: ModelClass.SMALL
        });

        console.log('Analysis response:', analysis);

        const result = extractJsonFromResponse(analysis);
        if (!result) {
            console.error('Failed to extract valid JSON from analysis');
            return false;
        }

        return result.hasIntent || result.isConfirmation;
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

        // Get conversation state
        const conversationState = await getConversationState(runtime, message.roomId);

        console.log('[SEND_TO_GROUP] Fetching recent messages for context');
        const recentMessages = await runtime.messageManager.getMemories({
            roomId: message.roomId,
            count: 5
        });

        console.log('[SEND_TO_GROUP] Fetching user groups from Redis');
        const [groupIds, groupInfos] = await getGroupsByUserId(ctx.from.id.toString());
        console.log('[SEND_TO_GROUP] Found groups:', groupInfos.map(g => g.title).join(', '));

        console.log('[SEND_TO_GROUP] Analyzing message for specific action');
        const analysis = await generateText({
            runtime,
            context: `You are a JSON-only response bot. Your task is to analyze a message in the context of sending a message to a group.
            
            Recent conversation:
            ${recentMessages.map(m => m.content.text).join('\n')}
            
            Current message: ${message.content.text}
            Available groups: ${groupInfos.map(g => g.title).join(', ')}
            
            IMPORTANT: A confirmation is ONLY when the user explicitly agrees to send a message that has already been specified.
            For example:
            - If user says "yes" or "send it" after being shown a message to send -> isConfirmation = true
            - If user provides a new message or group -> isConfirmation = false
            - If user starts a new request -> isConfirmation = false
            
            Return ONLY a JSON object with the following structure, no other text:
            {
                "intent": string, // "send_message", "select_group", "provide_message", "confirm", "cancel"
                "extractedGroup": string, // group name (not ID), must match one of the available groups
                "extractedMessage": string, // message content if provided
                "isConfirmation": boolean, // ONLY true if user explicitly confirms sending an already specified message
                "nextAction": string, // what the bot should do next
                "response": string // the exact message the bot should respond with
            }

            Additional guidelines:
            - Consider the recent conversation context when determining intent
            - If the user has been discussing a specific group, prioritize that group
            - If the user has been providing a message, look for it in the conversation
            - If the user has been canceling frequently, be more explicit about the cancelation
            - If the user has been confirming frequently, be more explicit about the confirmation
            - If the user has been providing multiple messages, use the most recent one
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

        console.log('Handler analysis response:', analysis);

        const result = extractJsonFromResponse(analysis);
        if (!result) {
            console.error('Failed to extract valid JSON from handler analysis');
            await callback({
                text: "I'm having trouble understanding your request. Could you please rephrase?",
                action: "SEND_TO_GROUP"
            });
            return;
        }

        // Find the target group by name (not ID)
        const targetGroup = groupInfos.find(group =>
            group.title?.toLowerCase() === result.extractedGroup?.toLowerCase()
        );

        // If this is a confirmation and we have a message to send, send it
        if (result.isConfirmation) {
            // Additional validation to ensure this is really a confirmation
            if (!conversationState?.messageContent || !conversationState?.targetGroup) {
                console.log('Invalid confirmation state:', conversationState);
                await callback({
                    text: "I don't have a message to send. What would you like to send?",
                    action: "SEND_TO_GROUP"
                });
                return;
            }

            // Check if the message contains confirmation words
            const confirmationWords = ['yes', 'send', 'okay', 'ok', 'go ahead', 'proceed', 'confirm'];
            const isExplicitConfirmation = confirmationWords.some(word =>
                message.content.text.toLowerCase().includes(word)
            );

            if (!isExplicitConfirmation) {
                console.log('Not an explicit confirmation:', message.content.text);
                await callback({
                    text: "I need an explicit confirmation to send the message. Please say 'yes' or 'send it' to proceed.",
                    action: "SEND_TO_GROUP"
                });
                return;
            }

            try {
                await bot.telegram.sendMessage(
                    conversationState.targetGroup.id,
                    conversationState.messageContent
                );

                // Log the message in Redis
                const messageId = Date.now().toString();
                await redis.multi()
                    .hset(`group:${conversationState.targetGroup.id}:message:${messageId}`, {
                        id: messageId,
                        from: ctx.from.id.toString(),
                        text: conversationState.messageContent,
                        date: Date.now().toString(),
                        username: ctx.from.username || ctx.from.first_name
                    })
                    .zadd(`group:${conversationState.targetGroup.id}:messages`, Date.now(), messageId)
                    .exec();

                await callback({
                    text: result.response || `Message sent successfully to ${conversationState.targetGroup.title}!`,
                    action: "SEND_TO_GROUP"
                });

                await clearConversationState(runtime, message.roomId);
                return;
            } catch (error) {
                await callback({
                    text: `Failed to send message: ${error.message}`,
                    action: "SEND_TO_GROUP"
                });
                return;
            }
        }

        switch (result.intent) {
            case 'send_message':
                if (!targetGroup) {
                    await callback({
                        text: result.response || `I couldn't find the group "${result.extractedGroup}". Here are the groups you have access to:\n${groupInfos.map(g => g.title).join('\n')}`,
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
                            text: result.response || `Group "${targetGroup.title}" is not authorized.`,
                            action: "SEND_TO_GROUP"
                        });
                        return;
                    }
                }

                // If message is already provided, go straight to confirmation
                if (result.extractedMessage) {
                    await setConversationState(runtime, message.roomId, {
                        stage: 'confirmation',
                        targetGroup: {
                            id: targetGroup.id,
                            title: targetGroup.title || ''
                        },
                        messageContent: result.extractedMessage
                    });

                    await callback({
                        text: result.response || `I'll help you send this message to ${targetGroup.title}:\n\n"${result.extractedMessage}"\n\nWould you like me to proceed with sending this message?`,
                        action: "SEND_TO_GROUP"
                    });
                    return;
                }

                // If no message provided, ask for it
                await setConversationState(runtime, message.roomId, {
                    stage: 'message_collection',
                    targetGroup: {
                        id: targetGroup.id,
                        title: targetGroup.title || ''
                    }
                });

                await callback({
                    text: result.response || `I'll help you send a message to ${targetGroup.title}. What message would you like to send?`,
                    action: "SEND_TO_GROUP"
                });
                break;

            case 'provide_message':
                if (!conversationState?.targetGroup) {
                    await callback({
                        text: result.response || "Please specify which group you want to send the message to first.",
                        action: "SEND_TO_GROUP"
                    });
                    return;
                }

                await setConversationState(runtime, message.roomId, {
                    ...conversationState,
                    stage: 'confirmation',
                    messageContent: result.extractedMessage || message.content.text
                });

                await callback({
                    text: result.response || `I'll help you send this message to ${conversationState.targetGroup.title}:\n\n"${result.extractedMessage || message.content.text}"\n\nWould you like me to proceed with sending this message?`,
                    action: "SEND_TO_GROUP"
                });
                break;

            case 'cancel':
                await clearConversationState(runtime, message.roomId);
                await callback({
                    text: result.response || "Message sending cancelled. Let me know if you'd like to try again.",
                    action: "SEND_TO_GROUP"
                });
                break;

            default:
                await callback({
                    text: result.response || "I'm not sure what you'd like to do. Could you please clarify?",
                    action: "SEND_TO_GROUP"
                });
        }
    },
    examples: []
} as Action; 