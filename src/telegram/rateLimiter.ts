import redis from "../redis/redis.ts";
import { elizaLogger } from "@elizaos/core";

interface RateLimitConfig {
    maxMessages: number;  // Maximum number of messages allowed
    timeWindow: number;   // Time window in milliseconds
    cooldownPeriod: number; // Cooldown period in milliseconds after limit is reached
}

const DEFAULT_CONFIG: RateLimitConfig = {
    maxMessages: 5,      // 5 messages
    timeWindow: 60000,   // per minute
    cooldownPeriod: 300000 // 5 minutes cooldown
};

export class RateLimiter {
    private config: RateLimitConfig;

    constructor(config: Partial<RateLimitConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    private getKey(userId: string): string {
        return `rate_limit:${userId}`;
    }

    private getCooldownKey(userId: string): string {
        return `rate_limit_cooldown:${userId}`;
    }

    async isRateLimited(userId: string): Promise<boolean> {
        try {
            // Check if user is in cooldown
            const cooldownKey = this.getCooldownKey(userId);
            const cooldown = await redis.get(cooldownKey);
            if (cooldown) {
                return true;
            }

            // Get current message count
            const key = this.getKey(userId);
            const count = await redis.get(key);
            const currentCount = count ? parseInt(count) : 0;

            if (currentCount >= this.config.maxMessages) {
                // Set cooldown period
                await redis.setex(cooldownKey, this.config.cooldownPeriod / 1000, '1');
                return true;
            }

            return false;
        } catch (error) {
            elizaLogger.error("Error checking rate limit:", error);
            return false; // Fail open in case of errors
        }
    }

    async incrementMessageCount(userId: string): Promise<void> {
        try {
            const key = this.getKey(userId);
            const multi = redis.multi();
            
            // Increment message count
            multi.incr(key);
            
            // Set expiry if it's the first message
            multi.expire(key, this.config.timeWindow / 1000);
            
            await multi.exec();
        } catch (error) {
            elizaLogger.error("Error incrementing message count:", error);
        }
    }

    async getRemainingMessages(userId: string): Promise<number> {
        try {
            const key = this.getKey(userId);
            const count = await redis.get(key);
            const currentCount = count ? parseInt(count) : 0;
            return Math.max(0, this.config.maxMessages - currentCount);
        } catch (error) {
            elizaLogger.error("Error getting remaining messages:", error);
            return 0;
        }
    }

    async getCooldownTime(userId: string): Promise<number> {
        try {
            const cooldownKey = this.getCooldownKey(userId);
            const ttl = await redis.ttl(cooldownKey);
            return Math.max(0, ttl * 1000); // Convert to milliseconds
        } catch (error) {
            elizaLogger.error("Error getting cooldown time:", error);
            return 0;
        }
    }
} 