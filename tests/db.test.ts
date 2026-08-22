import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { 
  createTestDatabase,
  initSchema, 
  insertRawRun, 
  getLatestRuns, 
  getLatestSuccessfulRuns, 
  getRunById, 
  countRuns,
  insertHealAttempt,
  getLatestHealAttempts,
  saveGoldenRows,
  getGoldenRows,
  type RawRunRecord,
  type DatabaseType
} from '../src/db/database.js';

describe('SQLite Database Layer', () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = createTestDatabase();
  });

  afterEach(() => {
    db.close();
  });

  it('should initialize raw_runs table and indexes', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='raw_runs'").all();
    expect(tables.length).toBe(1);
  });

  it('should insert and retrieve a successful run record', () => {
    const record: RawRunRecord = {
      run_id: 'run-101',
      source_id: 'github-trending',
      collector_id: 'c_test_123',
      target_url: 'https://github.com/trending',
      status: 'SUCCESS',
      raw_payload: JSON.stringify([{ repo: 'test/repo', stars: 100 }]),
      row_count: 1,
      error_message: null,
      execution_duration_ms: 1250,
      completed_at: '2026-08-18T12:00:00.000Z',
    };

    insertRawRun(record, db);

    const fetched = getRunById('run-101', db);
    expect(fetched).toBeDefined();
    expect(fetched?.run_id).toBe('run-101');
    expect(fetched?.status).toBe('SUCCESS');
    expect(fetched?.row_count).toBe(1);
    expect(fetched?.error_message).toBeNull();
  });

  it('should insert and retrieve a failed run record', () => {
    const record: RawRunRecord = {
      run_id: 'run-102',
      source_id: 'github-trending',
      collector_id: 'c_test_123',
      target_url: 'https://github.com/trending',
      status: 'FAILED',
      raw_payload: null,
      row_count: 0,
      error_message: 'CLI exited with code 1',
      execution_duration_ms: 450,
      completed_at: '2026-08-18T12:05:00.000Z',
    };

    insertRawRun(record, db);

    const fetched = getRunById('run-102', db);
    expect(fetched).toBeDefined();
    expect(fetched?.status).toBe('FAILED');
    expect(fetched?.error_message).toContain('CLI exited with code 1');
  });

  it('should filter successful runs accurately and maintain order', () => {
    const r1: RawRunRecord = {
      run_id: 'r1',
      source_id: 'src-a',
      collector_id: 'c1',
      target_url: 'http://test.com',
      status: 'SUCCESS',
      raw_payload: '[]',
      row_count: 0,
      error_message: null,
      execution_duration_ms: 100,
      completed_at: '2026-08-18T10:00:00.000Z',
    };

    const r2: RawRunRecord = {
      run_id: 'r2',
      source_id: 'src-a',
      collector_id: 'c1',
      target_url: 'http://test.com',
      status: 'FAILED',
      raw_payload: null,
      row_count: 0,
      error_message: 'Timeout',
      execution_duration_ms: 5000,
      completed_at: '2026-08-18T10:05:00.000Z',
    };

    const r3: RawRunRecord = {
      run_id: 'r3',
      source_id: 'src-a',
      collector_id: 'c1',
      target_url: 'http://test.com',
      status: 'SUCCESS',
      raw_payload: '[]',
      row_count: 2,
      error_message: null,
      execution_duration_ms: 120,
      completed_at: '2026-08-18T10:10:00.000Z',
    };

    insertRawRun(r1, db);
    insertRawRun(r2, db);
    insertRawRun(r3, db);

    const allRuns = getLatestRuns('src-a', 10, db);
    expect(allRuns.length).toBe(3);
    expect(allRuns[0].run_id).toBe('r3'); // Most recent first

    const successfulRuns = getLatestSuccessfulRuns('src-a', 10, db);
    expect(successfulRuns.length).toBe(2);
    expect(successfulRuns.map(r => r.run_id)).toEqual(['r3', 'r1']);
    expect(countRuns('src-a', db)).toBe(3);
  });

  it('should insert and retrieve heal_attempts with generated_by metadata', () => {
    const rawRun: RawRunRecord = {
      run_id: 'heal-run-1',
      source_id: 'src-a',
      collector_id: 'c1',
      target_url: 'http://test.com',
      status: 'FAILED',
      raw_payload: null,
      row_count: 0,
      error_message: null,
      execution_duration_ms: 100,
      completed_at: new Date().toISOString(),
    };
    insertRawRun(rawRun, db);

    insertHealAttempt(
      {
        attempt_id: 'att-1',
        collector_id: 'c1',
        run_id: 'heal-run-1',
        heal_description: 'Fix selectors for title',
        preview_result: '[]',
        status: 'AWAITING_APPROVAL',
        error_message: null,
        attempt_number: 1,
        created_at: new Date().toISOString(),
        resolved_at: null,
        generated_by: 'local_gemma_server',
      },
      db
    );

    const attempts = getLatestHealAttempts('c1', 5, db);
    expect(attempts.length).toBe(1);
    expect(attempts[0].generated_by).toBe('local_gemma_server');
  });

  it('should persist and retrieve golden_rows snapshots', () => {
    saveGoldenRows(
      {
        collector_id: 'c_test_collector',
        snapshot_json: JSON.stringify([{ repo: 'facebook/react', stars: 228000 }]),
        captured_at: new Date().toISOString(),
        row_count: 1,
      },
      db
    );

    const golden = getGoldenRows('c_test_collector', db);
    expect(golden).toBeDefined();
    expect(golden?.collector_id).toBe('c_test_collector');
    expect(golden?.row_count).toBe(1);
    expect(JSON.parse(golden!.snapshot_json)).toEqual([{ repo: 'facebook/react', stars: 228000 }]);
  });
});
