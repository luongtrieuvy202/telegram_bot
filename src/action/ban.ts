import {
    Action,
    IAgentRuntime,
    Memory,
    State,
    HandlerCallback,
} from "@elizaos/core";


import { Context, Telegraf } from "telegraf";
import { Update } from "telegraf/types";

export const banAction: Action = {
    name: 'BAN',
    similes: [],
    description: "ban user that curse",
    validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        return message.content.text.toLowerCase().includes("stupid")
    },
    suppressInitialMessage: true,
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
        options?: any,
        callback?: HandlerCallback
    ): Promise<void> => {
        const bot = await runtime.clients[0].bot as Telegraf
        const ctx = options.ctx as Context<Update>
        bot.telegram.banChatMember(ctx.chat.id, ctx.message.from.id)
        await callback({
            text: "Ban user",
            action: "BAN"
        })
    },
    examples: [
    ],
} as Action