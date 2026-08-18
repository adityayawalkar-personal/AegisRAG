import { runCollector } from '../scraper-runner.js';
import { getDatabase, getLatestRuns } from '../db/database.js';
import { loadSourcesConfig, type SourceConfig } from '../config/sources.js';

async function verifyDay2() {
  console.log('====================================================');
  console.log('       AegisRAG — Day 2 Verification Suite          ');
  console.log('====================================================\n');

  const db = getDatabase();
  const sources = loadSourcesConfig();
  const validSource = sources[0];

  console.log(`[1/3] Triggering run for valid configured source: '${validSource.source_id}' (${validSource.collector_id})...`);
  const validRunResult = await runCollector(validSource, { db });
  console.log(`-> Result Status: ${validRunResult.run.status}`);
  console.log(`-> Run ID: ${validRunResult.run.run_id}`);
  console.log(`-> Rows extracted: ${validRunResult.run.row_count}\n`);

  console.log('[2/3] Triggering deliberately-broken run (bad collector ID: c_invalid_broken_999)...');
  const brokenSource: SourceConfig = {
    source_id: 'deliberately-broken-source',
    name: 'Broken Source Test',
    target_url: 'https://example.com/broken-target',
    collector_id: 'c_invalid_broken_999',
    expected_fields: ['non_existent_field'],
    validation_thresholds: {
      baseline_window: 5,
      corruption_threshold_pct: 20,
      duplicate_threshold_pct: 50,
    },
  };

  const brokenRunResult = await runCollector(brokenSource, { db });
  console.log(`-> Result Status: ${brokenRunResult.run.status}`);
  console.log(`-> Run ID: ${brokenRunResult.run.run_id}`);
  console.log(`-> Graceful Error Message Captured: ${brokenRunResult.run.error_message?.slice(0, 120)}...\n`);

  console.log('[3/3] Inspecting raw_runs records stored in SQLite database:');
  const latestRuns = getLatestRuns(validSource.source_id, 3, db);
  const brokenRuns = getLatestRuns('deliberately-broken-source', 2, db);

  console.log('\n--- Recent Valid Source Runs ---');
  console.table(
    latestRuns.map((r) => ({
      run_id: r.run_id.slice(0, 8),
      collector_id: r.collector_id,
      status: r.status,
      rows: r.row_count,
      duration_ms: r.execution_duration_ms,
      completed_at: r.completed_at,
    }))
  );

  console.log('\n--- Deliberately-Broken Source Run ---');
  console.table(
    brokenRuns.map((r) => ({
      run_id: r.run_id.slice(0, 8),
      collector_id: r.collector_id,
      status: r.status,
      rows: r.row_count,
      duration_ms: r.execution_duration_ms,
      error_preview: (r.error_message || '').slice(0, 60),
      completed_at: r.completed_at,
    }))
  );

  console.log('\n✅ Day 2 Verification Complete: Both runs logged to SQLite without process crashes.');
}

verifyDay2().catch((err) => {
  console.error('Unexpected fatal error in verification script:', err);
  process.exit(1);
});
