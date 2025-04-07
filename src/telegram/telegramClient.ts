import {type Context, Telegraf} from "telegraf";
import {message} from "telegraf/filters";
import {type IAgentRuntime, elizaLogger} from "@elizaos/core";
import {MessageManager} from "./messageManager.ts";
import {getOrCreateRecommenderInBe} from "./getOrCreateRecommenderInBe.ts";
import redis from "../redis/redis.ts";
import {Update} from "telegraf/types";
import {handleMention, markMentionsAsRead, trackMention} from "../action/utils.ts";
import {trackNewMember} from "../action/memberReport.ts";

export class TelegramClient {
    private bot: Telegraf<Context>;
    private runtime: IAgentRuntime;
    public messageManager: MessageManager;
    private backend;
    private backendToken;
    private tgTrader;
    private options;

    constructor(runtime: IAgentRuntime, botToken: string) {
        elizaLogger.log("📱 Constructing new TelegramClient...");
        this.options = {
            telegram: {
                apiRoot: runtime.getSetting("TELEGRAM_API_ROOT") || process.env.TELEGRAM_API_ROOT || "https://api.telegram.org"
            },
        };
        this.runtime = runtime;
        this.bot = new Telegraf(botToken, this.options);
        this.messageManager = new MessageManager(this.bot, this.runtime);
        this.backend = runtime.getSetting("BACKEND_URL");
        this.backendToken = runtime.getSetting("BACKEND_TOKEN");
        this.tgTrader = runtime.getSetting("TG_TRADER"); // boolean To Be added to the settings
        elizaLogger.log("✅ TelegramClient constructor completed");
    }

    public async start(): Promise<void> {
        elizaLogger.log("🚀 Starting Telegram bot...");
        try {
            await this.initializeBot();
            this.setupMessageHandlers();
            this.setupShutdownHandlers();
        } catch (error) {
            elizaLogger.error("❌ Failed to launch Telegram bot:", error);
            throw error;
        }
    }

    private async initializeBot(): Promise<void> {
        this.bot.launch({dropPendingUpdates: true});
        elizaLogger.log(
            "✨ Telegram bot successfully launched and is running!"
        );

        const botInfo = await this.bot.telegram.getMe();
        this.bot.botInfo = botInfo;
        elizaLogger.success(`Bot username: @${botInfo.username}`);

        this.messageManager.bot = this.bot;
    }

    private async isGroupAuthorized(ctx: Context): Promise<boolean> {
        const config = this.runtime.character.clientConfig?.telegram;
        if (ctx.from?.id === ctx.botInfo?.id) {
            return false;
        }

        if (!config?.shouldOnlyJoinInAllowedGroups) {
            return true;
        }

        const allowedGroups = config.allowedGroupIds || [];
        const currentGroupId = ctx.chat.id.toString();

        if (!allowedGroups.includes(currentGroupId)) {
            elizaLogger.info(`Unauthorized group detected: ${currentGroupId}`);
            try {
                await ctx.reply("Not authorized. Leaving.");
                await ctx.leaveChat();
            } catch (error) {
                elizaLogger.error(
                    `Error leaving unauthorized group ${currentGroupId}:`,
                    error
                );
            }
            return false;
        }

        return true;
    }

