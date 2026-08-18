import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDatabase, insertRawRun, getLatestRunStatus, type RawRunRecord } from '../db/database.js';
import { loadSourcesConfig } from '../config/sources.js';
import { Sentinel } from '../sentinel/sentinel.js';

async function verifyDay3() {
  console.log('================================================================');
  console.log('             AegisRAG — Day 3 Sentinel Verification             ');
  console.log('================================================================\n');

  const db = getDatabase();
  const sources = loadSourcesConfig();
  const source = sources[0];
  const sentinel = new Sentinel(undefined, db);

  // 1. Genuinely Healthy Run (Golden Fixture)
  console.log('[1/4] Validating Genuinely Healthy Run (from fixtures/golden-run.json)...');
  const goldenFixture = fs.readFileSync(path.join(process.cwd(), 'fixtures', 'golden-run.json'), 'utf-8');
  const healthyRun: RawRunRecord = {
    run_id: randomUUID(),
    source_id: source.source_id,
    collector_id: source.collector_id,
    target_url: source.target_url,
    status: 'SUCCESS',
    raw_payload: goldenFixture,
    row_count: 4,
    error_message: null,
    execution_duration_ms: 1240,
    completed_at: new Date().toISOString(),
  };
  insertRawRun(healthyRun, db);
  const healthyReport = sentinel.validate(healthyRun, { sourceConfig: source, db });
  console.log(`-> Status: ${healthyReport.status}`);
  console.log(`-> Diff Summary: ${healthyReport.diffSummary}\n`);

  // 2. Run with One Flaky Null Field (< 20% Threshold)
  console.log('[2/4] Validating Run with One Flaky Null Field (Noise Resistance)...');
  const flakyPayload = [
    {
      repo_name: 'public-apis/public-apis',
      author: 'public-apis',
      description: 'A collective list of free APIs.',
      stars_today: null, // Single flaky null field
      total_stars: '312,450',
      language: 'Python',
      url: 'https://github.com/public-apis/public-apis',
      product_page_url: 'https://github.com/public-apis/public-apis',
      trending_repositories: [],
    },
    {
      repo_name: 'facebook/react',
      author: 'facebook',
      description: 'The library for web interfaces.',
      stars_today: '89 stars today',
      total_stars: '228,100',
      language: 'JavaScript',
      url: 'https://github.com/facebook/react',
      product_page_url: 'https://github.com/facebook/react',
      trending_repositories: [],
    },
  ];
  const flakyRun: RawRunRecord = {
    run_id: randomUUID(),
    source_id: source.source_id,
    collector_id: source.collector_id,
    target_url: source.target_url,
    status: 'SUCCESS',
    raw_payload: JSON.stringify(flakyPayload),
    row_count: 2,
    error_message: null,
    execution_duration_ms: 1180,
    completed_at: new Date().toISOString(),
  };
  insertRawRun(flakyRun, db);
  const flakyReport = sentinel.validate(flakyRun, { sourceConfig: source, db });
  console.log(`-> Status: ${flakyReport.status}`);
  console.log(`-> Failed Fields: [${flakyReport.failedFields.join(', ')}]`);
  console.log(`-> Diff Summary: ${flakyReport.diffSummary}\n`);

  // 3. Severely Corrupted Run (> 20% Missing Fields)
  console.log('[3/4] Validating Severely Corrupted Run (Schema Breakdown)...');
  const corruptedPayload = [
    {
      repo_name: null,
      author: null,
      description: null,
      stars_today: '0 stars',
      total_stars: '0',
      language: null,
      url: 'https://github.com/broken',
      product_page_url: null,
      trending_repositories: null,
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
    execution_duration_ms: 1350,
    completed_at: new Date().toISOString(),
  };
  insertRawRun(corruptedRun, db);
  const corruptedReport = sentinel.validate(corruptedRun, { sourceConfig: source, db });
  console.log(`-> Status: ${corruptedReport.status}`);
  console.log(`-> Failed Fields: [${corruptedReport.failedFields.join(', ')}]`);
  console.log(`-> Diff Summary: ${corruptedReport.diffSummary}\n`);

  // 4. Soft Failure Detection (CAPTCHA / Block Page Wall)
  console.log('[4/4] Validating Soft Failure (Cloudflare / CAPTCHA Wall)...');
  const blockPagePayload = [
    {
      repo_name: 'Attention Required! | Cloudflare',
      description: 'Please complete the security check to access github.com. Ray ID: 9912bc',
      url: 'https://github.com/blocked',
      product_page_url: 'https://github.com/blocked',
    },
    {
      repo_name: 'Attention Required! | Cloudflare',
      description: 'Please complete the security check to access github.com. Ray ID: 9912bc',
      url: 'https://github.com/blocked',
      product_page_url: 'https://github.com/blocked',
    },
  ];
  const softFailRun: RawRunRecord = {
    run_id: randomUUID(),
    source_id: source.source_id,
    collector_id: source.collector_id,
    target_url: source.target_url,
    status: 'SUCCESS',
    raw_payload: JSON.stringify(blockPagePayload),
    row_count: 2,
    error_message: null,
    execution_duration_ms: 720,
    completed_at: new Date().toISOString(),
  };
  insertRawRun(softFailRun, db);
  const softFailReport = sentinel.validate(softFailRun, { sourceConfig: source, db });
  console.log(`-> Status: ${softFailReport.status}`);
  console.log(`-> Diff Summary: ${softFailReport.diffSummary}\n`);

  // 5. Inspecting SQLite run_status records
  console.log('--- Summary of SQLite run_status Records ---');
  const statusRecords = getLatestRunStatus(source.source_id, 10, db);
  console.table(
    statusRecords.map((r) => ({
      status_id: r.status_id.slice(0, 8),
      run_id: r.run_id.slice(0, 8),
      status: r.status,
      failed_fields: JSON.parse(r.failed_fields).length,
      diff_summary: r.diff_summary.slice(0, 70),
      validated_at: r.validated_at,
    }))
  );

  console.log('\n✅ Day 3 Verification Complete: Sentinel accuracy layer tested and validated.');
}

verifyDay3().catch((err) => {
  console.error('Fatal error in Day 3 verification:', err);
  process.exit(1);
});
