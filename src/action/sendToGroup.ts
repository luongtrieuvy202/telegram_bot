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
import { SendToGroupState, GroupInfo, createMemory } from "./types.ts";
import { callOpenRouterText } from './utils.ts';

// State Management
async function getSendToGroupState(runtime: IAgentRuntime, roomId: string): Promise<SendToGroupState | null> {
    const state = await runtime.cacheManager.get(`send_to_group:${roomId}`);
    if (!state) return null;
    try {
        return JSON.parse(state as string) as SendToGroupState;
    } catch (error) {
        console.error('Failed to parse send to group state:', error);
        return null;
    }
}

async function setSendToGroupState(runtime: IAgentRuntime, roomId: string, state: SendToGroupState) {
    await runtime.cacheManager.set(`send_to_group:${roomId}`, JSON.stringify(state));
}

async function clearSendToGroupState(runtime: IAgentRuntime, roomId: string) {
    await runtime.cacheManager.delete(`send_to_group:${roomId}`);
}

// Helper Functions
function isConfirmationMessage(text: string): boolean {
    const lowerText = text.toLowerCase();
    return lowerText.includes('yes') || 
           lowerText.includes('confirm') || 
           lowerText.includes('send');
}

function isCancellationMessage(text: string): boolean {
    const lowerText = text.toLowerCase();
    return lowerText.includes('no') || 
           lowerText.includes('cancel') || 
           lowerText.includes('stop');
}


async function sendMessageToGroup(
    bot: Telegraf,
    ctx: Context<Update>,
    targetGroup: GroupInfo,
    messageContent: string
): Promise<void> {
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
}

async function sendMessageToAllGroups(
    bot: Telegraf,
    ctx: Context<Update>,
    groups: GroupInfo[],
    messageContent: string
): Promise<{ success: GroupInfo[]; failed: GroupInfo[] }> {
    const results = { success: [] as GroupInfo[], failed: [] as GroupInfo[] };

    for (const group of groups) {
        try {
            await sendMessageToGroup(bot, ctx, group, messageContent);
            results.success.push(group);
        } catch (error) {
            console.error(`Failed to send message to ${group.title}:`, error);
            results.failed.push(group);
        }
    }

    return results;
}

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

// Response Handlers
async function handleGroupNotFound(
    runtime: IAgentRuntime,
    message: Memory,
    callback: HandlerCallback,
    groupName: string,
    availableGroups: GroupInfo[]
): Promise<void> {
    const response = {
        text: `I couldn't find the group "${groupName}". Here are the groups you have access to:\n${availableGroups.map(g => g.title).join('\n')}`,
        action: "SEND_TO_GROUP"
    };
    await callback(response);
    await createMemory(runtime, message, response, true);
}

async function handleConfirmation(
    runtime: IAgentRuntime,
    message: Memory,
    callback: HandlerCallback,
    targetGroup: GroupInfo,
    messageContent: string
): Promise<void> {
    const response = {
        text: `I'll send this message to ${targetGroup.title}:\n\n"${messageContent}"\n\nPlease confirm by typing 'yes' or 'confirm' to send this message, or 'no' to cancel.`,
        action: "SEND_TO_GROUP"
    };
    await callback(response);
    await createMemory(runtime, message, response, true);
}

async function handleSuccess(
    runtime: IAgentRuntime,
    message: Memory,
    callback: HandlerCallback,
    targetGroup: GroupInfo
): Promise<void> {
    const response = {
        text: `Message sent successfully to ${targetGroup.title}!`,
        action: "SEND_TO_GROUP"
    };
    await callback(response);
    await createMemory(runtime, message, response, true);
}

async function handleError(
    runtime: IAgentRuntime,
    message: Memory,
    callback: HandlerCallback,
    error: Error
): Promise<void> {
    const response = {
        text: `Failed to send message: ${error.message}`,
        action: "SEND_TO_GROUP"
    };
    await callback(response);
    await createMemory(runtime, message, response, true);
}

