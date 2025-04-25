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
import {getUserGroupMessages, getGroupsByUserId, extractJsonFromResponse} from "./utils.ts";
import {Context} from "telegraf";
import {Update} from "telegraf/types";


export const summaryAction: Action = {
    name: 'SUMMARY',
    similes: ['summary', 'summarize', 'group'],
    description: "Summarize messages from a specific group",
    validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {

        console.log('[SUMMARY] Starting validation check');
        if (!state?.handle) {
            console.log('[SUMMARY] Validation failed: No state handle found');
            return false;
        }
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
        console.log('[SUMMARY] Starting handler execution');
        const ctx = options.ctx as Context<Update>;

        console.log('[SUMMARY] Fetching recent messages for context');
        const recentMessages = await runtime.messageManager.getMemories({
            roomId: message.roomId,
            count: 5
        });

        console.log('[SUMMARY] Fetching user groups from Redis');
        const [groupIds, groupInfos] = await getGroupsByUserId(ctx.from.id.toString());
        console.log('[SUMMARY] Found groups:', groupInfos.map(g => g.title).join(', '));

        console.log('[SUMMARY] Analyzing message for specific action');
        const analysis = await generateText({
            runtime,
            context: `You are a JSON-only response bot. Your task is to analyze a message in the context of summarizing group messages.
            
            Recent conversation:
            ${recentMessages.map(m => m.content.text).join('\n')}
            
            Current message: ${message.content.text}
            Available groups: ${groupInfos.map(g => g.title).join(', ')}
            
            Return ONLY a JSON object with the following structure, no other text:
            {
                "intent": string, // "summarize_specific", "summarize_all", "cancel"
                "targetGroup": string, // name of the group to summarize (if specified)
                "isAllGroups": boolean, // true if user wants to summarize all groups
                "response": string // the exact message the bot should respond with
            }

            Additional guidelines:
            - Consider the recent conversation context when determining intent
            - If the user has been discussing a specific group, prioritize that group
            - If the user has been asking for summaries repeatedly, provide more detailed responses
            - If the user has been canceling frequently, be more explicit about the cancelation
            - If the user has been asking about specific topics, focus the summary on those topics
            `,
            modelClass: ModelClass.SMALL
        });

        console.log('[SUMMARY] Handler analysis response:', analysis);

        const result = extractJsonFromResponse(analysis);
        if (!result) {
            console.error('[SUMMARY] Failed to extract valid JSON from handler analysis');
            await callback({
                text: "I'm having trouble understanding your request. Could you please rephrase?",
                action: "SUMMARY"
            });
            return;
        }

        await runtime.messageManager.createMemory({
          content: {
              text: message.content.text
          },
          roomId: message.roomId,
          userId: message.userId,
          agentId: message.agentId
      });

        console.log('[SUMMARY] Processing intent:', result.intent);

        const targetGroup = groupInfos.find(group =>
            group.title?.toLowerCase() === result.targetGroup?.toLowerCase()
        );

        switch (result.intent) {
            case 'summarize_specific':
                console.log('[SUMMARY] Processing summarize_specific intent for group:', result.targetGroup);
                if (!targetGroup) {
                    console.log('[SUMMARY] Target group not found:', result.targetGroup);
                    await callback({
                        text: result.response || `I couldn't find the group "${result.targetGroup}". Here are the groups you have access to:\n${groupInfos.map(g => g.title).join('\n')}`,
                        action: "SUMMARY"
                    });
                    return;
                }

                console.log('[SUMMARY] Fetching messages for group:', targetGroup.title);
                const messages = await redis.lrange(`group_messages:${targetGroup.id}`, 0, -1);
                const parsedLastMessages = messages.map(msg => JSON.parse(msg));

                console.log('[SUMMARY] Found messages:', parsedLastMessages.length);

                if (parsedLastMessages.length === 0) {
                    console.log('[SUMMARY] No messages found');
                    await callback({
                        text: `No messages found in ${targetGroup.title}.`,
                        action: "SUMMARY"
                    });
                    return;
                }

                const summaryPrompt = `🔍 *Group Messages Summary*\n\n
                **Role**: You're a helpful Telegram assistant summarizing group messages.

                Act as a Telegram assistant that summarizes the messages from today. Follow these rules:

                1. **Scan** all messages and prioritize:
                   - Direct mentions (@me)
                   - Unanswered questions
                   - Deadlines or action items
                   - Urgent/time-sensitive updates

                2. **Summarize** the group activity in 1-2 lines. Skip if no notable activity.

                3. **Flag priorities** clearly:
                   - Use "[Action: ...]" for tasks
                   - Use "[Deadline: ...]" for time-sensitive items
                   - List all priorities under "**Priority Items**" at the end

                4. If nothing needs attention:
                   \`\`\`
                   No urgent items. Key updates: [Brief summary of notable discussions]
                   \`\`\`

                Keep tone natural and concise. Don't sound robotic.

                Here are the messages:
                ${parsedLastMessages.map(m => `${m.username || 'Unknown'}: ${m.text}`).join('\n')}`;

                console.log('[SUMMARY] Generating summary with AI');
                const summary = await generateText({
                    runtime,
                    context: summaryPrompt,
                    modelClass: ModelClass.LARGE
                });

                console.log('[SUMMARY] Generated summary text');

                await callback({
                    text: `📋 *Summary for ${targetGroup.title}*\n\n${summary}`,
                    action: "SUMMARY"
                });
                break;

            case 'summarize_all':
                console.log('[SUMMARY] Processing summarize_all intent');
                const allResponses = await getUserGroupMessages(ctx.message.from.id);
                console.log('[SUMMARY] Fetched messages from', Object.keys(allResponses).length, 'groups');

                const allSummaries = [];

                for (const [groupId, groupData] of Object.entries(allResponses)) {
                    const messages = (groupData as any).message;
                    if (messages && messages.length > 0) {
                        console.log('[SUMMARY] Processing messages for group:', (groupData as any).groupInfo.title);
                        const summaryPrompt = `🔍 *Group Messages Summary*\n\n
                        **Role**: You're a helpful Telegram assistant summarizing group messages.

                        Act as a Telegram assistant that summarizes the messages from today. Follow these rules:

                        1. **Scan** all messages and prioritize:
                           - Direct mentions (@me)
                           - Unanswered questions
                           - Deadlines or action items
                           - Urgent/time-sensitive updates

                        2. **Summarize** the group activity in 1-2 lines. Skip if no notable activity.

                        3. **Flag priorities** clearly:
                           - Use "[Action: ...]" for tasks
                           - Use "[Deadline: ...]" for time-sensitive items
                           - List all priorities under "**Priority Items**" at the end

                        4. If nothing needs attention:
                           \`\`\`
                           No urgent items. Key updates: [Brief summary of notable discussions]
                           \`\`\`

                        Keep tone natural and concise. Don't sound robotic.

                        Here are the messages:
                        ${messages.map(m => `${m.username || 'Unknown'}: ${m.text}`).join('\n')}`;

                        console.log('[SUMMARY] Generating summary for group:', (groupData as any).groupInfo.title);
                        const summary = await generateText({
                            runtime,
                            context: summaryPrompt,
                            modelClass: ModelClass.LARGE
                        });

                        allSummaries.push({
                            group: (groupData as any).groupInfo.title,
                            summary
                        });
                    }
                }

                if (allSummaries.length === 0) {
                    console.log('[SUMMARY] No messages found in any group');
                    await callback({
                        text: "✅ No messages found in any of your groups.",
                        action: "SUMMARY"
                    });
                    return;
                }

                const allSummariesText = allSummaries.map(g =>
                    `📌 *${g.group}*\n${g.summary}\n`
                ).join('\n');

                console.log('[SUMMARY] Generated summaries for', allSummaries.length, 'groups');

                await callback({
                    text: `📋 *All Groups Summary*\n\n${allSummariesText}`,
                    action: "SUMMARY"
                });
                break;

            case 'cancel':
                console.log('[SUMMARY] Processing cancel intent');
                await callback({
                    text: result.response || "Summary request cancelled. Let me know if you'd like to try again.",
                    action: "SUMMARY"
                });
                break;

            default:
                console.log('[SUMMARY] Unknown intent:', result.intent);
                await callback({
                    text: result.response || "I'm not sure what you'd like to do. Please specify a group or say 'all' to summarize all groups.",
                    action: "SUMMARY"
                });
        }
        console.log('[SUMMARY] Handler execution completed');
    },
    examples: []
} as Action