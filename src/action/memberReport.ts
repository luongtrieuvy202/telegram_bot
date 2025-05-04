import {Action, IAgentRuntime, Memory, State, HandlerCallback, generateText, ModelClass} from "@elizaos/core";
import redis from "../redis/redis.ts";
import {Context} from "telegraf";
import {Update} from "telegraf/types";
import {getGroupsByUserId, callOpenRouterText} from "./utils.ts";

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
    console.log(memberKey)
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
    
    // Get all member IDs
    const members = await redis.zrange(memberSetKey, 0, -1);
    console.log('Found all members:', members);
    
    if (members.length === 0) {
        return [];
    }

    // Get all member keys
    const memberKeys = await redis.keys(`group:${groupId}:new_members:*`);
    console.log('Found member keys:', memberKeys);
    
    // Get member data for each key
    const memberData: MemberInfo[] = [];
    for (const key of memberKeys) {
        const data = await redis.hgetall(key);
        if (data && data.id && members.includes(data.id)) {
            memberData.push({
                id: data.id,
                username: data.username || '',
                firstName: data.firstName,
                lastName: data.lastName,
                joinedAt: parseInt(data.joinedAt)
            });
        }
    }

    // Sort by join time
    return memberData.sort((a, b) => b.joinedAt - a.joinedAt);
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

async function extractReportIntent(runtime: IAgentRuntime, message: Memory): Promise<{
    targetGroup?: string;
    period: string;
    startTime: number;
}> {
    const intentPrompt = `You are a JSON-only response bot. Your task is to analyze a message and determine the user's intent for member reporting.

Message: "${message.content.text}"

Consider these scenarios:
1. Specific group report:
   - "Show new members in [group name]"
   - "Who joined [group name] recently?"
   - "Member report for [group name]"

2. All groups report:
   - "Show new members in all groups"
   - "Who joined recently?"
   - "Member report for all groups"
   - "Is there any new member?"
   - "Did anyone join today?"
   - "Any new members this week?"

3. Time period:
   - "today" or "recently" -> last 24 hours
   - "this week" -> last 7 days
   - "this month" -> last 30 days
   - no specific time mentioned -> last 24 hours

Return ONLY a JSON object with this exact structure:
{
    "targetGroup": string | null,
    "period": "day" | "week" | "month",
    "startTime": number
}

Example responses:
{
    "targetGroup": "My Group",
    "period": "day",
    "startTime": 1745484575018
}

{
    "targetGroup": null,
    "period": "week",
    "startTime": 1745484575018
}

Do not include any other text or explanation. Only return the JSON object.`;

    const response = await callOpenRouterText({
        prompt: intentPrompt,
        model: 'google/gemini-2.0-flash-001'
    });

    console.log('Intent analysis response:', response);

    try {
        // Clean the response to ensure it's valid JSON
        const cleanedResponse = response.trim().replace(/^[^{]*/, '').replace(/[^}]*$/, '');
        const result = JSON.parse(cleanedResponse);
        
        const now = Date.now();
        const DAY = 24 * 60 * 60 * 1000;
        const WEEK = 7 * DAY;
        const MONTH = 30 * DAY;

        // Ensure we have valid values
        return {
            targetGroup: result.targetGroup || null,
            period: result.period || 'day',
            startTime: result.startTime || (now - DAY)
        };
    } catch (error) {
        console.error('Failed to parse intent analysis:', error);
        // Return default values if parsing fails
        return {
            targetGroup: null,
            period: 'day',
            startTime: Date.now() - (24 * 60 * 60 * 1000)
        };
    }
}

