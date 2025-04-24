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
            
            Return ONLY a JSON object with the following structure, no other text:
            {
                "intent": string, // "send_message", "select_group", "provide_message", "confirm", "cancel", "edit_message", "change_group"
                "extractedGroup": string, // group name (not ID), must match one of the available groups
                "extractedMessage": string, // message content if provided
                "isConfirmation": boolean, // true if user explicitly confirms sending
                "isEdit": boolean, // true if user wants to edit the message
                "isGroupChange": boolean, // true if user wants to change the group
                "response": string // the exact message the bot should respond with
            }

            Rules for intent detection:
            1. "send_message": When user provides both group and message
            2. "select_group": When user only specifies a group
            3. "provide_message": When user only provides message content
            4. "confirm": When user explicitly agrees to send (yes, send, ok, etc.)
            5. "cancel": When user wants to stop the process
            6. "edit_message": When user wants to modify the message
            7. "change_group": When user wants to change the target group

            Rules for group extraction:
            1. Match exact group names
            2. Match partial group names if unique
            3. If multiple matches, ask for clarification
            4. If no match, list available groups

            Rules for message extraction:
            1. Use the most recent message if multiple provided
            2. If message is edited, use the edited version
            3. If message is unclear, ask for clarification

            Rules for confirmation:
            1. Must be explicit (yes, send, ok, etc.)
            2. Must match the current message and group
            3. If message/group changed, treat as new request

            Additional guidelines:
            - Consider the recent conversation context
            - Handle partial information gracefully
            - Provide clear next steps
            - Confirm understanding before sending
            - Allow easy cancellation
            - Support message editing
            - Support group changing
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

        console.log('[SEND_TO_GROUP] Processing intent:', result.intent);

        // Declare variables at the top of the switch
        let targetGroup;
        let messageContent;

        switch (result.intent) {
            case 'send_message':
                // Handle case where user provides both group and message
                if (result.extractedGroup) {
                    const foundGroup = groupInfos.find(group =>
                        group.title?.toLowerCase() === result.extractedGroup?.toLowerCase()
                    );
                    if (foundGroup) {
                        targetGroup = {
                            id: foundGroup.id || '',
                            title: foundGroup.title || ''
                        };
                    }
                }

                if (!targetGroup) {
                    await callback({
                        text: result.response || "Please specify which group you want to send the message to.",
                        action: "SEND_TO_GROUP"
                    });
                    return;
                }

                messageContent = result.extractedMessage || message.content.text;
                if (!messageContent) {
                    await callback({
                        text: result.response || "Please provide the message you want to send.",
                        action: "SEND_TO_GROUP"
                    });
                    return;
                }

                // Store state and ask for confirmation
                await setConversationState(runtime, message.roomId, {
                    stage: 'confirmation',
                    targetGroup,
                    messageContent
                });

                await callback({
                    text: result.response || `I'll help you send this message to ${targetGroup.title}:\n\n"${messageContent}"\n\nWould you like me to proceed with sending this message?`,
                    action: "SEND_TO_GROUP"
                });
                break;

            case 'select_group':
                if (!result.extractedGroup) {
                    await callback({
                        text: result.response || "Please specify which group you want to send the message to.",
                        action: "SEND_TO_GROUP"
                    });
                    return;
                }

                const foundGroup = groupInfos.find(group =>
                    group.title?.toLowerCase() === result.extractedGroup?.toLowerCase()
                );
                if (foundGroup) {
                    targetGroup = {
                        id: foundGroup.id || '',
                        title: foundGroup.title || ''
                    };
                }

                if (!targetGroup) {
                    await callback({
                        text: result.response || `I couldn't find the group "${result.extractedGroup}". Here are the groups you have access to:\n${groupInfos.map(g => g.title).join('\n')}`,
                        action: "SEND_TO_GROUP"
                    });
                    return;
                }

                // If no message provided, ask for it
                await setConversationState(runtime, message.roomId, {
                    stage: 'message_collection',
                    targetGroup
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

                messageContent = result.extractedMessage || message.content.text;
                await setConversationState(runtime, message.roomId, {
                    ...conversationState,
                    stage: 'confirmation',
                    messageContent
                });

                await callback({
                    text: result.response || `I'll help you send this message to ${conversationState.targetGroup.title}:\n\n"${messageContent}"\n\nWould you like me to proceed with sending this message?`,
                    action: "SEND_TO_GROUP"
                });
                break;

            case 'edit_message':
                if (!conversationState?.targetGroup) {
                    await callback({
                        text: result.response || "Please specify which group you want to send the message to first.",
                        action: "SEND_TO_GROUP"
                    });
                    return;
                }

                messageContent = result.extractedMessage || message.content.text;
                await setConversationState(runtime, message.roomId, {
                    ...conversationState,
                    stage: 'confirmation',
                    messageContent
                });

                await callback({
                    text: result.response || `I've updated the message. Here's what will be sent to ${conversationState.targetGroup.title}:\n\n"${messageContent}"\n\nWould you like me to proceed with sending this message?`,
                    action: "SEND_TO_GROUP"
                });
                break;

            case 'change_group':
                if (!result.extractedGroup) {
                    await callback({
                        text: result.response || "Please specify which group you want to send the message to.",
                        action: "SEND_TO_GROUP"
                    });
                    return;
                }

                const newGroup = groupInfos.find(group =>
                    group.title?.toLowerCase() === result.extractedGroup?.toLowerCase()
                );
                if (newGroup) {
                    targetGroup = {
                        id: newGroup.id || '',
                        title: newGroup.title || ''
                    };
                }

                if (!targetGroup) {
                    await callback({
                        text: result.response || `I couldn't find the group "${result.extractedGroup}". Here are the groups you have access to:\n${groupInfos.map(g => g.title).join('\n')}`,
                        action: "SEND_TO_GROUP"
                    });
                    return;
                }

                if (!conversationState?.messageContent) {
                    await callback({
                        text: result.response || "Please provide the message you want to send.",
                        action: "SEND_TO_GROUP"
                    });
                    return;
                }

                await setConversationState(runtime, message.roomId, {
                    ...conversationState,
                    stage: 'confirmation',
                    targetGroup
                });

                await callback({
                    text: result.response || `I'll help you send this message to ${targetGroup.title}:\n\n"${conversationState.messageContent}"\n\nWould you like me to proceed with sending this message?`,
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

            case 'confirm':
                // Try to get message and group from conversation state first
                let messageToSend = conversationState?.messageContent;
                let groupToSend = conversationState?.targetGroup;

                // If conversation state is invalid, try to get data from AI response
                if (!messageToSend || !groupToSend) {
                    console.log('Invalid conversation state, trying to use AI response data');
                    
                    // Try to find the group from AI response
                    if (result.extractedGroup) {
                        const foundGroup = groupInfos.find(group =>
                            group.title?.toLowerCase() === result.extractedGroup?.toLowerCase()
                        );
                        if (foundGroup) {
                            groupToSend = {
                                id: foundGroup.id || '',
                                title: foundGroup.title || ''
                            };
                        }
                    }

                    // Use message from AI response or current message
                    messageToSend = result.extractedMessage || message.content.text;

                    // If we still don't have both required pieces, return error
                    if (!messageToSend || !groupToSend) {
                        console.log('Missing required data for sending message');
                        await callback({
                            text: result.response || "I need both a group and a message to send. Please specify them.",
                            action: "SEND_TO_GROUP"
                        });
                        return;
                    }
                }

                try {
                    await bot.telegram.sendMessage(
                        groupToSend.id,
                        messageToSend
                    );

                    // Log the message in Redis
                    const messageId = Date.now().toString();
                    await redis.multi()
                        .hset(`group:${groupToSend.id}:message:${messageId}`, {
                            id: messageId,
                            from: ctx.from.id.toString(),
                            text: messageToSend,
                            date: Date.now().toString(),
                            username: ctx.from.username || ctx.from.first_name
                        })
                        .zadd(`group:${groupToSend.id}:messages`, Date.now(), messageId)
                        .exec();

                    await callback({
                        text: result.response || `Message sent successfully to ${groupToSend.title}!`,
                        action: "SEND_TO_GROUP"
                    });

                    await clearConversationState(runtime, message.roomId);
                } catch (error) {
                    console.error('Error sending message:', error);
                    await callback({
                        text: result.response || `Failed to send message: ${error.message}`,
                        action: "SEND_TO_GROUP"
                    });
                }
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