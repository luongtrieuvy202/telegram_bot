import Redis from "ioredis";

const redis = new Redis({
  host: '127.0.0.1', // Redis server address
  port: 6379, // Redis default port
  password: process.env.REDIS_PASSWORD || undefined, // If authentication is needed
  retryStrategy: (times) => Math.min(times * 50, 2000), // Retry strategy
})

redis.on('connect', () => console.log('Connected to Redis'));
redis.on('error', (err) => console.error('Redis error:', err));

export default redis;