function generateMemberReportResponse(
    members: MemberInfo[],
    period: string,
    groupName?: string
): string {
    if (members.length === 0) {
        return `I don't see any new members who joined ${groupName ? `in ${groupName} ` : ''}during this ${period}.`;
    }

    // Group members by time periods for better readability
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;
    const DAY = 24 * HOUR;

    // Remove duplicates based on member ID
    const uniqueMembers = Array.from(new Map(members.map(m => [m.id, m])).values());

    // Sort by join time (most recent first)
    const sortedMembers = uniqueMembers.sort((a, b) => b.joinedAt - a.joinedAt);

    // Group members by time period
    const recentMembers = sortedMembers.filter(m => now - m.joinedAt < HOUR);
    const todayMembers = sortedMembers.filter(m => now - m.joinedAt >= HOUR && now - m.joinedAt < DAY);
    const olderMembers = sortedMembers.filter(m => now - m.joinedAt >= DAY);

    const formatMemberList = (memberList: MemberInfo[]) => {
        return memberList
            .map(m => `• @${m.username || m.firstName} (joined ${formatTimeAgo(m.joinedAt)})`)
            .join("\n");
    };

    const parts: string[] = [];

    // Add welcoming message
    parts.push(`Welcome to our new members! 👋`);

    // Add recent members if any
    if (recentMembers.length > 0) {
        parts.push(`\n🕒 Recently joined (${recentMembers.length}):`);
        parts.push(formatMemberList(recentMembers));
    }

    // Add today's members if any (excluding recent ones)
    if (todayMembers.length > 0) {
        parts.push(`\n📅 Joined today (${todayMembers.length}):`);
        parts.push(formatMemberList(todayMembers));
    }

    // Add older members if any
    if (olderMembers.length > 0) {
        parts.push(`\n📆 Joined earlier (${olderMembers.length}):`);
        parts.push(formatMemberList(olderMembers));
    }

    // Add total count
    parts.push(`\n📊 Total new members: ${uniqueMembers.length}`);

    return parts.join("\n");
}

export const memberReportAction: Action = {
    name: 'MEMBER_REPORT',
    similes: [],
    description: "Generate reports about new group members",
    validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        if (!state.handle) return false
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
            const [groupIds, groupInfos] = await getGroupsByUserId(ctx.from.id.toString());

            await runtime.messageManager.createMemory({
                content: {
                    text: message.content.text
                },
                roomId: message.roomId,
                userId: message.userId,
                agentId: message.agentId
            });

            const {targetGroup, period, startTime} = await extractReportIntent(runtime, message);
            console.log('Report intent:', { targetGroup, period, startTime });

            if (targetGroup) {
                // Specific group report
                const targetGroupInfo = groupInfos.find(group =>
                    group.title?.toLowerCase() === targetGroup.toLowerCase()
                );

                if (!targetGroupInfo) {
                    await callback({
                        text: `I couldn't find the group "${targetGroup}". Here are the groups you have access to:\n${groupInfos.map(g => g.title).join('\n')}`,
                        action: "MEMBER_REPORT"
                    });
                    return;
                }

                const members = await getMemberReport(targetGroupInfo.id, startTime);
                const reportText = generateMemberReportResponse(members, period, targetGroupInfo.title);
                await callback({
                    text: reportText,
                    action: "MEMBER_REPORT"
                });
            } else {
                // All groups report
                const allReports: { group: string; members: MemberInfo[] }[] = [];
                
                for (const group of groupInfos) {
                    const members = await getMemberReport(group.id, startTime);
                    if (members.length > 0) {
                        allReports.push({
                            group: group.title,
                            members
                        });
                    }
                }

                if (allReports.length === 0) {
                    await callback({
                        text: `I don't see any new members who joined any of your groups during this ${period}.`,
                        action: "MEMBER_REPORT"
                    });
                    return;
                }

                const reportText = allReports.map(report => 
                    `📌 *${report.group}*\n${generateMemberReportResponse(report.members, period)}`
                ).join('\n\n');

                await callback({
                    text: `📋 *All Groups Member Report*\n\n${reportText}`,
                    action: "MEMBER_REPORT"
                });
            }
        } catch (error) {
            console.error('Error in member report handler:', error);
            await callback({
                text: "Sorry, I encountered an error while generating the member report.",
                action: "MEMBER_REPORT"
            });
        }
    },
    examples: []
}; 