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
        if (!state?.handle) return false;

        await runtime.messageManager.createMemory({
            roomId: message.roomId,
            userId: message.userId,
            agentId: message.agentId,
            content: {
                text: message.content.text,
                type: "text"
            }
        });

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

        console.log('Unanswered question analysis response:', analysis);

        const result = extractJsonFromResponse(analysis);
        if (!result) {
            console.error('Failed to extract valid JSON from analysis');
            return false;
        }

        // Explicitly reject other types of requests
        if (result.isSummaryRequest || result.isSendRequest || result.isMentionRequest) {
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
            context: `You are a JSON-only response bot. Your task is to analyze a message in the context of finding unanswered questions.
            Message: ${message.content.text}
            Available groups: ${groupInfos.map(g => g.title).join(', ')}
            
            Return ONLY a JSON object with the following structure, no other text:
            {
                "intent": string, // "find_specific", "find_all", "cancel"
                "targetGroup": string, // name of the group to check (if specified)
                "isAllGroups": boolean, // true if user wants to check all groups
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
                action: "UNANSWERED_QUESTION"
            });
            return;
        }

        // Find the target group by name (not ID)
        const targetGroup = groupInfos.find(group =>
            group.title?.toLowerCase() === result.targetGroup?.toLowerCase()
        );

        switch (result.intent) {
            case 'find_specific':
                if (!targetGroup) {
                    await callback({
                        text: result.response || `I couldn't find the group "${result.targetGroup}". Here are the groups you have access to:\n${groupInfos.map(g => g.title).join('\n')}`,
                        action: "UNANSWERED_QUESTION"
                    });
                    return;
                }

                const messages = await redis.lrange(`group_messages:${targetGroup.id}`, 0, -1);
                const parsedLastMessages = messages.map(msg => JSON.parse(msg));
                const unansweredQuestions = parsedLastMessages.filter(msg =>
                    msg.text.includes('?') && !msg.replies?.length
                );

                if (unansweredQuestions.length === 0) {
                    await callback({
                        text: `No unanswered questions found in ${targetGroup.title}.`,
                        action: "UNANSWERED_QUESTION"
                    });
                    return;
                }

                const questionsText = unansweredQuestions.map(q =>
                    `- ${q.text} (from ${q.username || 'Unknown'})`
                ).join('\n');

                await callback({
                    text: `Here are the unanswered questions in ${targetGroup.title}:\n\n${questionsText}`,
                    action: "UNANSWERED_QUESTION"
                });
                break;

            case 'find_all':
                const allResponses = await getUserGroupMessages(ctx.message.from.id);
                const allUnanswered = [];

                for (const [groupId, groupData] of Object.entries(allResponses)) {
                    const questions = (groupData as any).message.filter(msg =>
                        msg.text.includes('?') && !msg.replies?.length
                    );

                    if (questions.length > 0) {
                        allUnanswered.push({
                            group: (groupData as any).groupInfo.title,
                            questions: questions.map(q =>
                                `- ${q.text} (from ${q.username || 'Unknown'})`
                            ).join('\n')
                        });
                    }
                }

                if (allUnanswered.length === 0) {
                    await callback({
                        text: "No unanswered questions found in any of your groups.",
                        action: "UNANSWERED_QUESTION"
                    });
                    return;
                }

                const allQuestionsText = allUnanswered.map(g =>
                    `*${g.group}*\n${g.questions}`
                ).join('\n\n');

                await callback({
                    text: `Here are all unanswered questions:\n\n${allQuestionsText}`,
                    action: "UNANSWERED_QUESTION"
                });
                break;

            case 'cancel':
                await callback({
                    text: result.response || "Question search cancelled. Let me know if you'd like to try again.",
                    action: "UNANSWERED_QUESTION"
                });
                break;

            default:
                await callback({
                    text: result.response || "I'm not sure what you'd like to do. Please specify a group or say 'all' to check all groups.",
                    action: "UNANSWERED_QUESTION"
                });
        }
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