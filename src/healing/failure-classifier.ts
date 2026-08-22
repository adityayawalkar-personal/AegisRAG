export type FailureCategory = 'TRANSIENT_RETRYABLE' | 'SCHEMA_CORRUPTED' | 'AUTH_PERMISSION' | 'BLOCKED' | 'FATAL';

export interface ClassificationResult {
  category: FailureCategory;
  isRetryable: boolean;
  shouldHeal: boolean;
  reason: string;
  statusCode?: number;
}

export function classifyFailure(
  errorOrStderr: string | Error,
  statusCode?: number
): ClassificationResult {
  const message = (errorOrStderr instanceof Error ? errorOrStderr.message : String(errorOrStderr)).toLowerCase();

  // 1. Auth & Permission Errors (Standing Rule 4: Stop and report)
  if (
    statusCode === 401 ||
    message.includes('invalid credentials') ||
    message.includes('unauthorized') ||
    message.includes('no api key found')
  ) {
    return {
      category: 'AUTH_PERMISSION',
      isRetryable: false,
      shouldHeal: false,
      reason: 'Authentication or permission fault detected. Privileges cannot be bypassed.',
      statusCode: statusCode || 401,
    };
  }

  // 2. Anti-Bot Challenges, CAPTCHA, or Block Walls (Soft Failure: Route away from heal)
  if (
    statusCode === 403 ||
    message.includes('soft failure') ||
    message.includes('soft_failure') ||
    message.includes('captcha') ||
    message.includes('cloudflare') ||
    message.includes('attention required') ||
    message.includes('just a moment') ||
    message.includes('security check') ||
    message.includes('bot detected') ||
    message.includes('near-duplicate') ||
    message.includes('challenge-platform')
  ) {
    return {
      category: 'BLOCKED',
      isRetryable: true,
      shouldHeal: false, // Bypasses initiateHeal to prevent corrupting selectors on block pages
      reason: 'Anti-bot challenge, CAPTCHA, or block page detected (Soft Failure). Bypassing self-healing loop to prevent selector corruption; route to proxy rotation/backoff.',
      statusCode: statusCode || 403,
    };
  }

  // 3. Transient / Network / Rate Limit Errors (Retry with backoff, DO NOT heal)
  if (
    statusCode === 429 ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504 ||
    message.includes('429') ||
    message.includes('rate limit') ||
    message.includes('too many requests') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    message.includes('socket hang up') ||
    message.includes('gateway')
  ) {
    return {
      category: 'TRANSIENT_RETRYABLE',
      isRetryable: true,
      shouldHeal: false,
      reason: `Transient rate limit or network/server fault (${statusCode || 'timeout/network'}). Heal cannot fix rate limits; retrying with backoff.`,
      statusCode: statusCode || (message.includes('429') ? 429 : 503),
    };
  }

  // 4. Schema & Data Shape Break (Target for Sentinel & Heal Loop)
  if (
    message.includes('schema') ||
    message.includes('missing field') ||
    message.includes('null') ||
    message.includes('json parse error') ||
    message.includes('drift') ||
    message.includes('corrupted')
  ) {
    return {
      category: 'SCHEMA_CORRUPTED',
      isRetryable: false,
      shouldHeal: true,
      reason: 'DOM redesign or schema drift detected. Suitable for Gemma-driven Scraper Studio self-healing.',
      statusCode,
    };
  }

  return {
    category: 'FATAL',
    isRetryable: false,
    shouldHeal: false,
    reason: `Unclassified fatal error: ${message.slice(0, 200)}`,
    statusCode,
  };
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  backoffFactor?: number;
  sleepFn?: (ms: number) => Promise<void>;
}

export async function executeWithTransientRetry<T>(
  action: (attemptNumber: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const backoffFactor = options.backoffFactor ?? 2;
  const sleep = options.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await action(attempt);
    } catch (err: unknown) {
      lastError = err;
      const classification = classifyFailure(err instanceof Error ? err : String(err));

      if (!classification.isRetryable || attempt > maxRetries) {
        throw err;
      }

      const delay = baseDelayMs * Math.pow(backoffFactor, attempt - 1);
      console.warn(
        `[failure-classifier] Transient error on attempt ${attempt}/${maxRetries}: ${classification.reason}. Retrying in ${delay}ms...`
      );
      await sleep(delay);
    }
  }

  throw lastError;
}
