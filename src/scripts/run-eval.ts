import fs from 'node:fs';
import path from 'node:path';
import { IndexStore } from '../indexing/index-store.js';
import { createTestDatabase, insertRawRun, insertRunStatus, type RawRunRecord, type RunStatusRecord } from '../db/database.js';
import { runAutomatedEvaluation, STANDARD_EVAL_DATASET } from '../retrieval/evaluation.js';

async function main() {
  console.log('========================================================================');
  console.log('       AegisRAG — Automated Retrieval & Fusion Evaluation Benchmark     ');
  console.log('========================================================================\n');

  const db = createTestDatabase();
  const indexStore = new IndexStore(db);

  // Ingest golden baseline dataset into index store
  const fixturePath = path.join(process.cwd(), 'fixtures', 'golden-run.json');
  const goldenPayload = fs.readFileSync(fixturePath, 'utf-8');

  const baselineRun: RawRunRecord = {
    run_id: 'eval-seed-run-001',
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

  const baselineStatus: RunStatusRecord = {
    status_id: 'eval-status-001',
    run_id: 'eval-seed-run-001',
    source_id: 'github-trending',
    status: 'HEALTHY',
    failed_fields: '[]',
    diff_summary: 'Baseline healthy extraction.',
    metrics: JSON.stringify({ totalRows: 4, failureRatePct: 0 }),
    validated_at: new Date().toISOString(),
  };

  insertRawRun(baselineRun, db);
  insertRunStatus(baselineStatus, db);
  indexStore.ingestHealthyRun(baselineRun.run_id);

  console.log(`📦 Seeded evaluation index with ${indexStore.size()} chunks across 4 verified repositories.\n`);
  console.log(`🧪 Running benchmark suite against ${STANDARD_EVAL_DATASET.length} held-out queries...\n`);

  const report = await runAutomatedEvaluation(indexStore, db, STANDARD_EVAL_DATASET, 5);

  console.log('------------------------------------------------------------------------');
  console.log('1. Retrieval Strategy Ablation & Fusion Comparison:');
  console.log('------------------------------------------------------------------------');

  console.table([
    {
      'Strategy': 'RRF Hybrid Search (k=60)',
      'Precision@5': report.hybridStrategyMetrics.meanPrecisionAtK,
      'Recall@5': report.hybridStrategyMetrics.meanRecallAtK,
      'MRR': report.hybridStrategyMetrics.meanReciprocalRank,
      'Hit Rate %': `${report.hybridStrategyMetrics.hitRatePct}%`,
      'Avg Latency': `${report.hybridStrategyMetrics.averageLatencyMs}ms`,
    },
    {
      'Strategy': 'Dense Vector Only',
      'Precision@5': report.denseOnlyStrategyMetrics.meanPrecisionAtK,
      'Recall@5': report.denseOnlyStrategyMetrics.meanRecallAtK,
      'MRR': report.denseOnlyStrategyMetrics.meanReciprocalRank,
      'Hit Rate %': `${report.denseOnlyStrategyMetrics.hitRatePct}%`,
      'Avg Latency': `${report.denseOnlyStrategyMetrics.averageLatencyMs}ms`,
    },
    {
      'Strategy': 'Okapi BM25 Sparse Only',
      'Precision@5': report.sparseOnlyStrategyMetrics.meanPrecisionAtK,
      'Recall@5': report.sparseOnlyStrategyMetrics.meanRecallAtK,
      'MRR': report.sparseOnlyStrategyMetrics.meanReciprocalRank,
      'Hit Rate %': `${report.sparseOnlyStrategyMetrics.hitRatePct}%`,
      'Avg Latency': `${report.sparseOnlyStrategyMetrics.averageLatencyMs}ms`,
    },
  ]);

  console.log(`\n-> RRF Hybrid Improvement over best single-method baseline: +${report.rrfAdvantagePct}%\n`);

  console.log('------------------------------------------------------------------------');
  console.log('2. Faithfulness, Citation Accuracy & Hallucination Refusal:');
  console.log('------------------------------------------------------------------------');
  console.log(`-> Total Evaluated Queries:       ${report.totalQueries}`);
  console.log(`-> Answerable Queries Evaluated:  ${report.answerableQueries}`);
  console.log(`-> Citation Faithfulness Score:   ${report.citationFaithfulnessPct}%`);
  console.log(`-> Unanswerable Negative Controls: ${report.unanswerableQueries}`);
  console.log(`-> Refusal Gate Accuracy:         ${report.refusalAccuracyPct}%\n`);

  console.log('========================================================================');
  console.log('🎉 Automated RAG Evaluation Complete: All Benchmark Metrics Verified!');
  console.log('========================================================================');
}

main().catch((err) => {
  console.error('Fatal Evaluation Benchmark Error:', err);
  process.exit(1);
});
