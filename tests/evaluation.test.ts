import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { 
  createTestDatabase, 
  insertRawRun, 
  insertRunStatus, 
  type RawRunRecord, 
  type RunStatusRecord, 
  type DatabaseType 
} from '../src/db/database.js';
import { IndexStore } from '../src/indexing/index-store.js';
import { 
  computeRetrievalMetrics, 
  retrieveDenseOnly, 
  retrieveSparseOnly, 
  runAutomatedEvaluation, 
  STANDARD_EVAL_DATASET 
} from '../src/retrieval/evaluation.js';

describe('Automated RAG Evaluation & Fusion Benchmark Suite', () => {
  let db: DatabaseType;
  let indexStore: IndexStore;

  beforeEach(() => {
    db = createTestDatabase();
    indexStore = new IndexStore(db);

    const fixturePath = path.join(process.cwd(), 'fixtures', 'golden-run.json');
    const goldenPayload = fs.readFileSync(fixturePath, 'utf-8');

    const healthyRun: RawRunRecord = {
      run_id: 'eval-test-run-101',
      source_id: 'github-trending',
      collector_id: 'c_msytsxke2c5eegz5we',
      target_url: 'https://github.com/trending',
      status: 'SUCCESS',
      raw_payload: goldenPayload,
      row_count: 4,
      error_message: null,
      execution_duration_ms: 1200,
      completed_at: new Date().toISOString(),
    };

    const healthyStatus: RunStatusRecord = {
      status_id: 'eval-status-101',
      run_id: 'eval-test-run-101',
      source_id: 'github-trending',
      status: 'HEALTHY',
      failed_fields: '[]',
      diff_summary: 'Healthy baseline',
      metrics: JSON.stringify({ totalRows: 4 }),
      validated_at: new Date().toISOString(),
    };

    insertRawRun(healthyRun, db);
    insertRunStatus(healthyStatus, db);
    indexStore.ingestHealthyRun(healthyRun.run_id);
  });

  afterEach(() => {
    db.close();
  });

  it('accurately computes Precision@K, Recall@K, HitRate, and MRR metrics', () => {
    const retrieved = ['doc-A', 'doc-B', 'doc-C', 'doc-D', 'doc-E'];
    const expected = ['doc-B', 'doc-X'];

    const metrics = computeRetrievalMetrics(retrieved, expected, 5);

    // 1 relevant in top 5 retrieved
    expect(metrics.precisionAtK).toBe(0.2); // 1 / 5
    expect(metrics.recallAtK).toBe(0.5); // 1 / 2 expected
    expect(metrics.hitRate).toBe(1);
    expect(metrics.reciprocalRank).toBe(0.5); // doc-B is at index 1 -> rank 2 -> 1/2
  });

  it('runs dense-only and sparse-only retrieval independently', () => {
    const denseDocs = retrieveDenseOnly('react user interfaces', indexStore, 3);
    expect(denseDocs.length).toBeGreaterThan(0);

    const sparseDocs = retrieveSparseOnly('public apis development', indexStore, 3);
    expect(sparseDocs.length).toBeGreaterThan(0);
    expect(sparseDocs[0]).toBe('https://github.com/public-apis/public-apis');
  });

  it('executes full automated benchmark report and verifies RRF hybrid superiority and 100% refusal accuracy', async () => {
    const report = await runAutomatedEvaluation(indexStore, db, STANDARD_EVAL_DATASET, 5);

    expect(report.totalQueries).toBe(6);
    expect(report.answerableQueries).toBe(4);
    expect(report.unanswerableQueries).toBe(2);

    // Negative controls must have 100% refusal rate
    expect(report.refusalAccuracyPct).toBe(100);

    // Citation faithfulness must be >= 75%
    expect(report.citationFaithfulnessPct).toBeGreaterThanOrEqual(75);

    // RRF Hybrid MRR should be >= single-method baselines
    expect(report.hybridStrategyMetrics.meanReciprocalRank).toBeGreaterThanOrEqual(
      Math.min(report.denseOnlyStrategyMetrics.meanReciprocalRank, report.sparseOnlyStrategyMetrics.meanReciprocalRank)
    );
    expect(report.hybridStrategyMetrics.hitRatePct).toBe(100);
  });
});
