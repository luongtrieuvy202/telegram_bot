import { Action, IAgentRuntime, Memory, State, HandlerCallback, generateText, ModelClass } from "@elizaos/core";
import redis from "../redis/redis.ts";
import { Context } from "telegraf";
import { Update } from "telegraf/types";

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

function generateReportText(members: MemberInfo[], period: string): string {
    if (members.length === 0) {
        return `No new members joined during this ${period}.`;
    }

    const memberList = members
        .map(m => `@${m.username || m.firstName}`)
        .join(", ");

    return `New members who joined during this ${period} (${members.length}): ${memberList}`;
}

export const memberReportAction: Action = {
    name: 'MEMBER_REPORT',
    similes: [],
    description: "Generate reports about new group members",
    validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        const text = message.content.text.toLowerCase();
        return text.includes("new members") || 
               text.includes("member report") ||
               text.includes("who joined");
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
        const text = message.content.text.toLowerCase();
        const groupId = ctx.chat.id.toString();
        
        const now = Date.now();
        const DAY = 24 * 60 * 60 * 1000;
        const WEEK = 7 * DAY;
        const MONTH = 30 * DAY;

        let startTime = now - DAY; // Default to daily report
        let period = "day";

        if (text.includes("weekly") || text.includes("week")) {
            startTime = now - WEEK;
            period = "week";
        } else if (text.includes("monthly") || text.includes("month")) {
            startTime = now - MONTH;
            period = "month";
        }

        const members = await getMemberReport(groupId, startTime);
        const reportText = generateReportText(members, period);

        callback({
            text: reportText,
            action: "MEMBER_REPORT"
        });
    },
    examples: []
}; 