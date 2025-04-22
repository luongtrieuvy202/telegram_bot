import {
    Action,
    IAgentRuntime,
    Memory,
    State,
    HandlerCallback,
    generateText,
    ModelClass,
} from "@elizaos/core";
import {Context} from "telegraf";
import {Update} from "telegraf/types";
import {getGroupsByUserId, getUserGroupMessages} from "./utils.ts";
import redis from "../redis/redis.ts";

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

export const unansweredQuestionAction: Action = {
    name: 'UNANSWERED_QUESTIONS',
    similes: ['unanswered', 'question', 'pending'],
    description: "Get unanswered questions in groups",
    validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        console.log('[UNANSWERED_QUESTIONS] Starting validation check');
        if (!state?.handle) {
            console.log('[UNANSWERED_QUESTIONS] Validation failed: No state handle found');
            return false;
        }

        console.log('[UNANSWERED_QUESTIONS] Creating memory for message');

        console.log('[UNANSWERED_QUESTIONS] Fetching recent messages for context');
        const recentMessages = await runtime.messageManager.getMemories({
            roomId: message.roomId,
            count: 2
        });

        const context = {
            recentMessages: recentMessages.map(m => m.content.text).join('\n'),
            currentMessage: message.content.text,
            currentState: state
        };

        console.log('[UNANSWERED_QUESTIONS] Analyzing intent with AI');
        const analysis = await generateText({
            runtime,
            context: `You are a JSON-only response bot. Your task is to analyze if a message indicates an intent to find unanswered questions in groups.
            IMPORTANT: This is ONLY for finding unanswered questions, NOT for summarizing, sending messages, or finding mentions.
            
            Recent messages: ${context.recentMessages}
            Current message: ${context.currentMessage}
            
            Return ONLY a JSON object with the following structure, no other text:
            {
                "hasIntent": boolean, // true ONLY if user wants to find unanswered questions
                "targetGroup": string, // name of the group to check (if specified)
                "isAllGroups": boolean, // true if user wants to check all groups
                "confidence": number, // confidence score of the analysis
                "nextAction": string, // what the bot should do next
                "isSummaryRequest": boolean, // true if this is actually a request to summarize
                "isSendRequest": boolean, // true if this is actually a request to send a message
                "isMentionRequest": boolean // true if this is actually a request to find mentions
            }`,
            modelClass: ModelClass.SMALL
        });

        console.log('[UNANSWERED_QUESTIONS] AI Analysis response:', analysis);

        const result = extractJsonFromResponse(analysis);
        if (!result) {
            console.error('[UNANSWERED_QUESTIONS] Failed to extract valid JSON from analysis');
            return false;
        }

        console.log('[UNANSWERED_QUESTIONS] Analysis result:', JSON.stringify(result, null, 2));

        if (result.isSummaryRequest || result.isSendRequest || result.isMentionRequest) {
            console.log('[UNANSWERED_QUESTIONS] Request type mismatch - rejecting');
            return false;
        }

        console.log('[UNANSWERED_QUESTIONS] Validation successful:', result.hasIntent);
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
        console.log('[UNANSWERED_QUESTIONS] Starting handler execution');
        const ctx = options.ctx as Context<Update>;

        console.log('[UNANSWERED_QUESTIONS] Fetching recent messages for context');
        const recentMessages = await runtime.messageManager.getMemories({
            roomId: message.roomId,
            count: 5
        });

        console.log('[UNANSWERED_QUESTIONS] Fetching user groups from Redis');
        const [groupIds, groupInfos] = await getGroupsByUserId(ctx.from.id.toString());
        console.log('[UNANSWERED_QUESTIONS] Found groups:', groupInfos.map(g => g.title).join(', '));

        console.log('[UNANSWERED_QUESTIONS] Analyzing message for specific action');
        const analysis = await generateText({
            runtime,
            context: `You are a JSON-only response bot. Your task is to analyze a message in the context of finding unanswered questions.
            
            Recent conversation:
            ${recentMessages.map(m => m.content.text).join('\n')}
            
            Current message: ${message.content.text}
            Available groups: ${groupInfos.map(g => g.title).join(', ')}
            
            Return ONLY a JSON object with the following structure, no other text:
            {
                "intent": string, // "find_specific", "find_all", "cancel"
                "targetGroup": string, // name of the group to check (if specified)
                "isAllGroups": boolean, // true if user wants to check all groups
                "response": string // the exact message the bot should respond with
            }

            Additional guidelines:
            - Consider the recent conversation context when determining intent
            - If the user has been discussing a specific group, prioritize that group
            - If the user has been asking about questions repeatedly, provide more detailed responses
            - If the user has been canceling frequently, be more explicit about the cancelation
            - If the user has been asking about specific topics, focus on questions related to those topics
            - If the user has been asking about specific users, prioritize their questions
            `,
            modelClass: ModelClass.SMALL
        });

        console.log('[UNANSWERED_QUESTIONS] Handler analysis response:', analysis);

        const result = extractJsonFromResponse(analysis);
        if (!result) {
            console.error('[UNANSWERED_QUESTIONS] Failed to extract valid JSON from handler analysis');
            await callback({
                text: "I'm having trouble understanding your request. Could you please rephrase?",
                action: "UNANSWERED_QUESTION"
            });
            return;
        }

        console.log('[UNANSWERED_QUESTIONS] Processing intent:', result.intent);

        await runtime.messageManager.createMemory({
            content: {
                text: message.content.text
            },
            roomId: message.roomId,
            userId: message.userId,
            agentId: message.agentId
        });

        const targetGroup = groupInfos.find(group =>
            group.title?.toLowerCase() === result.targetGroup?.toLowerCase()
        );

        switch (result.intent) {
            case 'find_specific':
                console.log('[UNANSWERED_QUESTIONS] Processing find_specific intent for group:', result.targetGroup);
                if (!targetGroup) {
                    console.log('[UNANSWERED_QUESTIONS] Target group not found:', result.targetGroup);
                    await callback({
                        text: result.response || `I couldn't find the group "${result.targetGroup}". Here are the groups you have access to:\n${groupInfos.map(g => g.title).join('\n')}`,
                        action: "UNANSWERED_QUESTION"
                    });
                    return;
                }

                console.log('[UNANSWERED_QUESTIONS] Fetching messages for group:', targetGroup.title);
                const messages = await redis.lrange(`group_messages:${targetGroup.id}`, 0, -1);
                const parsedLastMessages = messages.map(msg => JSON.parse(msg));
                const unansweredQuestions = parsedLastMessages.filter(msg =>
                    msg.text.includes('?') && !msg.replies?.length
                );

                console.log('[UNANSWERED_QUESTIONS] Found unanswered questions:', unansweredQuestions.length);

                if (unansweredQuestions.length === 0) {
                    console.log('[UNANSWERED_QUESTIONS] No unanswered questions found');
                    await callback({
                        text: `No unanswered questions found in ${targetGroup.title}.`,
                        action: "UNANSWERED_QUESTION"
                    });
                    return;
                }

                const questionsText = unansweredQuestions.map((q, index) =>
                    `${index + 1}. Question: "${q.text}"\n   From: ${q.username || 'Unknown'}\n   Posted: ${new Date(q.date).toLocaleString()}\n`
                ).join('\n');

                console.log('[UNANSWERED_QUESTIONS] Generated response text for', unansweredQuestions.length, 'questions');

                await callback({
                    text: `📋 *Unanswered Questions in ${targetGroup.title}*\n\n${questionsText}\n\nTotal: ${unansweredQuestions.length} unanswered question${unansweredQuestions.length === 1 ? '' : 's'}`,
                    action: "UNANSWERED_QUESTION"
                });
                break;

            case 'find_all':
                console.log('[UNANSWERED_QUESTIONS] Processing find_all intent');
                const allResponses = await getUserGroupMessages(ctx.message.from.id);
                console.log('[UNANSWERED_QUESTIONS] Fetched messages from', Object.keys(allResponses).length, 'groups');

                const allUnanswered = [];

                for (const [groupId, groupData] of Object.entries(allResponses)) {
                    const questions = (groupData as any).message.filter(msg =>
                        msg.text.includes('?') && !msg.replies?.length
                    );

                    if (questions.length > 0) {
                        console.log('[UNANSWERED_QUESTIONS] Found', questions.length, 'unanswered questions in group:', (groupData as any).groupInfo.title);
                        allUnanswered.push({
                            group: (groupData as any).groupInfo.title,
                            questions: questions.map((q, index) =>
                                `${index + 1}. Question: "${q.text}"\n   From: ${q.username || 'Unknown'}\n   Posted: ${new Date(q.date).toLocaleString()}\n`
                            ).join('\n')
                        });
                    }
                }

                if (allUnanswered.length === 0) {
                    console.log('[UNANSWERED_QUESTIONS] No unanswered questions found in any group');
                    await callback({
                        text: "✅ No unanswered questions found in any of your groups.",
                        action: "UNANSWERED_QUESTION"
                    });
                    return;
                }

                const allQuestionsText = allUnanswered.map(g =>
                    `📌 *${g.group}*\n${g.questions}\n`
                ).join('\n');

                const totalQuestions = allUnanswered.reduce((sum, group) => 
                    sum + group.questions.split('\n').filter(line => line.includes('Question:')).length, 0);

                console.log('[UNANSWERED_QUESTIONS] Generated response for', totalQuestions, 'questions across', allUnanswered.length, 'groups');

                await callback({
                    text: `📋 *Unanswered Questions Summary*\n\n${allQuestionsText}\n\nTotal: ${totalQuestions} unanswered question${totalQuestions === 1 ? '' : 's'} across ${allUnanswered.length} group${allUnanswered.length === 1 ? '' : 's'}`,
                    action: "UNANSWERED_QUESTION"
                });
                break;

            case 'cancel':
                console.log('[UNANSWERED_QUESTIONS] Processing cancel intent');
                await callback({
                    text: result.response || "Question search cancelled. Let me know if you'd like to try again.",
                    action: "UNANSWERED_QUESTION"
                });
                break;

            default:
                console.log('[UNANSWERED_QUESTIONS] Unknown intent:', result.intent);
                await callback({
                    text: result.response || "I'm not sure what you'd like to do. Please specify a group or say 'all' to check all groups.",
                    action: "UNANSWERED_QUESTION"
                });
        }
        console.log('[UNANSWERED_QUESTIONS] Handler execution completed');
    },
    examples: [
        [
            {
                user: "user",
                content: {
                    text: "Show me unanswered questions in the Tech group",
                    action: "UNANSWERED_QUESTION"
                }
            }
        ],
        [
            {
                user: "user",
                content: {
                    text: "What questions haven't been answered in all groups?",
                    action: "UNANSWERED_QUESTION"
                }
            }
        ]
    ]
} as Action; 