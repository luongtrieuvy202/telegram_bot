import { IAgentRuntime } from "@elizaos/core";

import { Memory } from "@elizaos/core";

interface SendToGroupState {
    stage: 'initial' | 'group_selection' | 'message_collection' | 'confirmation' | 'editing' | 'cancelled';
    messageDetails?: {
        targetGroup: string | 'all';  // 'all' for all groups
        messageContent: string;
        previousMessage?: string;
        previousGroup?: string;
    };
    retryCount?: number;
    lastError?: string;
    lastAction?: string;
}

interface GroupInfo {
    id: string;
    title: string;
}

interface MessageResponse {
    text: string;
    action: string;
}

async function createMemory(
    runtime: IAgentRuntime,
    message: Memory,
    response: MessageResponse,
    isBotMessage: boolean
): Promise<void> {
    // Add prefix based on the isBotMessage parameter
    const prefix = isBotMessage ? 'Tely: ' : 'User: ';
    const prefixedText = `${prefix}${response.text}`;

    await runtime.messageManager.createMemory({
        content: { text: prefixedText },
        roomId: message.roomId,
        userId: message.userId,
        agentId: message.agentId
    });
}

export { SendToGroupState, GroupInfo, MessageResponse, createMemory };
