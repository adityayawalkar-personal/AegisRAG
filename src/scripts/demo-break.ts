import { randomUUID } from 'node:crypto';
import { getDatabase, insertRawRun, setCollectorStatus, type RawRunRecord } from '../db/database.js';
import { loadSourcesConfig } from '../config/sources.js';
import { Sentinel } from '../sentinel/sentinel.js';
import { computeHealthScore } from '../sentinel/health-score.js';

async function main() {
  console.log('========================================================================');
  console.log('       AegisRAG — Step 1: Simulate Target DOM Sabotage & Detection     ');
  console.log('========================================================================\n');

  const db = getDatabase();
  const sources = loadSourcesConfig();
  const source = sources[0];
  const sentinel = new Sentinel(undefined, db);

  console.log(`[demo:break] 💥 Injecting target markup mutation for collector '${source.collector_id}'...`);
  
  // Corrupted payload with altered CSS selector keys
  const corruptedPayload = [
    {
      redesigned_header_title: 'facebook/react',
      author: 'facebook',
      // Missing expected fields: product_page_url, trending_repositories
    },
  ];

  const corruptedRun: RawRunRecord = {
    run_id: randomUUID(),
    source_id: source.source_id,
    collector_id: source.collector_id,
    target_url: source.target_url,
    status: 'SUCCESS',
    raw_payload: JSON.stringify(corruptedPayload),
    row_count: 1,
    error_message: null,
    execution_duration_ms: 1240,
    completed_at: new Date().toISOString(),
  };

  insertRawRun(corruptedRun, db);
  const report = sentinel.validate(corruptedRun, { sourceConfig: source, db });
  setCollectorStatus(source.collector_id, 'DEGRADED', db);

  const healthScore = computeHealthScore(report);

  console.log(`\n🔴 THE SENTINEL DETECTED EXTRACTION ANOMALY:`);
  console.log(`-> Status:         ${report.status}`);
  console.log(`-> Health Score:   ${healthScore.score}/100 (${healthScore.rating})`);
  console.log(`-> Failed Fields:  [${report.failedFields.join(', ')}]`);
  console.log(`-> Failure Rate:   ${report.metrics.failureRatePct}% (vs 20% threshold)`);
  console.log(`-> Collector State: DEGRADED (Downstream Ingestion PAUSED)`);
  console.log(`-> Diff Summary:   ${report.diffSummary}\n`);
  console.log(`Run 'npm run demo:heal' to initiate Bright Data Scraper Studio AI repair.`);
}

main().catch((err) => {
  console.error('Sabotage simulation error:', err);
  process.exit(1);
});
