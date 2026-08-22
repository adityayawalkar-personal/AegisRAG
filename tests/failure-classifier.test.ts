import { describe, it, expect, vi } from 'vitest';
import { classifyFailure, executeWithTransientRetry } from '../src/healing/failure-classifier.js';

describe('Failure Classifier & Transient Retry Loop', () => {
  it('classifies 429 rate limits, 503s, and timeouts as TRANSIENT_RETRYABLE (no heal)', () => {
    const rateLimit = classifyFailure('Rate limit exceeded (HTTP 429)', 429);
    expect(rateLimit.category).toBe('TRANSIENT_RETRYABLE');
    expect(rateLimit.isRetryable).toBe(true);
    expect(rateLimit.shouldHeal).toBe(false);

    const timeout = classifyFailure('ETIMEDOUT: Connection timed out after 30000ms');
    expect(timeout.category).toBe('TRANSIENT_RETRYABLE');
    expect(timeout.isRetryable).toBe(true);
    expect(timeout.shouldHeal).toBe(false);

    const serverErr = classifyFailure('503 Service Unavailable', 503);
    expect(serverErr.category).toBe('TRANSIENT_RETRYABLE');
    expect(serverErr.isRetryable).toBe(true);
  });

  it('classifies authentication and credential faults as AUTH_PERMISSION (halt and report)', () => {
    const authErr = classifyFailure('Error: Invalid credentials. Status: 401');
    expect(authErr.category).toBe('AUTH_PERMISSION');
    expect(authErr.isRetryable).toBe(false);
    expect(authErr.shouldHeal).toBe(false);
  });

  it('classifies anti-bot challenges, CAPTCHAs, and soft failures as BLOCKED (bypasses heal)', () => {
    const blockWall = classifyFailure('Soft failure detected: Output resembles Cloudflare block wall or CAPTCHA (Attention Required! | Cloudflare)');
    expect(blockWall.category).toBe('BLOCKED');
    expect(blockWall.isRetryable).toBe(true);
    expect(blockWall.shouldHeal).toBe(false); // Does NOT trigger heal
    expect(blockWall.reason).toContain('Anti-bot challenge');

    const captcha = classifyFailure('Security check: Please solve the CAPTCHA to proceed', 403);
    expect(captcha.category).toBe('BLOCKED');
    expect(captcha.shouldHeal).toBe(false);
  });

  it('classifies DOM redesign and schema breaks as SCHEMA_CORRUPTED (route to heal)', () => {
    const schemaErr = classifyFailure('Schema corrupted: missing expected field title');
    expect(schemaErr.category).toBe('SCHEMA_CORRUPTED');
    expect(schemaErr.isRetryable).toBe(false);
    expect(schemaErr.shouldHeal).toBe(true);
  });

  it('executes exponential backoff and succeeds on retryable transient errors', async () => {
    let attempts = 0;
    const mockAction = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error('HTTP 429: Too Many Requests');
      }
      return 'SUCCESS_DATA';
    });

    const sleepFn = vi.fn().mockResolvedValue(undefined);

    const result = await executeWithTransientRetry(mockAction, {
      maxRetries: 3,
      baseDelayMs: 10,
      sleepFn,
    });

    expect(result).toBe('SUCCESS_DATA');
    expect(attempts).toBe(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
  });

  it('fails fast on non-retryable errors without retrying', async () => {
    let attempts = 0;
    const mockAction = vi.fn().mockImplementation(async () => {
      attempts++;
      throw new Error('Invalid credentials. Status: 401');
    });

    const sleepFn = vi.fn().mockResolvedValue(undefined);

    await expect(
      executeWithTransientRetry(mockAction, { maxRetries: 3, sleepFn })
    ).rejects.toThrow('Invalid credentials');

    expect(attempts).toBe(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });
});
