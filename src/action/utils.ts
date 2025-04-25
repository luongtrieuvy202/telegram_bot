import redis from "../redis/redis.ts"
import {Context, NarrowedContext, Telegraf, Markup} from "telegraf";
import {mention} from "telegraf/format";
import {Message, Update} from "telegraf/types";

// Helper function to extract JSON from AI response
export function extractJsonFromResponse(response: string): any {
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

export async function getUserGroupMessages(userId) {
    try {
        const [groupIds, groupInfos]: [string[], Record<string, string>[]] = await getGroupsByUserId(userId)

        if (!groupIds.length) return {};

        const BATCH_SIZE = 10;
        const messageIdResults = []

        for (let i = 0; i < groupIds.length; i += BATCH_SIZE) {
            const batch = groupIds.slice(i, i += BATCH_SIZE)
            const pipeline = redis.pipeline()

            batch.forEach(groupId => {
                pipeline.zrevrange(`group:${groupId}:messages`, 0, -1)
            })

            const batchResults = await pipeline.exec()
            messageIdResults.push(...batchResults)
        }

        const messagesPipeline = redis.pipeline()
        const messageMap = new Map()

        groupIds.forEach((groupId, index) => {
            messageMap.set(groupId, [])
            const messageIds = messageIdResults[index][1] || []

            messageIds.forEach(messageId => {
                messagesPipeline.hgetall(`group:${groupId}:message:${messageId}`)
                messageMap.get(groupId).push({messageId});
            })
        })

        const allMessages = await messagesPipeline.exec()

        let messageIndex = 0;
        const result = {}
        groupIds.forEach((groupId, groupIndex) => {
            const groupMessages = messageMap.get(groupId)
            result[groupId] = {
                groupInfo: groupInfos[groupIndex],
                message: []
            }

            for (let i = 0; i < groupMessages.length; i++) {
                const messageData = allMessages[messageIndex++][1]
                if (messageData) {
                    result[groupId].message.push(messageData)
                }
            }
        })

        return result

    } catch (error) {
        console.error('Error getting user group messages:', error)
    }
}

export async function getGroupsByUserId(userId): Promise<[string[], Record<string, string>[]]> {
    const [[, groupIds]] = await redis
        .multi()
        .smembers(`user:${userId}:groups`)
        .exec() as [[null, string[]]];


    if (!(groupIds as any).length) return [[], []] as [string[], Record<string, string>[]];
    ;


    const pipeline = redis.pipeline();
    (groupIds as any).forEach((groupId) => {
        pipeline.hgetall(`group:${groupId}`)
    })

    const groupInfos = await pipeline.exec() as [null, Record<string, string>][];
    return [groupIds, groupInfos.map(([, info]) => info)]
}

export async function checkForResponse(chatId, responderId) {
    const mentionKey = `chat:${chatId}:mentions:pending`

    const pendingMentions = await redis.zrange(mentionKey, 0, -1, 'WITHSCORES')

    for (const [mention, timestamp] of pendingMentions) {
        const [mentionedId, messageId] = mention.split(':')

        if (mentionedId == responderId) {
            await redis.multi()
                .hset(`mention:${chatId}:${messageId}`, 'status', 'responded')
                .zrem(mentionKey, mention)
                .zrem(`user:${mentionedId}:pending_mentions`, `${chatId}:${messageId}`)
                .exec();
        }
    }
}


export async function trackMention(mentionerId, mentionedId, chatId, messageId, text, title, timestamp) {
    const mentionKey = `chat:${chatId}:mentions:pending`;
    const userMentionKey = `user:${mentionedId}:pending_mentions`

    const mentionData = {
        mentioner: mentionerId,
        mentionedId: mentionedId,
        chat: chatId,
        message: messageId,
        text: text,
        timestamp: timestamp,
        title: title,
        status: 'unresponded'
    }

    await redis.multi()
        .hset(`mention:${chatId}:${messageId}`, mentionData)
        .zadd(mentionKey, timestamp, `${mentionedId}:${messageId}`)
        .zadd(userMentionKey, timestamp, `${chatId}:${messageId}`)
        .exec()
}

// export async function checkMentionTimeouts(bot: Telegraf) {

//     const now = Date.now();
//     const timeoutDuration = 24 * 60 * 60 * 1000; // 24 hours

//     // Find all users with pending mentions
//     const userKeys = await redis.keys('user:*:pending_mentions');
//     for (const userKey of userKeys) {
//         const userId = userKey.split(':')[1];
//         const mentions = await redis.zrange(userKey, 0, -1, 'WITHSCORES');
//         for (const mention of mentions) {
//             if (true) {
//                 console.log(mention)
//                 const [chatId, messageId] = mention.split(':');
//                 // Get the original mention details
//                 const mentionData = await redis.hgetall(`mention:${chatId}:${messageId}`);
//                 console.log(mentionData)
//                 if (mentionData.status === 'unresponded') {
//                     await handleUnrespondedMention(mentionData, bot);
//                     await redis.zrem(userKey, mention); // Remove from sorted set
//                     await redis.del(`mention:${chatId}:${messageId}`); // Delete the hash
//                 }
//             }
//         }
//     }
// }


// export async function handleUnrespondedMention(mention, bot) {
//     try {
//         try {
//             console.log(mention)
//             const privateChatId = await redis.get(`user:${mention.mentionedId}:private_chat_id`);

//             if (privateChatId) {
//                 const messageLink = `https://t.me/c/${mention.chat.replace('-100', '')}/${mention.message}`;
//                 const escapedChatName = mention.chat.replace(/([_*\[\]()~`>#+-=|{}.!])/g, '\\$1');
//                 await (bot as Telegraf).telegram.sendMessage(
//                     privateChatId,
//                     `You were mentioned by someone but didn't respond Here's the [${mention.text}](${messageLink}) `
//                     , {
//                         parse_mode: 'MarkdownV2'
//                     }
//                 )
//             } else {
//                 console.log(`could not DM user ${mention.mentioned}, trying group mention`)
//                 await (bot as Telegraf).telegram.sendMessage(
//                     mention.chat,
//                     `@${mention.mentioned} you were mentioned here earlier but didn't respond!`,
//                 )
//             }
//         } catch (e) {
//             console.log(e)
//         }
//     } catch (error) {
//         console.error('Notification failed:', error)
//     }
// }


export async function checkMentionTimeouts(bot: Telegraf) {
    const userKeys = await redis.keys('user:*:pending_mentions');

    for (const userKey of userKeys) {
        const userId = userKey.split(':')[1];
        const mentions = await redis.zrange(userKey, 0, -1, 'WITHSCORES');

        // Group mentions by user and collect data
        const mentionsToNotify = [];
        const mentionsToDelete = [];

        for (const mention of mentions) {
            const [chatId, messageId] = mention.split(':');
            const mentionData = await redis.hgetall(`mention:${chatId}:${messageId}`);

            if (mentionData.status === 'unresponded') {
                mentionsToNotify.push(mentionData);
                mentionsToDelete.push({
                    userKey,
                    mentionKey: mention,
                    hashKey: `mention:${chatId}:${messageId}`
                });
            }
        }

        // If we have mentions to notify
        if (mentionsToNotify.length > 0) {
            try {
                await handleUnrespondedMentions(userId, mentionsToNotify, bot);

                // Clean up all processed mentions
                const pipeline = redis.pipeline();
                for (const {userKey, mentionKey, hashKey} of mentionsToDelete) {
                    pipeline.zrem(userKey, mentionKey);
                    pipeline.del(hashKey);
                }
                await pipeline.exec();
            } catch (error) {
                console.error('Failed to handle mentions:', error);
            }
        }
    }
}


/**
 * Custom function to create a MarkdownV2 link
 */
function markdownLink(text: string, url: string): string {
    return `[${escapeMarkdownV2(text)}](${url})`;
}

/**
 * Escapes text for MarkdownV2 formatting
 */
function escapeMarkdownV2(text: string): string {
    if (!text) return '';
    const escapeChars = '_*[]()~`>#+-=|{}.!';
    return text.split('').map(char =>
        escapeChars.includes(char) ? `\\${char}` : char
    ).join('');
}

export async function handleUnrespondedMentions(userId: string, mentions: any[], bot: any) {
    try {
        const privateChatId = await redis.get(`user:${userId}:private_chat_id`);

        if (privateChatId) {
            // Format all mentions into one message
            let message = `You have ${mentions.length} unresponded mention${mentions.length > 1 ? 's' : ''}:\n\n`;

            for (const mention of mentions) {
                const messageLink = `https://t.me/c/${mention.chat.replace('-100', '')}/${mention.message}`;
                const escapedText = escapeMarkdownV2(mention.text || 'message');
                const escapedChat = escapeMarkdownV2(mention.chat);
                const escapedGroup = escapeMarkdownV2(mention.title || '')

                message += `• [${escapedText}](${messageLink}) in group \`${escapedGroup}\`\n`;
            }

            await bot.telegram.sendMessage(
                privateChatId,
                message,
                {
                    parse_mode: 'MarkdownV2',
                    disable_web_page_preview: true
                }
            );
        } else {
            // Fallback to group mentions
            const mentionsByChat: Record<string, any[]> = {};
            for (const mention of mentions) {
                if (!mentionsByChat[mention.chat]) {
                    mentionsByChat[mention.chat] = [];
                }
                mentionsByChat[mention.chat].push(mention);
            }

            for (const [chatId, chatMentions] of Object.entries(mentionsByChat)) {
                try {
                    await bot.telegram.sendMessage(
                        chatId,
                        `@${escapeMarkdownV2(mentions[0].mentioned)} you have ${chatMentions.length} unresponded mention${chatMentions.length > 1 ? 's' : ''} here!`,
                        {parse_mode: 'HTML'}
                    );
                } catch (groupError) {
                    console.error(`Failed to notify in group ${chatId}:`, groupError);
                }
            }
        }
    } catch (error) {
        console.error('Notification failed:', error);
        throw error; // Re-throw to handle in calling function
    }
}

export async function handleMention(ctx: NarrowedContext<Context<Update>, Update.MessageUpdate<Message>>) {
    if (!(ctx.message as any).entities) return;
    const entities = (ctx.message as any).entities
    for (const entity of entities) {
        if (entity.type === 'mention' || entity.type === 'text_mention') {
            let mentionedId;

            // Resolve mention to user ID
            if (entity.type === 'mention') {
                const username = (ctx.message as any).text.substring(
                    entity.offset + 1, // Skip @
                    entity.offset + entity.length
                ).toLowerCase();
                mentionedId = await redis.get(`username_map:${username}`);
            } else {
                mentionedId = entity.user.id;
            }


            const isMentionerValid = await redis.exists(`user:${ctx.from.id}:groups`);
            const isMentionedValid = await redis.exists(`user:${mentionedId}:groups`);

            if (isMentionerValid || isMentionedValid) {
                console.log(`Insert mention message`)
                await trackMention(
                    ctx.from.id,
                    mentionedId,
                    ctx.chat.id,
                    ctx.message.message_id,
                    (ctx.message as any).text,
                    (ctx.message.chat as any).title,
                    Date.now()
                );
            } else {
                console.log(`Skipping mention - users not in tracking system:`, {
                    mentioner: ctx.from.id,
                    mentioned: mentionedId,
                    valid: {mentioner: isMentionerValid, mentioned: isMentionedValid}
                });
            }
        }
    }
}

export async function markMentionsAsRead(userId, chatId) {
    try {
        const userMentionKey = `user:${userId}:pending_mentions`;
        const mentionsInChat = await redis.zrangebyscore(
            userMentionKey,
            '-inf',
            '+inf',
            'WITHSCORES');

        for (let i = 0; i < mentionsInChat.length; i += 1) {
            const mentionRef = mentionsInChat[i];
            const [mentionChatId, messageId] = mentionRef.split(':');

            // If this mention is in the current chat, mark it as read
            if (mentionChatId === chatId.toString()) {
                console.log(`Marking mention as read: ${mentionRef}`);

                // Update the mention status
                await redis.hset(`mention:${chatId}:${messageId}`, 'status', 'read');

                // Remove from pending mentions
                await redis.zrem(userMentionKey, mentionRef);
                await redis.zrem(`chat:${chatId}:mentions:pending`, `${userId}:${messageId}`);
            }
        }
        console.log(`Processed read status for user ${userId} in chat ${chatId}`);
    } catch (e) {
        console.error(e)
    }
}

export async function filterImportantMentions(mentionMessages) {
    try {
        // Prepare the messages for batch classification
        const messagesForAnalysis = mentionMessages.map(mention => ({
            id: `${mention.chat}:${mention.message}`,
            text: mention.messageText || "Unknown message content"
        }));

        // Create a prompt for classification
        const prompt = `
        You are an AI assistant helping to identify important mentions in a chat app that require a response.
        Below is a list of messages where users were mentioned. For each message, determine if it requires 
        a response (important) or if it's just an FYI mention (not important).
        
        Classify as IMPORTANT if the message:
        - Contains a direct question
        - Requests information, action, or feedback
        - Involves scheduling or deadlines
        - Asks for a decision or approval
        - Contains task assignments
        
        Classify as NOT IMPORTANT if the message:
        - Is just sharing information (FYI)
        - Is a casual greeting or mention
        - Is tagging someone in a response to someone else
        - Is a "thank you" or acknowledgment
        
        For each message, respond with ONLY the message ID followed by either "IMPORTANT" or "NOT IMPORTANT".
        
        Messages to classify:
        ${messagesForAnalysis.map(msg => `ID: ${msg.id}\nMessage: ${msg.text}\n`).join('\n')}
        `;

        const response: any = '';

        // Parse the response to extract classifications
        const classifications = response.data.choices[0].text.trim().split('\n');

        // Create a map of message IDs to importance
        const importantMentions = {};
        classifications.forEach(line => {
            if (line.includes("IMPORTANT")) {
                const id = line.split(' ')[0].trim();
                importantMentions[id] = true;
            }
        });

        // Filter the original mentions to only return important ones
        return mentionMessages.filter(mention => {
            const mentionId = `${mention.chat}:${mention.message}`;
            return importantMentions[mentionId] === true;
        });
    } catch (error) {
        console.error("Error classifying mentions with OpenAI:", error);
        // Fallback: return all mentions if the API call fails
        return mentionMessages;
    }
}


  