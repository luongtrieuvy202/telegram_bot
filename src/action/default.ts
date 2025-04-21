import {
    Action,
    IAgentRuntime,
    Memory,
    State,
    HandlerCallback,
} from "@elizaos/core";
import {Context} from "telegraf";
import {Update} from "telegraf/types";

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
        const ctx = options.ctx as Context<Update>;

        // Send a helpful default message
        await callback({
            text: "I don't understand your command. Please check /help for more information.",
            action: "DEFAULT"
        });
    },
    examples: []
} as Action; 