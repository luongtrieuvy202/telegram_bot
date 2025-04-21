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
import {getUserGroupMessages, getGroupsByUserId} from "./utils.ts";
import {Context} from "telegraf";
import {Update} from "telegraf/types";
import {message} from 'telegraf/filters';


export const summaryAction: Action = {
    name: 'SUMMARY',
    similes: ['summary', 'summarize', 'group'],
    description: "Summarize messages from a specific group",
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
        })

        // Get recent messages for context
        const recentMessages = await runtime.messageManager.getMemories({
            roomId: message.roomId,
            count: 2
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
            context: `You are a JSON-only response bot. Your task is to analyze if a message indicates an intent to summarize messages from a group.
            Recent messages: ${context.recentMessages}
            Current message: ${context.currentMessage}
            
            Return ONLY a JSON object with the following structure, no other text:
            {
                "hasIntent": boolean, // true if user wants to summarize messages
                "targetGroup": string, // name of the group to summarize (if specified)
                "isAllGroups": boolean, // true if user wants to summarize all groups
                "confidence": number // confidence score of the analysis
            }`,
            modelClass: ModelClass.SMALL
        });

        console.log('Summary analysis response:', analysis);

        const result = extractJsonFromResponse(analysis);
        if (!result) {
            console.error('Failed to extract valid JSON from analysis');
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
        const ctx = options.ctx as Context<Update>;

        // Get user's groups from Redis
        const [groupIds, groupInfos] = await getGroupsByUserId(ctx.from.id.toString());

        // Analyze the current message and context
        const analysis = await generateText({
            runtime,
            context: `You are a JSON-only response bot. Your task is to analyze a message in the context of summarizing group messages.
            Message: ${message.content.text}
            Available groups: ${groupInfos.map(g => g.title).join(', ')}
            
            Return ONLY a JSON object with the following structure, no other text:
            {
                "intent": string, // "summarize_specific", "summarize_all", "cancel"
                "targetGroup": string, // name of the group to summarize (if specified)
                "isAllGroups": boolean, // true if user wants to summarize all groups
                "response": string // the exact message the bot should respond with
            }`,
            modelClass: ModelClass.SMALL
        });

        console.log('Handler analysis response:', analysis);

        const result = extractJsonFromResponse(analysis);
        if (!result) {
            console.error('Failed to extract valid JSON from handler analysis');
            await callback({
                text: "I'm having trouble understanding your request. Could you please rephrase?",
                action: "SUMMARY"
            });
            return;
        }

        // Find the target group by name (not ID)
        const targetGroup = groupInfos.find(group =>
            group.title?.toLowerCase() === result.targetGroup?.toLowerCase()
        );

        switch (result.intent) {
            case 'summarize_specific':
                if (!targetGroup) {
                    await callback({
                        text: result.response || `I couldn't find the group "${result.targetGroup}". Here are the groups you have access to:\n${groupInfos.map(g => g.title).join('\n')}`,
                        action: "SUMMARY"
                    });
                    return;
                }

                const messages = await redis.lrange(`group_messages:${targetGroup.id}`, 0, -1);
                const parsedLastMessages = messages.map(msg => JSON.parse(msg));
                const paragraph = parsedLastMessages.map(msg => msg.text).join(" ");

                const summaryPrompt = `Summarize the following messages from the group "${targetGroup.title}" in three sentences. 
                Focus on the main topics, important information, and any action items. 
                Remove any introductory phrases and start directly with the summary content.
                Format it as: 'Here are the messages from ${targetGroup.title}: ...'
                
                Messages to summarize:
                ${paragraph}`;

                const text = await generateText({
                    runtime: runtime,
                    context: summaryPrompt,
                    modelClass: ModelClass.SMALL
                });

                await callback({
                    text: text,
                    action: "SUMMARY"
                });
                break;

            case 'summarize_all':
                // Use the existing allGroupSummaryAction logic
                const responses = await getUserGroupMessages(ctx.message.from.id);

                // Check if there are any messages
                const hasMessages = Object.values(responses).some(groupData =>
                    (groupData as any).message && (groupData as any).message.length > 0
                );

                if (!hasMessages) {
                    await callback({
                        text: result.response || "You don't have any messages in your groups.",
                        action: "SUMMARY"
                    });
                    return;
                }

                const allGroupsPrompt = `🔍 *Unread Messages Summary*\n\n
                **Role**: You're a helpful Telegram assistant summarizing unread messages.

                Act as a Telegram assistant that summarizes my unread messages from today. Follow these rules:

                1. **Scan** all unread group chats and prioritize:
                   - Direct mentions (@me)
                   - Unanswered questions (to me or the group)
                   - Deadlines or action items
                   - Urgent/time-sensitive updates

                2. **Summarize** each active group in 1-2 lines. Skip inactive/noisy groups unless I'm mentioned.

                3. **Flag priorities** clearly:
                   - Use "[Action: ...]" for tasks (e.g., "[Action: Reply about budget]")
                   - Use "[Deadline: ...]" for time-sensitive items
                   - List all priorities under "**Priority Items**" at the end

                4. If nothing needs attention:
                   \`\`\`
                   No urgent items. Key updates: [Brief summary of notable discussions]
                   \`\`\`

                Keep tone natural and concise. Ignore spammy groups. Don't sound robotic. If there are no messages, simply state that there are no new messages today.

                Here are the messages:
                ${generateHumanSummary(responses, ctx.message.from.username)}`;

                const allGroupsText = await generateText({
                    runtime: runtime,
                    context: allGroupsPrompt,
                    modelClass: ModelClass.SMALL
                });

                await callback({
                    text: allGroupsText,
                    action: "SUMMARY"
                });
                break;

            case 'cancel':
                await callback({
                    text: result.response || "Summary request cancelled. Let me know if you'd like to try again.",
                    action: "SUMMARY"
                });
                break;

            default:
                await callback({
                    text: result.response || "I'm not sure what you'd like to summarize. Please specify a group or say 'all' for all groups.",
                    action: "SUMMARY"
                });
        }
    },
    examples: []
} as Action

