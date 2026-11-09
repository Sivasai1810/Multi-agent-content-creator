// Checks the environment variables when the app starts.
// If something is wrong, the app stops and shows all the problems at once.

const VALID_ENVIRONMENTS = ['development', 'production', 'test'];

const LLM_API_KEYS = ['GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY'];

const PORT_VARIABLES = ['PORT', 'REDIS_PORT'];

// These must be whole numbers when they are set
const WHOLE_NUMBER_VARIABLES = [
  'QUEUE_CONCURRENCY',
  'QUEUE_MAX_ATTEMPTS',
  'QUEUE_BACKOFF_DELAY',
  'QUEUE_JOB_TIMEOUT',
  'GEMINI_REQUESTS_PER_MINUTE',
  'GROQ_REQUESTS_PER_MINUTE',
  'OPENROUTER_REQUESTS_PER_MINUTE',
];

// These are only required when NODE_ENV is production.
const PRODUCTION_REQUIRED_VARIABLES = [
  'DATABASE_URL',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'INSTAGRAM_ACCESS_TOKEN',
  'INSTAGRAM_ACCOUNT_ID',
];

// A value with only spaces counts as empty.
function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === '';
}

export function validateEnv(config: Record<string, unknown>) {
  const errors: string[] = [];

  // Check the environment name
  const nodeEnv = String(config.NODE_ENV || 'development');

  if (!VALID_ENVIRONMENTS.includes(nodeEnv)) {
    errors.push(
      `NODE_ENV must be one of: ${VALID_ENVIRONMENTS.join(', ')}. Got: "${nodeEnv}"`,
    );
  }

  // Check the ports. If one is not set, its default port is used.
  for (const name of PORT_VARIABLES) {
    if (config[name] !== undefined && config[name] !== '') {
      const port = Number(config[name]);

      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        errors.push(
          `${name} must be a whole number between 1 and 65535. Got: "${config[name]}"`,
        );
      }
    }
  }

  // Check the number settings. If one is not set, its default is used.
  for (const name of WHOLE_NUMBER_VARIABLES) {
    if (config[name] !== undefined && config[name] !== '') {
      const value = Number(config[name]);

      if (!Number.isInteger(value) || value < 0) {
        errors.push(`${name} must be a whole number of 0 or more. Got: "${config[name]}"`);
      }
    }
  }

  // REDIS_TLS is optional, but it must be true or false when it is set
  if (!isEmpty(config.REDIS_TLS) && config.REDIS_TLS !== 'true' && config.REDIS_TLS !== 'false') {
    errors.push(`REDIS_TLS must be true or false. Got: "${config.REDIS_TLS}"`);
  }

  // Any one LLM provider is enough, so each single key stays optional.
  const hasLlmKey = LLM_API_KEYS.some((key) => !isEmpty(config[key]));

  if (!hasLlmKey) {
    errors.push(`At least one LLM API key is required: ${LLM_API_KEYS.join(', ')}`);
  }

  // Check the variables that production needs
  if (nodeEnv === 'production') {
    for (const name of PRODUCTION_REQUIRED_VARIABLES) {
      if (isEmpty(config[name])) {
        errors.push(`${name} is required in production`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid environment variables:\n- ${errors.join('\n- ')}`);
  }

  return config;
}
