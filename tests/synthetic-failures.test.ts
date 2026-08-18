import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runCollector } from '../src/scraper-runner.js';
import { initSchema, getRunById } from '../src/db/database.js';
import { classifyFailure } from '../src/healing/failure-classifier.js';
import { type SourceConfig } from '../src/config/sources.js';

describe('Synthetic Failure Test Harness', () => {
  let memoryDb: ReturnType<typeof Database>;

  const mockSource: SourceConfig = {
    source_id: 'synthetic-test-source',
    name: 'Synthetic Test Source',
    target_url: 'https://example.com/api',
    collector_id: 'c_synthetic_test',
    expected_fields: ['title', 'url'],
    validation_thresholds: {
      baseline_window: 5,
      corruption_threshold_pct: 20,
      duplicate_threshold_pct: 50,
    },
  };

  beforeEach(() => {
    memoryDb = new Database(':memory:');
    initSchema(memoryDb);
  });

  afterEach(() => {
    memoryDb.close();
  });

  it('Case 1: handles empty response body without crashing and routes to FAILED', async () => {
    const mockExecutor = async () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    });

    const result = await runCollector(mockSource, {
      executor: mockExecutor,
      db: memoryDb,
      validateWithSentinel: true,
    });

    expect(result.success).toBe(false);
    expect(result.run.status).toBe('FAILED');
    expect(result.run.error_message).toContain('JSON parse error');

    const record = getRunById(result.run.run_id, memoryDb);
    expect(record).toBeDefined();
    expect(record?.status).toBe('FAILED');
  });

  it('Case 2: handles truncated/malformed JSON payload without crashing and routes to FAILED', async () => {
    const mockExecutor = async () => ({
      stdout: '{"title": "Truncated Payload Incomplete JSON...',
      stderr: '',
      exitCode: 0,
    });

    const result = await runCollector(mockSource, {
      executor: mockExecutor,
      db: memoryDb,
      validateWithSentinel: true,
    });

    expect(result.success).toBe(false);
    expect(result.run.status).toBe('FAILED');
    expect(result.run.error_message).toContain('JSON parse error');

    const classification = classifyFailure(result.run.error_message!);
    expect(classification.category).toBe('SCHEMA_CORRUPTED');
  });

  it('Case 3: handles CLI timeout cleanly, records FAILED status, and routes to transient retry', async () => {
    const timeoutError = 'CLI timeout after 180000ms: process killed';
    const mockExecutor = async () => ({
      stdout: '',
      stderr: timeoutError,
      exitCode: 1,
    });

    const result = await runCollector(mockSource, {
      executor: mockExecutor,
      db: memoryDb,
      validateWithSentinel: false,
    });

    expect(result.success).toBe(false);
    expect(result.run.status).toBe('FAILED');
    expect(result.run.error_message).toContain('timeout');

    const classification = classifyFailure(timeoutError);
    expect(classification.category).toBe('TRANSIENT_RETRYABLE');
    expect(classification.isRetryable).toBe(true);
    expect(classification.shouldHeal).toBe(false);
  });
});
