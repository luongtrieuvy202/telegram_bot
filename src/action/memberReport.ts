import {Action, IAgentRuntime, Memory, State, HandlerCallback, generateText, ModelClass} from "@elizaos/core";
import redis from "../redis/redis.ts";
import {Context} from "telegraf";
import {Update} from "telegraf/types";

// Redis key patterns:
// group:{groupId}:new_members:{timestamp} -> hash containing member info
// group:{groupId}:members -> sorted set with member IDs and join timestamps

interface MemberInfo {
    id: string;
    username: string;
    firstName: string;
    lastName?: string;
    joinedAt: number;
}

export async function trackNewMember(groupId: string, member: MemberInfo) {
    const now = Date.now();
    const memberKey = `group:${groupId}:new_members:${now}`;
    const memberSetKey = `group:${groupId}:members`;

    await redis.multi()
        .hset(memberKey, {
            ...member,
            joinedAt: now
        })
        .zadd(memberSetKey, now, member.id)
        .exec();
}

async function getMemberReport(groupId: string, startTime: number, endTime: number = Date.now()): Promise<MemberInfo[]> {
    const memberSetKey = `group:${groupId}:members`;
    const members = await redis.zrangebyscore(memberSetKey, startTime, endTime);

    const pipeline = redis.pipeline();
    for (const memberId of members) {
        const memberKeys = await redis.keys(`group:${groupId}:new_members:*`);
        for (const key of memberKeys) {
            pipeline.hgetall(key);
        }
    }

    const results = await pipeline.exec();
    return results
        .map(([err, data]) => data as MemberInfo)
        .filter((data): data is MemberInfo => {
            if (!data) return false;
            const joinedAt = parseInt(data.joinedAt as unknown as string);
            return !isNaN(joinedAt) && joinedAt >= startTime && joinedAt <= endTime;
        });
}

function formatTimeAgo(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / (1000 * 60));
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
    if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
}

async function detectMemberReportIntent(runtime: IAgentRuntime, message: Memory): Promise<boolean> {
    const intentPrompt = `You are a helpful Telegram group assistant. Your task is to understand if the user wants information about new group members.

Analyze the following message and determine if the user is asking about new members. Consider:
- Direct questions about new members
- Questions about recent joiners
- Requests for member information
- Time-based queries (today, this week, this month)

Message: "${message.content.text}"

Respond with one of these exact phrases:
- "YES" if the user is asking about new members
- "NO" if they are not

Only respond with YES or NO.`;

    const response = await generateText({
        runtime,
        context: intentPrompt,
        modelClass: ModelClass.SMALL
    });

    return response.trim().toUpperCase() === "YES";
}

async function extractTimePeriod(runtime: IAgentRuntime, message: Memory): Promise<{
    startTime: number,
    period: string
}> {
    const timePrompt = `Analyze the following message and determine the time period the user is interested in for new members.

Message: "${message.content.text}"

Consider these time periods:
- "today" or "recently" -> last 24 hours
- "this week" -> last 7 days
- "this month" -> last 30 days
- no specific time mentioned -> last 24 hours

Respond with one of these exact phrases:
- "DAY" for last 24 hours
- "WEEK" for last 7 days
- "MONTH" for last 30 days

Only respond with DAY, WEEK, or MONTH.`;

    const response = await generateText({
        runtime,
        context: timePrompt,
        modelClass: ModelClass.SMALL
    });

    console.log(response)

    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const WEEK = 7 * DAY;
    const MONTH = 30 * DAY;

    switch (response.trim().toUpperCase()) {
        case "WEEK":
            return {startTime: now - WEEK, period: "week"};
        case "MONTH":
            return {startTime: now - MONTH, period: "month"};
        default:
            return {startTime: now - DAY, period: "day"};
    }
}

function generateMemberReportResponse(
    members: MemberInfo[],
    period: string
): string {
    if (members.length === 0) {
        return `I don't see any new members who joined during this ${period}.`;
    }

    // Group members by time periods for better readability
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;
    const DAY = 24 * HOUR;

    const recentMembers = members.filter(m => now - m.joinedAt < HOUR);
    const todayMembers = members.filter(m => now - m.joinedAt < DAY);
    const olderMembers = members.filter(m => now - m.joinedAt >= DAY);

    const formatMemberList = (memberList: MemberInfo[]) => {
        return memberList
            .map(m => `@${m.username || m.firstName} (joined ${formatTimeAgo(m.joinedAt)})`)
            .join("\n");
    };

    const parts: string[] = [];

    // Add welcoming message
    parts.push(`Welcome to our new members! 👋`);

    // Add recent members if any
    if (recentMembers.length > 0) {
        parts.push(`\nRecently joined (${recentMembers.length}):`);
        parts.push(formatMemberList(recentMembers));
    }

    // Add today's members if any (excluding recent ones)
    if (todayMembers.length > 0) {
        parts.push(`\nJoined today (${todayMembers.length}):`);
        parts.push(formatMemberList(todayMembers));
    }

    // Add older members if any
    if (olderMembers.length > 0) {
        parts.push(`\nJoined earlier (${olderMembers.length}):`);
        parts.push(formatMemberList(olderMembers));
    }

    // Add total count
    parts.push(`\nTotal new members: ${members.length}`);

    return parts.join("\n");
}

export const memberReportAction: Action = {
    name: 'MEMBER_REPORT',
    similes: [],
    description: "Generate reports about new group members",
    validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        if (!state.handle) return false

        // const isMemberReport = await detectMemberReportIntent(runtime, message);
        // return isMemberReport;
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
        try {
            const ctx = options.ctx as Context<Update>;
            const groupId = ctx.chat.id.toString();

            await runtime.messageManager.createMemory({
                content: {
                    text: message.content.text
                },
                roomId: message.roomId,
                userId: message.userId,
                agentId: message.agentId
            });

            const {startTime, period} = await extractTimePeriod(runtime, message);
            console.log(startTime, period)
            const members = await getMemberReport(groupId, startTime);
            const reportText = generateMemberReportResponse(members, period);

            callback({
                text: reportText,
                action: "MEMBER_REPORT"
            });
        } catch (error) {
            console.error(error)
        }
    },
    examples: []
}; 