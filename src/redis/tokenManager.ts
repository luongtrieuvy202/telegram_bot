import redis from "./redis.ts";
import { elizaLogger } from "@elizaos/core";

const TOKEN_LIMIT = 1000000; // 1M tokens limit
const TOKEN_RESET_INTERVAL = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds

export async function checkTokenLimit(userId: string): Promise<boolean> {
    try {
        const usage = await getTokenUsage(userId);
        return usage < TOKEN_LIMIT;
    } catch (error) {
        elizaLogger.error("Error checking token limit:", error);
        return false;
    }
}

export async function updateTokenUsage(userId: string, tokens: number): Promise<void> {
    try {
        const key = `user:${userId}:token_usage`;
        const now = Date.now();
        
        // Get current usage
        const currentUsage = await getTokenUsage(userId);
        
        // Check if we need to reset (30-day interval)
        const lastReset = await redis.get(`user:${userId}:token_reset`);
        if (!lastReset || (now - parseInt(lastReset)) > TOKEN_RESET_INTERVAL) {
            // Reset usage
            await redis.set(key, "0");
            await redis.set(`user:${userId}:token_reset`, now.toString());
            elizaLogger.info(`Reset token usage for user ${userId} after 30 days`);
        }
        
        // Update usage
        await redis.incrby(key, tokens);
        
        // Log usage for monitoring
        await redis.zadd(`user:${userId}:token_history`, now, JSON.stringify({
            tokens,
            timestamp: now,
            total: currentUsage + tokens
        }));

        // Set expiry for the token usage key (30 days)
        await redis.expire(key, 30 * 24 * 60 * 60);
    } catch (error) {
        elizaLogger.error("Error updating token usage:", error);
    }
}

export async function getTokenUsage(userId: string): Promise<number> {
    try {
        const usage = await redis.get(`user:${userId}:token_usage`);
        return usage ? parseInt(usage) : 0;
    } catch (error) {
        elizaLogger.error("Error getting token usage:", error);
        return 0;
    }
}

export async function resetTokenUsage(userId: string): Promise<void> {
    try {
        const key = `user:${userId}:token_usage`;
        await redis.set(key, "0");
        await redis.set(`user:${userId}:token_reset`, Date.now().toString());
        elizaLogger.info(`Manually reset token usage for user ${userId}`);
    } catch (error) {
        elizaLogger.error("Error resetting token usage:", error);
    }
}

export async function getTokenHistory(userId: string, limit: number = 10): Promise<any[]> {
    try {
        const history = await redis.zrange(`user:${userId}:token_history`, -limit, -1, 'WITHSCORES');
        return history.map((item, index) => {
            if (index % 2 === 0) {
                return JSON.parse(item);
            }
            return null;
        }).filter(Boolean);
    } catch (error) {
        elizaLogger.error("Error getting token history:", error);
        return [];
    }
}

async function updateTokenUsageFromInput(userId: string, input: string): Promise<void> {
    try {
        // Calculate approximate token count
        // GPT models typically use ~4 characters per token
        const estimatedTokens = Math.ceil(input.length / 4);
        
        // Get current usage
        const currentUsage = await getTokenUsage(userId);
        
        // Check if we need to reset (24-hour interval)
        const now = Date.now();
        const lastReset = await redis.get(`user:${userId}:token_reset`);
        if (!lastReset || (now - parseInt(lastReset)) > TOKEN_RESET_INTERVAL) {
            // Reset usage
            await redis.set(`user:${userId}:token_usage`, "0");
            await redis.set(`user:${userId}:token_reset`, now.toString());
        }
        
        // Update usage
        await redis.incrby(`user:${userId}:token_usage`, estimatedTokens);
        
        // Log usage for monitoring
        await redis.zadd(`user:${userId}:token_history`, now, JSON.stringify({
            tokens: estimatedTokens,
            timestamp: now,
            total: currentUsage + estimatedTokens,
            input: input.substring(0, 100) // Store first 100 chars for reference
        }));
        
        // Set expiry for the token usage key (30 days)
        await redis.expire(`user:${userId}:token_usage`, 30 * 24 * 60 * 60);
        
        // Log the update
        elizaLogger.info(`Updated token usage for user ${userId}: +${estimatedTokens} tokens (total: ${currentUsage + estimatedTokens})`);
    } catch (error) {
        elizaLogger.error(`Error updating token usage for user ${userId}:`, error);
        throw error;
    }
}