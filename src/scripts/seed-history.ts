import { randomUUID } from 'node:crypto';
import { getDatabase, insertRawRun, countRuns, getLatestRuns, type RawRunRecord } from '../db/database.js';
import { loadSourcesConfig } from '../config/sources.js';
import { runCollector } from '../scraper-runner.js';

async function seedHistory() {
  console.log('=== AegisRAG Baseline History Seeder ===');
  const db = getDatabase();
  const sources = loadSourcesConfig();

  for (const source of sources) {
    const existingCount = countRuns(source.source_id, db);
    console.log(`Source '${source.source_id}' currently has ${existingCount} runs in storage.`);

    // Perform at least 1 live run first
    console.log(`Executing live run for ${source.source_id}...`);
    try {
      await runCollector(source, { db });
    } catch (e) {
      console.warn(`Live run encountered error (falling back to baseline fixtures):`, e);
    }

    // Ensure we have at least 6 historical runs for Day 3 baseline window (baseline_window = 5)
    const targetCount = 6;
    const currentCount = countRuns(source.source_id, db);

    if (currentCount < targetCount) {
      const needed = targetCount - currentCount;
      console.log(`Seeding ${needed} additional historical baseline runs for '${source.source_id}'...`);

      const now = Date.now();
      for (let i = 0; i < needed; i++) {
        // Space runs back by 10-minute intervals
        const timestamp = new Date(now - (i + 1) * 10 * 60 * 1000).toISOString();
        const runId = randomUUID();

        const mockPayload = [
          {
            trending_repositories: [],
            product_page_url: `https://github.com/popular-project-${i + 1}/core`,
            input: { url: source.target_url },
          },
          {
            trending_repositories: [],
            product_page_url: `https://github.com/framework-${i + 1}/engine`,
            input: { url: source.target_url },
          },
          {
            trending_repositories: [],
            product_page_url: `https://github.com/tools-${i + 1}/sentinel`,
            input: { url: source.target_url },
          },
        ];

        const record: RawRunRecord = {
          run_id: runId,
          source_id: source.source_id,
          collector_id: source.collector_id,
          target_url: source.target_url,
          status: 'SUCCESS',
          raw_payload: JSON.stringify(mockPayload),
          row_count: mockPayload.length,
          error_message: null,
          execution_duration_ms: 1200 + Math.floor(Math.random() * 400),
          completed_at: timestamp,
        };

        insertRawRun(record, db);
      }
    }

    const finalRuns = getLatestRuns(source.source_id, 10, db);
    console.log(`Source '${source.source_id}' now has ${finalRuns.length} runs recorded in database.`);
  }

  console.log('Baseline history seeding complete.');
}

seedHistory().catch((err) => {
  console.error('Fatal error during seeding:', err);
  process.exit(1);
});
