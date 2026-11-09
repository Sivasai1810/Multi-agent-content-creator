import {
  APP_NAME,
  DEFAULT_LLM_TIMEOUT,
  DEFAULT_TEMPERATURE,
} from './constants';
import {
  DEFAULT_BACKOFF_DELAY,
  DEFAULT_JOB_TIMEOUT,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_WORKER_CONCURRENCY,
} from '../queue/queue.constants';

// Converts an environment variable to a number.
// Returns the default value if it is missing or not a valid number.
function toNumber(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value === '') {
    return defaultValue;
  }

  const result = Number(value);

  if (Number.isNaN(result)) {
    return defaultValue;
  }

  return result;
}

// Reads all environment variables and groups them by category.
export default function configuration() {
  return {
    app: {
      name: APP_NAME,
      nodeEnv: process.env.NODE_ENV || 'development',
      port: toNumber(process.env.PORT, 3000),
    },

    gemini: {
      apiKey: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL,
      timeout: toNumber(process.env.GEMINI_TIMEOUT, DEFAULT_LLM_TIMEOUT),
      temperature: toNumber(process.env.GEMINI_TEMPERATURE, DEFAULT_TEMPERATURE),
      // Our own limit, kept below the free tier limit. 0 means no limit.
      requestsPerMinute: toNumber(process.env.GEMINI_REQUESTS_PER_MINUTE, 10),
    },

    groq: {
      apiKey: process.env.GROQ_API_KEY,
      model: process.env.GROQ_MODEL,
      timeout: toNumber(process.env.GROQ_TIMEOUT, DEFAULT_LLM_TIMEOUT),
      temperature: toNumber(process.env.GROQ_TEMPERATURE, DEFAULT_TEMPERATURE),
      requestsPerMinute: toNumber(process.env.GROQ_REQUESTS_PER_MINUTE, 30),
    },

    openrouter: {
      apiKey: process.env.OPENROUTER_API_KEY,
      model: process.env.OPENROUTER_MODEL,
      timeout: toNumber(process.env.OPENROUTER_TIMEOUT, DEFAULT_LLM_TIMEOUT),
      temperature: toNumber(
        process.env.OPENROUTER_TEMPERATURE,
        DEFAULT_TEMPERATURE,
      ),
      requestsPerMinute: toNumber(process.env.OPENROUTER_REQUESTS_PER_MINUTE, 20),
    },

    database: {
      url: process.env.DATABASE_URL,
    },

    redis: {
      host: process.env.REDIS_HOST || 'localhost',
      port: toNumber(process.env.REDIS_PORT, 6379),
      password: process.env.REDIS_PASSWORD || undefined, // optional
      tls: process.env.REDIS_TLS === 'true', // turn on for managed Redis services
    },

    queue: {
      concurrency: toNumber(process.env.QUEUE_CONCURRENCY, DEFAULT_WORKER_CONCURRENCY), // jobs one worker runs at the same time
      maxAttempts: toNumber(process.env.QUEUE_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS), // tries per job before it fails
      backoffDelay: toNumber(process.env.QUEUE_BACKOFF_DELAY, DEFAULT_BACKOFF_DELAY), // first retry wait, in ms
      jobTimeout: toNumber(process.env.QUEUE_JOB_TIMEOUT, DEFAULT_JOB_TIMEOUT), // in ms
    },

    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      chatId: process.env.TELEGRAM_CHAT_ID,
    },

    instagram: {
      accessToken: process.env.INSTAGRAM_ACCESS_TOKEN,
      accountId: process.env.INSTAGRAM_ACCOUNT_ID,
    },
  };
}