function parseSummarizeCommand(command: string): { isSummarize: boolean; groupName?: string } {
    const regex = /(?:summariz(?:e|ing)|summary) messages? (?:from|of) (?:this )?group (?:named )?(.+)/i;
    const match = command.match(regex);

    if (match) {
        return {isSummarize: true, groupName: match[1]};
    }

    return {isSummarize: false};
}

interface Message {
    message_id: number;
    from: string
    text: string;
    date: string;
    username: string
}

interface GroupInfo {
    id: string;
    title: string;
    type: string;
    addedBy: string;
    addedAt: string;
}

interface GroupData {
    groupInfo: GroupInfo;
    message: Message[];
}

function generateHumanSummary(
    groups: Record<string, GroupData>,
    userName: string
): string {
    let prompt = "🔍 *Unread Messages Summary*\n\n";
    prompt += "**Role**: You're a helpful Telegram assistant summarizing unread messages.\n\n";
    prompt += `
  Act as a Telegram assistant that summarizes my unread messages from today. Follow these rules:
  
  1. **Scan** all unread group chats and prioritize:
     - Direct mentions (@me)
     - Unanswered questions (to me or the group)
     - Deadlines or action items
     - Urgent/time-sensitive updates
  
  2. **Summarize** each active group in 1-2 lines. Skip inactive/noisy groups unless I'm mentioned.
  
  3. **Flag priorities** clearly:
     - Use "[Action: ...]" for tasks (e.g., "[Action: Reply about budget]")
     - Use "[Deadline: ...]" for time-sensitive items
     - List all priorities under "**Priority Items**" at the end
  
  
  4. If nothing needs attention:
     \`\`\`
     No urgent items. Key updates: [Brief summary of notable discussions]
     \`\`\`
  
  Keep tone natural and concise. Ignore spammy groups.Don't sound so robotic like. If we don't have any messages, just says we don't have any new messages today
  `;

    // Process each group
    for (const [groupId, groupData] of Object.entries(groups)) {
        prompt += `\n*Group: ${groupData.groupInfo.title}*\n`;

        // Process each message
        groupData.message.forEach((msg) => {
            console.log(msg)
            const sender = msg.username || 'Unknown';
            const timeAgo = formatTimeAgo(msg.date);
            const excerpt = msg.text.length > 50
                ? `${msg.text.substring(0, 47)}...`
                : msg.text;

            prompt += `-${sender}: "${excerpt}"\n`;


        });
    }


    return prompt;
}

// Helper functions
function detectUrgency(text: string): boolean {
    const urgencyFlags = ['ASAP', 'urgent', 'important', 'deadline'];
    return urgencyFlags.some(flag => text.toLowerCase().includes(flag.toLowerCase()));
}

function truncateText(text: string, maxLength: number): string {
    return text.length > maxLength ? text.substring(0, maxLength - 3) + '...' : text;
}

function formatTimeAgo(dateString: string): string {
    const now = new Date();
    const msgDate = new Date(dateString);
    const hours = Math.floor((now.getTime() - msgDate.getTime()) / (1000 * 60 * 60));

    if (hours < 1) return 'just now';
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
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