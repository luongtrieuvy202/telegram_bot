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
import { getUserGroupMessages } from "./utils.ts";
import { Context } from "telegraf";
import { Update } from "telegraf/types";
import { message } from 'telegraf/filters';

export const allGroupSummaryAction: Action = {
    name: 'SUMMARY_GROUPS',
    similes: [],
    description: "user asked question to summary messages from a specific group to Eliza",
    validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        return message.content.text.toLowerCase().includes("miss")
            || message.content.text.toLowerCase().includes("missed")
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
        const responses = await getUserGroupMessages(ctx.message.from.id)
        
        // Check if there are any messages
        const hasMessages = Object.values(responses).some(groupData => 
            (groupData as any).message && (groupData as any).message.length > 0
        );
        
        if (!hasMessages) {
            await callback({
                text: "You don't have any messages in your groups.",
                action: "SUMMARY_GROUPS"
            });
            return;
        }

        const prompt = `🔍 *Unread Messages Summary*\n\n
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
${generateHumanSummary(responses, ctx.message.from.username)}

Provide a summary following these guidelines. If there are no messages, just say there are no new messages today.`;

        const text = await generateText({
            runtime: runtime,
            context: prompt,
            modelClass: ModelClass.SMALL
        });

        callback({
            text: text,
            action: "SUMMARY_GROUPS"
        });
    },
    examples: []
}


export const summaryAction: Action = {
    name: 'SUMMARY',
    similes: [],
    description: "user asked question to summary messages from a specific group to Eliza",
    validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        return message.content.text.toLowerCase().includes("summary")
            || message.content.text.toLowerCase().includes("group")
            || message.content.text.toLowerCase().includes("summarize");
    },
    suppressInitialMessage: true,
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
        options?: any,
        callback?: HandlerCallback
    ): Promise<void> => {
        const check = parseSummarizeCommand(message.content.text)
        console.log(check)
        if(check.isSummarize){
            const groupId = await redis.get(`group_name:${check.groupName}`) as string 
            const messages = await redis.lrange(`group_messages:${groupId}`,0,-1)
            const parsedLastMessages = messages.map(msg => JSON.parse(msg));
            const paragraph = parsedLastMessages.map(msg => msg.text).join(" ");
            const prompt = `SSummarize the following paragraph in three sentences. Remove any introductory phrases like 'Here is a summary' or 'The paragraph talks about.' The response should start directly with the summary content. Format it as: 'Here are the messages you haven't read from the group: ...:\n\n${paragraph}`;

            const text = await generateText({
                runtime: runtime,
                context: prompt,
                modelClass: ModelClass.SMALL
            })

            console.log(text)

            callback({
                text: text,
                action: "SUMMARY_MESSAGES"
            })
        }

    },
    examples: [
    ],
} as Action

function parseSummarizeCommand(command: string): { isSummarize: boolean; groupName?: string } {
    const regex = /(?:summariz(?:e|ing)|summary) messages? (?:from|of) (?:this )?group (?:named )?(.+)/i;
    const match = command.match(regex);

    if (match) {
        return { isSummarize: true, groupName: match[1] };
    }

    return { isSummarize: false };
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