    private setupMessageHandlers(): void {
        elizaLogger.log("Setting up message handler...");

        this.bot.on(message("new_chat_members"), async (ctx) => {
            try {
                const newMembers = ctx.message.new_chat_members;
                const isBotAdded = newMembers.some(
                    (member) => member.id === ctx.botInfo.id
                );

                if (isBotAdded && !(await this.isGroupAuthorized(ctx))) {
                    return;
                }

                // Track new members
                if (!isBotAdded) {
                    for (const member of newMembers) {
                        await trackNewMember(ctx.chat.id.toString(), {
                            id: member.id.toString(),
                            username: member.username || '',
                            firstName: member.first_name,
                            lastName: member.last_name,
                            joinedAt: Date.now()
                        });
                    }
                }
            } catch (error) {
                elizaLogger.error("Error handling new chat members:", error);
            }
        });

        this.bot.on("my_chat_member", async (ctx) => {
            const update = ctx.update as Update.MyChatMemberUpdate;
            const newMember = update.my_chat_member.new_chat_member;
            if (newMember.user.id === ctx.botInfo.id) {
                const chat = update.my_chat_member.chat;
                const user = update.my_chat_member.from;

                if (chat.type != 'private') {
                    try {
                        const userGroupsKey = `user:${user.id}:groups`
                        const usernameMappingKey = `username_map:${user.username?.toLowerCase()}`
                        const groupData = {
                            id: chat.id,
                            title: chat.title || 'Untitled Group',
                            type: chat.type,
                            addedBy: user.id,
                            addedAt: new Date().toISOString()
                        }
                        await redis.multi()
                            .hset(`group:${chat.id}`, groupData)
                            .sadd(userGroupsKey, chat.id.toString())
                            .zadd(`user:${user.id}:groups:ordered`, Date.now(), chat.id.toString())
                            .set(usernameMappingKey, user.id.toString())
                            .exec();

                        if (user.username) {
                            await redis.hset(
                                `user:${user.id}:usernames`,
                                'current', user.username.toLowerCase(),
                                'last_updated', new Date().toISOString()
                            )
                        }

                        console.log(`Group ${chat.id} saved for user ${user.id}`)
                    } catch (e) {
                        console.error(e)
                    }
                }
            }
        });


        this.bot.on("message", async (ctx) => {
            try {
                if (!(await this.isGroupAuthorized(ctx))) {
                    return;
                }

                if (ctx.message.chat.type === "private") {
                    try {
                        const userId = ctx.message.from.id;
                        const chatId = ctx.message.chat.id;

                        await redis.set(`user:${userId}:private_chat_id`, chatId.toString());
                        console.log(`Saved private chat id ${chatId} for user ${userId}`)
                    } catch (e){
                        console.error(e)
                    }
                }

                if (ctx.message.chat.type !== "private") {
                    try {
                        const message = ctx.message
                        const chatId = ctx.chat.id
                        const messageId = message.message_id
                        const messageData = {
                            id: messageId,
                            text: (message as any).text || '',
                            from: message.from.id,
                            username: message.from.username || message.from.first_name + ' ' + message.from.last_name || '',
                            date: new Date(message.date * 1000).toISOString()
                        }

                        await redis.multi()
                            .hset(`group:${chatId}:message:${messageId}`, messageData)
                            .zadd(`group:${chatId}:messages`, message.date, messageId.toString())
                            .zadd(`group:${chatId}:user:${message.from.id}:messages`, message.date, messageId.toString())
                            .exec();
                    } catch (error) {
                        console.error(error)
                    }
                    redis.rpush(`group_messages:${ctx.message.chat.id}`, JSON.stringify({
                        userId: ctx.message.from.id,
                        text: (ctx.message as any).text,
                        timestamp: Date.now(),
                        title: ctx.message.chat.title
                    }));

                    redis.set(`group_name:${ctx.message.chat.title}`, ctx.message.chat.id)

                    markMentionsAsRead(ctx.from.id, ctx.chat.id);
                    handleMention(ctx)

                }



                if (this.tgTrader) {
                    const userId = ctx.from?.id.toString();
                    const username =
                        ctx.from?.username || ctx.from?.first_name || "Unknown";
                    if (!userId) {
                        elizaLogger.warn(
                            "Received message from a user without an ID."
                        );
                        return;
                    }
                    try {
                        await getOrCreateRecommenderInBe(
                            userId,
                            username,
                            this.backendToken,
                            this.backend
                        );
                    } catch (error) {
                        console.error(
                            "Error getting or creating recommender in backend",
                            error
                        );
                    }
                }

                await this.messageManager.handleMessage(ctx);
            } catch (error) {
                console.error("❌ Error handling message:", error);
                // Don't try to reply if we've left the group or been kicked
                if (error?.response?.error_code !== 403) {
                    try {
                        await ctx.reply(
                            "An error occurred while processing your message."
                        );
                    } catch (replyError) {
                        console.error(
                            "Failed to send error message:",
                            replyError
                        );
                    }
                }
            }
        });

        this.bot.on("photo", (ctx) => {
            elizaLogger.log(
                "📸 Received photo message with caption:",
                ctx.message.caption
            );
        });

        this.bot.on("document", (ctx) => {
            elizaLogger.log(
                "📎 Received document message:",
                ctx.message.document.file_name
            );
        });

        this.bot.catch((err, ctx) => {
            elizaLogger.error(`❌ Telegram Error for ${ctx.updateType}:`, err);
            ctx.reply("An unexpected error occurred. Please try again later.");
        });
    }

    private setupShutdownHandlers(): void {
        const shutdownHandler = async (signal: string) => {
            elizaLogger.log(
                `⚠️ Received ${signal}. Shutting down Telegram bot gracefully...`
            );
            try {
                await this.stop();
                elizaLogger.log("🛑 Telegram bot stopped gracefully");
            } catch (error) {
                elizaLogger.error(
                    "❌ Error during Telegram bot shutdown:",
                    error
                );
                throw error;
            }
        };

        process.once("SIGINT", () => shutdownHandler("SIGINT"));
        process.once("SIGTERM", () => shutdownHandler("SIGTERM"));
        process.once("SIGHUP", () => shutdownHandler("SIGHUP"));
    }

    public async stop(): Promise<void> {
        elizaLogger.log("Stopping Telegram bot...");
        //await 
        this.bot.stop();
        elizaLogger.log("Telegram bot stopped");
    }
}
