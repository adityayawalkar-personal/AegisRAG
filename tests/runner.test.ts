import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runCollector } from '../src/scraper-runner.js';
import { initSchema, getRunById } from '../src/db/database.js';
import { type SourceConfig } from '../src/config/sources.js';

describe('Safe Scraper Runner Service', () => {
  let memoryDb: ReturnType<typeof Database>;

  const mockSource: SourceConfig = {
    source_id: 'test-feed',
    name: 'Test Feed',
    target_url: 'https://github.com/trending',
    collector_id: 'c_mock_123',
    expected_fields: ['repo_name', 'url'],
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

  it('should successfully parse valid JSON stdout and record SUCCESS in raw_runs', async () => {
    const mockPayload = [
      { repo_name: 'test/repo-1', url: 'https://github.com/test/repo-1' },
      { repo_name: 'test/repo-2', url: 'https://github.com/test/repo-2' },
    ];

    const mockExecutor = vi.fn().mockResolvedValue({
      stdout: JSON.stringify(mockPayload),
      stderr: '',
      exitCode: 0,
    });

    const result = await runCollector(mockSource, { 
      executor: mockExecutor,
      db: memoryDb,
    });

    expect(result.success).toBe(true);
    expect(result.run.status).toBe('SUCCESS');
    expect(result.run.row_count).toBe(2);
    expect(result.parsedData).toEqual(mockPayload);
    expect(mockExecutor).toHaveBeenCalledWith('c_mock_123', 'https://github.com/trending', expect.any(Object));

    const saved = getRunById(result.run.run_id, memoryDb);
    expect(saved).toBeDefined();
    expect(saved?.status).toBe('SUCCESS');
    expect(saved?.row_count).toBe(2);
    expect(saved?.error_message).toBeNull();
  });

  it('should isolate non-zero CLI exit codes without throwing, marking FAILED in raw_runs', async () => {
    const mockExecutor = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: 'Authentication failed or rate limit reached (HTTP 429)',
      exitCode: 1,
    });

    const result = await runCollector(mockSource, { 
      executor: mockExecutor,
      db: memoryDb,
    });

    expect(result.success).toBe(false);
    expect(result.run.status).toBe('FAILED');
    expect(result.run.row_count).toBe(0);
    expect(result.run.error_message).toContain('HTTP 429');

    const saved = getRunById(result.run.run_id, memoryDb);
    expect(saved).toBeDefined();
    expect(saved?.status).toBe('FAILED');
  });

  it('should handle malformed JSON output gracefully and record FAILED status', async () => {
    const mockExecutor = vi.fn().mockResolvedValue({
      stdout: '<html><body>Internal Server Error</body></html>',
      stderr: '',
      exitCode: 0,
    });

    const result = await runCollector(mockSource, { 
      executor: mockExecutor,
      db: memoryDb,
    });

    expect(result.success).toBe(false);
    expect(result.run.status).toBe('FAILED');
    expect(result.run.error_message).toContain('JSON parse error');

    const saved = getRunById(result.run.run_id, memoryDb);
    expect(saved).toBeDefined();
    expect(saved?.status).toBe('FAILED');
  });
});
