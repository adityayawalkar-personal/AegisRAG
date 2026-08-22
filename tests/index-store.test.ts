import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { IndexStore } from '../src/indexing/index-store.js';
import { 
  createTestDatabase,
  initSchema, 
  insertRawRun, 
  insertRunStatus, 
  getChunksByCollector,
  type RawRunRecord, 
  type RunStatusRecord,
  type DatabaseType 
} from '../src/db/database.js';

describe('IndexStore & Stale-Chunk Self-Cleaning', () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = createTestDatabase();
  });

  afterEach(() => {
    db.close();
  });

  it('ingests verified healthy run into vector store and BM25 index', () => {
    const fixturePath = path.join(process.cwd(), 'fixtures', 'golden-run.json');
    const goldenPayload = fs.readFileSync(fixturePath, 'utf-8');

    const healthyRun: RawRunRecord = {
      run_id: 'healthy-run-101',
      source_id: 'github-trending',
      collector_id: 'c_collector_trending',
      target_url: 'https://github.com/trending',
      status: 'SUCCESS',
      raw_payload: goldenPayload,
      row_count: 4,
      error_message: null,
      execution_duration_ms: 1100,
      completed_at: new Date().toISOString(),
    };

    const healthyStatus: RunStatusRecord = {
      status_id: 'status-101',
      run_id: 'healthy-run-101',
      source_id: 'github-trending',
      status: 'HEALTHY',
      failed_fields: '[]',
      diff_summary: 'All fields matched schema.',
      metrics: '{}',
      validated_at: new Date().toISOString(),
    };

    insertRawRun(healthyRun, db);
    insertRunStatus(healthyStatus, db);

    const store = new IndexStore(db);
    const result = store.ingestHealthyRun('healthy-run-101', { schemaVersion: 1 });

    expect(result.chunksCreated).toBe(4);
    expect(store.bm25.size()).toBe(4);

    const searchResults = store.searchKeyword('React Framework', 5);
    expect(searchResults.length).toBeGreaterThan(0);
    expect(searchResults[0].chunk.content).toContain('React');
  });

  it('blocks ingestion if run failed Sentinel validation', () => {
    const corruptedRun: RawRunRecord = {
      run_id: 'corrupted-run-202',
      source_id: 'github-trending',
      collector_id: 'c_collector_trending',
      target_url: 'https://github.com/trending',
      status: 'SUCCESS',
      raw_payload: JSON.stringify([{ repo: null }]),
      row_count: 1,
      error_message: null,
      execution_duration_ms: 1200,
      completed_at: new Date().toISOString(),
    };

    const corruptedStatus: RunStatusRecord = {
      status_id: 'status-202',
      run_id: 'corrupted-run-202',
      source_id: 'github-trending',
      status: 'SCHEMA_CORRUPTED',
      failed_fields: '["repo_name"]',
      diff_summary: 'Schema breakdown detected.',
      metrics: '{}',
      validated_at: new Date().toISOString(),
    };

    insertRawRun(corruptedRun, db);
    insertRunStatus(corruptedStatus, db);

    const store = new IndexStore(db);

    expect(() => store.ingestHealthyRun('corrupted-run-202')).toThrow(
      /Ingestion blocked by Sentinel Quality Gate/
    );
  });

  it('purges superseded schema chunks on heal schema-version bump', () => {
    const store = new IndexStore(db);

    // 1. Ingest Schema Version 1
    const runV1: RawRunRecord = {
      run_id: 'run-v1',
      source_id: 'github-trending',
      collector_id: 'c_collector_trending',
      target_url: 'https://github.com/trending',
      status: 'SUCCESS',
      raw_payload: JSON.stringify([
        { repo_name: 'old-project/v1-alpha', description: 'Old V1 schema extractions' },
        { repo_name: 'old-project/v1-beta', description: 'Stale V1 data that must be purged' },
      ]),
      row_count: 2,
      error_message: null,
      execution_duration_ms: 1000,
      completed_at: '2026-08-18T10:00:00.000Z',
    };
    insertRawRun(runV1, db);
    insertRunStatus({
      status_id: 'status-v1',
      run_id: 'run-v1',
      source_id: 'github-trending',
      status: 'HEALTHY',
      failed_fields: '[]',
      diff_summary: 'Healthy v1',
      metrics: '{}',
      validated_at: '2026-08-18T10:00:00.000Z',
    }, db);

    store.ingestHealthyRun('run-v1', { schemaVersion: 1 });
    expect(getChunksByCollector('c_collector_trending', 1, db).length).toBe(2);
    expect(store.bm25.size()).toBe(2);

    // 2. Ingest Healed Schema Version 2
    const runV2: RawRunRecord = {
      run_id: 'run-v2-healed',
      source_id: 'github-trending',
      collector_id: 'c_collector_trending',
      target_url: 'https://github.com/trending',
      status: 'SUCCESS',
      raw_payload: JSON.stringify([
        { repo_name: 'fresh-project/v2-core', description: 'Fresh healed V2 extractions' },
      ]),
      row_count: 1,
      error_message: null,
      execution_duration_ms: 1100,
      completed_at: '2026-08-18T11:00:00.000Z',
    };
    insertRawRun(runV2, db);
    insertRunStatus({
      status_id: 'status-v2',
      run_id: 'run-v2-healed',
      source_id: 'github-trending',
      status: 'HEALTHY',
      failed_fields: '[]',
      diff_summary: 'Healthy healed v2',
      metrics: '{}',
      validated_at: '2026-08-18T11:00:00.000Z',
    }, db);

    const ingestV2Result = store.ingestHealthyRun('run-v2-healed', { schemaVersion: 2 });

    expect(ingestV2Result.purgedOldChunksCount).toBe(2);

    // Confirm old V1 chunks are completely gone from DB and BM25
    const remainingChunks = getChunksByCollector('c_collector_trending', undefined, db);
    expect(remainingChunks.length).toBe(1);
    expect(remainingChunks[0].schema_version).toBe(2);
    expect(remainingChunks[0].content).toContain('fresh-project/v2-core');

    const oldV1Search = store.searchKeyword('Stale V1 data', 5);
    expect(oldV1Search.length).toBe(0); // Stale data removed from BM25 index

    const freshV2Search = store.searchKeyword('Fresh healed V2', 5);
    expect(freshV2Search.length).toBe(1);
  });
});