async function handleCancellation(
    runtime: IAgentRuntime,
    message: Memory,
    callback: HandlerCallback
): Promise<void> {
    const response = {
        text: "Message sending cancelled. Let me know if you'd like to try again.",
        action: "SEND_TO_GROUP"
    };
    await callback(response);
    await createMemory(runtime, message, response, true);
}

// Main Action
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
        const sendToGroupState = await getSendToGroupState(runtime, message.roomId);

        // Get recent messages and available groups
        const recentMessages = await runtime.messageManager.getMemories({
            roomId: message.roomId,
            count: 10
        });

        const [groupIds, groupInfos] = await getGroupsByUserId(ctx.from.id.toString());
        const typedGroupInfos: GroupInfo[] = groupInfos.map(group => ({
            id: group.id,
            title: group.title
        }));

        console.log(sendToGroupState);

        // Handle confirmation stage
        if (sendToGroupState?.stage === 'confirmation' && sendToGroupState.messageDetails) {
            if (isConfirmationMessage(message.content.text)) {
                if (sendToGroupState.messageDetails.targetGroup === 'all') {
                    try {
                        const results = await sendMessageToAllGroups(bot, ctx, typedGroupInfos, sendToGroupState.messageDetails.messageContent);
                        
                        let responseText = `Message sent successfully to ${results.success.length} group${results.success.length === 1 ? '' : 's'}!`;
                        
                        if (results.failed.length > 0) {
                            responseText += `\n\nFailed to send to ${results.failed.length} group${results.failed.length === 1 ? '' : 's'}:`;
                            results.failed.forEach(group => {
                                responseText += `\n• ${group.title}`;
                            });
                        }
                        
                        const response = {
                            text: responseText,
                            action: "SEND_TO_GROUP"
                        };
                        await callback(response);
                        await createMemory(runtime, message, response, true);
                    } catch (error) {
                        await handleError(runtime, message, callback, error);
                    }
                } else {
                    const targetGroup = typedGroupInfos.find(group =>
                        group.title?.toLowerCase() === sendToGroupState.messageDetails.targetGroup?.toLowerCase()
                    );

                    if (!targetGroup) {
                        await handleGroupNotFound(runtime, message, callback, sendToGroupState.messageDetails.targetGroup, typedGroupInfos);
                        await clearSendToGroupState(runtime, message.roomId);
                        return;
                    }

                    try {
                        await sendMessageToGroup(bot, ctx, targetGroup, sendToGroupState.messageDetails.messageContent);
                        await handleSuccess(runtime, message, callback, targetGroup);
                    } catch (error) {
                        await handleError(runtime, message, callback, error);
                    }
                }
                await clearSendToGroupState(runtime, message.roomId);
                return;
            } else if (isCancellationMessage(message.content.text)) {
                await handleCancellation(runtime, message, callback);
                await clearSendToGroupState(runtime, message.roomId);
                return;
            }
        }

        // Handle editing stage
        if (sendToGroupState?.stage === 'editing') {
            const editedMessage = message.content.text;
            if (!editedMessage) {
                const response = {
                    text: "Please provide the edited message.",
                    action: "SEND_TO_GROUP"
                };
                await callback(response);
                await createMemory(runtime, message, response, true);
                return;
            }

            await setSendToGroupState(runtime, message.roomId, {
                stage: 'confirmation',
                messageDetails: {
                    targetGroup: sendToGroupState.messageDetails.targetGroup,
                    messageContent: editedMessage,
                    previousMessage: sendToGroupState.messageDetails.messageContent
                }
            });

            await handleConfirmation(
                runtime,
                message,
                callback,
                { id: '', title: sendToGroupState.messageDetails.targetGroup },
                editedMessage
            );
            return;
        }

        // Analyze message intent
        const prompt = `
        You are a JSON-only response bot. Your task is to help users send messages to groups in a step-by-step way, handling group selection, message content, edits, and cancellations.
        
        ### Context:
        Recent conversation:
        ${recentMessages.map(m => m.content.text).join('\n')}
        
        Current message:
        ${message.content.text}
        
        Available groups:
        ${typedGroupInfos.map(g => g.title).join(', ')}
        
        ### Behavior Rules:
        - You MUST follow a step-by-step approach: first determine the target group, then collect the message content, and finally allow editing or confirmation.
        - If the group is specified but message content is missing, respond with intent: "provide_message" and prompt the user for the message.
        - If both group and message are provided, return intent: "send_message".
        - If the user wants to change the group after selecting one, set intent: "change_group".
        - If the user wants to edit a previously provided message, use intent: "edit_message".
        - If the user wants to cancel the operation, use intent: "cancel".
        - If only the group is mentioned, extractedMessage should be null.
        - If only a message is mentioned, extractedGroup should be null unless it's clearly directed at a group.
        
        ### Output Format:
        Return ONLY a valid JSON object in this exact structure (no extra text):
        
        {
          "intent": "send_message" | "select_group" | "provide_message" | "edit_message" | "change_group" | "cancel",
          "extractedGroup": string | null, // Must match an available group title or be "all" if specified
          "extractedMessage": string | null, // Only include if the user clearly provided it
          "isEdit": boolean, // True if editing a previously provided message
          "isGroupChange": boolean, // True if user is switching to a different group
          "response": string // Human-readable message the bot should reply with
        }
        
        ### Validation & Constraints:
        - Do NOT hallucinate missing information.
        - If the message is incomplete, ask for what's missing instead of making assumptions.
        - Always return null for extractedGroup or extractedMessage if that information isn't clearly provided.
        - Respond with intent: "provide_message" and a helpful prompt if group is known but message content is not.
        - Respond with intent: "select_group" if no valid group is mentioned.
        - Ensure JSON is strictly valid: no extra commas, text, or markdown.
        
        `;

        const analysis = await callOpenRouterText({
            prompt,
            model: 'google/gemini-2.0-flash-001'
        });

        createMemory(runtime, message, {
            text: message.content.text,
            action: "SEND_TO_GROUP"
        }, false);

        const result = extractJsonFromResponse(analysis);
        if (!result) {
            const response = {
                text: "I'm having trouble understanding your request. Could you please rephrase?",
                action: "SEND_TO_GROUP"
            };
            await callback(response);
            await createMemory(runtime, message, response, true);
            return;
        }

        // Clear existing state if this is a new message
        if (result.intent === 'send_message' || result.intent === 'select_group') {
            await clearSendToGroupState(runtime, message.roomId);
        }

        const targetGroup = typedGroupInfos.find(group =>
            group.title?.toLowerCase() === result.extractedGroup?.toLowerCase()
        );

        switch (result.intent) {
            case 'send_message':
                if (result.extractedGroup?.toLowerCase() === 'all') {
                    if (!result.extractedMessage) {
                        const response = {
                            text: result.response || "Please provide the message you want to send to all groups.",
                            action: "SEND_TO_GROUP"
                        };
                        await callback(response);
                        await createMemory(runtime, message, response, true);
                        return;
                    }

                    await setSendToGroupState(runtime, message.roomId, {
                        stage: 'confirmation',
                        messageDetails: {
                            targetGroup: 'all',
                            messageContent: result.extractedMessage
                        }
                    });

                    const allGroupsResponse = {
                        text: `I'll send this message to all your groups:\n\n"${result.extractedMessage}"\n\nPlease confirm by typing 'yes' or 'confirm' to send this message, or 'no' to cancel.`,
                        action: "SEND_TO_GROUP"
                    };
                    await callback(allGroupsResponse);
                    await createMemory(runtime, message, allGroupsResponse, true);
                    break;
                }

                if (!targetGroup) {
                    await handleGroupNotFound(runtime, message, callback, result.extractedGroup, typedGroupInfos);
                    return;
                }

                if (!result.extractedMessage) {
                    const response = {
                        text: result.response || "Please provide the message you want to send.",
                        action: "SEND_TO_GROUP"
                    };
                    await callback(response);
                    await createMemory(runtime, message, response, true);
                    return;
                }

                await setSendToGroupState(runtime, message.roomId, {
                    stage: 'confirmation',
                    messageDetails: {
                        targetGroup: targetGroup.title,
                        messageContent: result.extractedMessage
                    }
                });

                await handleConfirmation(runtime, message, callback, targetGroup, result.extractedMessage);
                break;

            case 'select_group':
                if (!targetGroup) {
                    await handleGroupNotFound(runtime, message, callback, result.extractedGroup, typedGroupInfos);
                    return;
                }

                await setSendToGroupState(runtime, message.roomId, {
                    stage: 'message_collection',
                    messageDetails: {
                        targetGroup: targetGroup.title,
                        messageContent: ''
                    }
                });

                const selectGroupResponse = {
                    text: result.response || `I'll help you send a message to ${targetGroup.title}. What message would you like to send?`,
                    action: "SEND_TO_GROUP"
                };
                await callback(selectGroupResponse);
                await createMemory(runtime, message, selectGroupResponse, true);
                break;

            case 'edit_message':
                if (!sendToGroupState?.messageDetails?.targetGroup) {
                    const response = {
                        text: result.response || "Please specify which group you want to send the message to first.",
                        action: "SEND_TO_GROUP"
                    };
                    await callback(response);
                    await createMemory(runtime, message, response, true);
                    return;
                }

                await setSendToGroupState(runtime, message.roomId, {
                    stage: 'editing',
                    messageDetails: {
                        targetGroup: sendToGroupState.messageDetails.targetGroup,
                        messageContent: sendToGroupState.messageDetails.messageContent,
                        previousMessage: sendToGroupState.messageDetails.messageContent
                    }
                });

                const editResponse = {
                    text: result.response || `Please provide the edited message for ${sendToGroupState.messageDetails.targetGroup}.`,
                    action: "SEND_TO_GROUP"
                };
                await callback(editResponse);
                await createMemory(runtime, message, editResponse, true);
                break;

            case 'change_group':
                if (!result.extractedGroup) {
                    const response = {
                        text: result.response || "Please specify which group you want to send the message to.",
                        action: "SEND_TO_GROUP"
                    };
                    await callback(response);
                    await createMemory(runtime, message, response, true);
                    return;
                }

                if (!targetGroup) {
                    await handleGroupNotFound(runtime, message, callback, result.extractedGroup, typedGroupInfos);
                    return;
                }

                if (!sendToGroupState?.messageDetails?.messageContent) {
                    const response = {
                        text: result.response || "Please provide the message you want to send.",
                        action: "SEND_TO_GROUP"
                    };
                    await callback(response);
                    await createMemory(runtime, message, response, true);
                    return;
                }

                await setSendToGroupState(runtime, message.roomId, {
                    stage: 'confirmation',
                    messageDetails: {
                        targetGroup: targetGroup.title,
                        messageContent: sendToGroupState.messageDetails.messageContent,
                        previousGroup: sendToGroupState.messageDetails.targetGroup
                    }
                });

                const groupChangeResponse = {
                    text: result.response || `I'll send this message to ${targetGroup.title} instead of ${sendToGroupState.messageDetails.targetGroup}:\n\n"${sendToGroupState.messageDetails.messageContent}"\n\nPlease confirm by typing 'yes' or 'confirm' to send this message, or 'no' to cancel.`,
                    action: "SEND_TO_GROUP"
                };
                await callback(groupChangeResponse);
                await createMemory(runtime, message, groupChangeResponse, true);
                break;

            case 'cancel':
                await handleCancellation(runtime, message, callback);
                await clearSendToGroupState(runtime, message.roomId);
                break;

            default:
                const response = {
                    text: result.response || "I'm not sure what you'd like to do. Could you please clarify?",
                    action: "SEND_TO_GROUP"
                };
                await callback(response);
                await createMemory(runtime, message, response, true);
        }
    },
    examples: []
} as Action; 