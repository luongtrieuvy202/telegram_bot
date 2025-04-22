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

export const defaultAction: Action = {
    name: 'DEFAULT',
    similes: [],
    description: "Default response for unhandled messages",
    validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        // Always return true to handle any message that wasn't handled by other actions
        return true;
    },
    suppressInitialMessage: false,
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
        options?: any,
        callback?: HandlerCallback
    ): Promise<void> => {
        console.log('[DEFAULT] Starting handler execution');
        const ctx = options.ctx as Context<Update>;

        await runtime.messageManager.createMemory({
            content: {
                text: message.content.text
            },
            roomId: message.roomId,
            userId: message.userId,
            agentId: message.agentId
        });

        console.log('[DEFAULT] Analyzing message for intent');
        const analysis = await generateText({
            runtime,
            context: `You are a JSON-only response bot. Your task is to analyze a message and determine how to respond in a conversational way while staying focused on your role as a group management assistant.
            Message: ${message.content.text}
            
            Return ONLY a JSON object with the following structure, no other text:
            {
                "intent": string, // "greeting", "help", "confused", "farewell", "small_talk"
                "response": string, // the exact message the bot should respond with
                "suggestFeatures": boolean, // whether to suggest features after the response
                "conversationType": string // "feature_focused" or "small_talk"
            }

            Rules for intent detection:
            1. If message contains greetings (hi, hello, hey, etc.) -> "greeting"
            2. If message asks for help or features -> "help"
            3. If message is a farewell (bye, goodbye, etc.) -> "farewell"
            4. If message is small talk (how are you, what's up, etc.) -> "small_talk"
            5. Otherwise -> "confused"

            Rules for response generation:
            1. For "greeting": Be friendly and welcoming, but quickly steer towards your capabilities
            2. For "help": Explain available features in detail
            3. For "confused": Be helpful and guide the user to your features
            4. For "farewell": Be polite and friendly, remind them you're here to help
            5. For "small_talk": Keep responses brief and professional, redirect to features when appropriate

            Rules for conversation type:
            1. "feature_focused": When the conversation should be about your capabilities
            2. "small_talk": When the conversation is general but should be kept brief

            Guidelines:
            - Always maintain a professional and helpful tone
            - Keep small talk responses brief (1-2 sentences)
            - When in doubt, suggest features
            - Don't engage in personal topics or opinions
            - Don't pretend to have feelings or personal experiences
            - Focus on your role as a group management assistant
            - If asked about capabilities, provide detailed explanations
            - If asked about personal topics, politely redirect to your features

            Always set suggestFeatures to true for "greeting" and "confused" intents.
            For "small_talk", set suggestFeatures to true if the conversation has gone on for more than 2 exchanges.
            `,
            modelClass: ModelClass.SMALL
        });

        console.log('[DEFAULT] Analysis response:', analysis);

        const result = extractJsonFromResponse(analysis);
        if (!result) {
            console.error('[DEFAULT] Failed to extract valid JSON from analysis');
            await callback({
                text: "I'm having trouble understanding your message. Could you please rephrase?",
                action: "DEFAULT"
            });
            return;
        }

        console.log('[DEFAULT] Processing intent:', result.intent);

        let response = result.response;

        // Add feature suggestions if needed
        if (result.suggestFeatures) {
            response += "\n\nI can help you with the following features:\n" +
                "📝 *Summarize Messages* - Get a summary of group messages\n" +
                "🔔 *Mentions* - Find messages where you were mentioned\n" +
                "❓ *Unanswered Questions* - Find questions that haven't been answered\n" +
                "📊 *Polls* - Create and manage polls in groups\n" +
                "📢 *Send Messages* - Send messages to specific groups\n" +
                "⚙️ *Group Rules* - Manage group rules and moderation\n\n" +
                "Just ask me about any of these features to get started!";
        }

        await callback({
            text: response,
            action: "DEFAULT"
        });
        console.log('[DEFAULT] Handler execution completed');
    },
    examples: []
} as Action; 