import {
    Action,
    IAgentRuntime,
    Memory,
    State,
    HandlerCallback,
    generateText,
    ModelClass,
} from "@elizaos/core";
import { Context } from "telegraf";
import { Update } from "telegraf/types";
import { getUserGroupMessages } from "./utils.ts";

interface GroupInfo {
    title: string;
    [key: string]: any;
}

interface GroupMessage {
    text: string;
    from: string;
    username?: string;
    date: string;
}

interface GroupData {
    groupInfo: GroupInfo;
    message: GroupMessage[];
}

// Messages to exclude from the response
const EXCLUDED_MESSAGES = [
    /^hi$/i,
    /^hello$/i,
    /^hey$/i,
    /^hi @/i,
    /^hello @/i,
    /^hey @/i,
    /^how r u$/i,
    /^how are you$/i,
    /^what's up$/i,
    /^sup$/i,
    /^dang lam gi do$/i,
    /^\s*$/, // Empty messages
];

export const unansweredQuestionsAction: Action = {
    name: 'UNANSWERED_QUESTIONS',
    similes: ['follow up', 'unanswered', 'questions', 'pending'],
    description: "Track and summarize messages that need follow-up from conversations",
    validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        const text = message.content.text.toLowerCase();
        return text.includes("follow up") || 
               text.includes("unanswered") ||
               text.includes("questions") ||
               text.includes("pending");
    },
    suppressInitialMessage: true,
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
        options?: any,
        callback?: HandlerCallback
    ): Promise<void> => {
        const ctx = options.ctx as Context<Update>;
        
        // Get messages from all groups
        const groupMessages = await getUserGroupMessages(ctx.message.from.id) as Record<string, GroupData>;
        
        // Track messages that haven't been responded to
        const unrespondedMessages = [];
        
        // Process each group's messages
        for (const [groupId, groupData] of Object.entries(groupMessages)) {
            const messages = groupData.message;
            const groupName = groupData.groupInfo.title;
            
            for (let i = 0; i < messages.length; i++) {
                const msg = messages[i];
                
                // Check if there's a response within the next few messages
                let hasResponse = false;
                for (let j = i + 1; j < Math.min(i + 5, messages.length); j++) {
                    if (messages[j].from !== msg.from) {
                        hasResponse = true;
                        break;
                    }
                }
                
                if (!hasResponse) {
                    unrespondedMessages.push({
                        text: msg.text,
                        from: msg.username || msg.from,
                        group: groupName,
                        timestamp: msg.date
                    });
                }
            }
        }
        
        if (unrespondedMessages.length === 0) {
            await callback({
                text: "I don't see any messages that need follow-up in your groups.",
                action: "UNANSWERED_QUESTIONS"
            });
            return;
        }
        
        // Generate a summary of unresponded messages
        const messagesText = unrespondedMessages
            .map(m => `- "${m.text}" (from ${m.from} in ${m.group})`)
            .join('\n');
            
        const prompt = `🔍 *Messages Requiring Follow-up*\n\n
**Role**: You're a Telegram assistant summarizing unresponded messages.

Instructions:
1. Filter out the following types of messages:
   - Simple greetings (hi, hello, hey)
   - Empty messages
   - Repeated messages
   - Messages that are just mentions without content
   - Casual conversation starters

2. Group the remaining messages by their group name

3. For each group, list only messages that:
   - Ask a question
   - Request information
   - Need a response or action
   - Contain important information
   - Are time-sensitive

4. Only mark messages as [Urgent] if they contain:
   - Deadline mentions
   - "ASAP" or "urgent"
   - Time-sensitive requests

5. Format:
   \`\`\`
   *Group Name*
   - [Urgent] @username: message
   - @username: message
   \`\`\`

Here are all the messages:
${messagesText}

Provide a clean, organized list of only the meaningful messages that require follow-up, grouped by their respective groups.`;

        const summary = await generateText({
            runtime: runtime,
            context: prompt,
            modelClass: ModelClass.SMALL
        });
        
        await callback({
            text: summary,
            action: "UNANSWERED_QUESTIONS"
        });
    },
    examples: []
} as Action; 