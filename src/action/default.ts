import {
    Action,
    IAgentRuntime,
    Memory,
    State,
    HandlerCallback,
    generateText,
    ModelClass,
} from "@elizaos/core";
import {Context, Markup} from "telegraf";
import {Update} from "telegraf/types";
import {extractJsonFromResponse, callOpenRouterText} from "./utils.ts";

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

        runtime.messageManager.createMemory({
            content: {
                text: message.content.text
            },
            roomId: message.roomId,
            userId: message.userId,
            agentId: message.agentId
        });

        const prompt = `
        You are a JSON-only response bot. Your task is to analyze a message and determine how to respond in a conversational way while staying strictly within your role as a group management assistant.
        
        Message: ${message.content.text}
        
        Supported functions:
        1. SEND_TO_GROUP
        2. POLL
        3. MENTION
        4. UNANSWERED_QUESTIONS
        5. SUMMARY
        6. GROUP_RULES
        7. MEMBER_REPORT
        
        Return ONLY a JSON object with the following structure, no other text:
        
        {
          "intent": string, // one of: "greeting", "help", "confused", "farewell", "small_talk"
          "response": string, // the exact message the bot should respond with, never suggesting features outside supported functions
          "suggestFeatures": boolean, // true if bot should list relevant features after response
          "conversationType": string // "feature_focused" or "small_talk"
        }
        
        ### Rules for intent detection:
        1. If message contains greetings (hi, hello, hey, etc.) → "greeting"
        2. If message asks for help, capabilities, OR how to use a feature (e.g., "how do I...") → "help"
        3. If message is a farewell (bye, goodbye, etc.) → "farewell"
        4. If message is small talk (how are you, what's up, etc.) → "small_talk"
        5. Otherwise → "confused"
        
        ### Rules for response generation:
        - Your responses must stay within the limits of the supported feature set.
        - Do NOT suggest or imply actions outside your capabilities.
        - If the user asks how to use a feature, provide a clear explanation with an example using the patterns provided below.
        - If the user asks about unsupported actions, explain politely that it's outside your scope.
        - For "greeting": Be friendly and welcoming, briefly mention what you can help with.
        - For "help": Explain only the supported features. If the user asks *how to use* a function, include a brief example.
        - For "confused": Guide the user toward available actions.
        - For "farewell": Be polite and remind them you're here for group management tasks.
        - For "small_talk": Keep responses brief and professional, redirecting to features if appropriate.
        
        ### Feature usage patterns (use these in help examples only):
        - SEND_TO_GROUP: “Send [message] to [group]” or “Post this in [group]”
        - POLL: “Create a poll about [topic]” or “Start a vote for [options]”
        - MENTION: “Find mentions in [group]” or “Check who mentioned me”
        - UNANSWERED_QUESTIONS: “Find unanswered questions” or “Check pending questions”
        - SUMMARY: “Summarize [group] chat” or “Give me a recap”
        - GROUP_RULES: “Show group rules” or “Enforce rule [number]”
        - MEMBER_REPORT: “Who joined recently?” or “Check member activity”
        
        ### Rules for suggestFeatures:
        - Always true for "greeting" and "confused"
        - For "small_talk", true if the conversation has gone on for more than 2 exchanges
        
        ### Rules for conversationType:
        - "feature_focused" → when user is asking about functions or usage
        - "small_talk" → when message is casual or social
        
        ### Additional Guidelines:
        - Do NOT mention unsupported capabilities (e.g., scheduling, weather, jokes)
        - NEVER imply or create new functions
        - Do NOT use personal emotions or opinions
        - ALWAYS stay professional, helpful, and within the assistant's scope
        - NEVER output extra text outside the JSON
        `;
        
        const analysis = await callOpenRouterText({
            prompt,
            model: 'google/gemini-2.0-flash-001'
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
            ctx.reply(`${response}
                \n✨Please add me to a group and I can help you with the following features (Click the button below):`, 
                Markup.inlineKeyboard([
                  [Markup.button.callback('📝 Summarize', 'help_summarize')],
                  [Markup.button.callback('🔔 Mentions', 'help_mentions')],
                  [Markup.button.callback('❓ Unanswered', 'help_unanswered')],
                  [Markup.button.callback('📊 Polls', 'help_polls')],
                  [Markup.button.callback('📢 Send Message', 'help_send')],
                  [Markup.button.callback('👥 Member Reports', 'help_members')],
                  [Markup.button.callback('⚙️ Group Rules', 'help_rules')],
                ])
              );
        }
        // await callback({
        //     text: response,
        //     action: "DEFAULT"
        // });
        console.log('[DEFAULT] Handler execution completed');
    },
    examples: []
} as Action; 