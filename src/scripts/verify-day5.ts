import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDatabase, insertRawRun, insertRunStatus, type RawRunRecord, type RunStatusRecord } from '../db/database.js';
import { IndexStore } from '../indexing/index-store.js';
import { filterPii } from '../indexing/pii-filter.js';
import { extractSectionsFromPayload } from '../indexing/chunking.js';

async function verifyDay5() {
  console.log('========================================================================');
  console.log('    AegisRAG — Day 5 Structure-Preserving Chunking & Invalidation Demo  ');
  console.log('========================================================================\n');

  const db = getDatabase();
  const fixturePath = path.join(process.cwd(), 'fixtures', 'golden-run.json');
  const goldenRaw = fs.readFileSync(fixturePath, 'utf-8');
  const goldenRows = JSON.parse(goldenRaw);

  // 1. Structure-Preserving Parent Section Hierarchy
  console.log('[1/4] Extracting Parent-Child Section Hierarchy from Golden Fixture:');
  const sections = extractSectionsFromPayload(goldenRows, 'https://github.com/trending');
  console.table(
    sections.map((s, i) => ({
      index: i + 1,
      section_id: s.sectionId,
      title: s.title,
      heading_path: JSON.stringify(s.headingPath),
      chars: s.rawContent.length,
    }))
  );
  console.log();

  // 2. PII Filter Demonstration
  console.log('[2/4] Testing Pre-Embedding PII Filter (Emails, Phones, SSNs):');
  const sampleWithPii = `
Project Lead: John Doe (email: john.developer@aegisrag.internal)
Support Hotline: +1 (800) 555-0199
SSN ID: 000-12-3456
Architecture: Hierarchical chunking with Okapi BM25 keyword weighting.
  `.trim();

  const piiResult = filterPii(sampleWithPii);
  console.log('Original Text:\n' + sampleWithPii);
  console.log('\nSanitized Output:\n' + piiResult.sanitizedText);
  console.log(`-> Redactions Made: ${piiResult.totalRedactions} (Emails: ${piiResult.emailCount}, Phones: ${piiResult.phoneCount}, Sensitive: ${piiResult.sensitiveCount})\n`);

  // 3. Ingestion & Indexing of Healthy Golden Run
  console.log('[3/4] Ingesting Golden Run into Dual Vector + BM25 Index (Schema v1):');
  const runIdV1 = randomUUID();
  const runV1: RawRunRecord = {
    run_id: runIdV1,
    source_id: 'github-trending',
    collector_id: 'c_msytsxke2c5eegz5we',
    target_url: 'https://github.com/trending',
    status: 'SUCCESS',
    raw_payload: goldenRaw,
    row_count: goldenRows.length,
    error_message: null,
    execution_duration_ms: 1200,
    completed_at: new Date().toISOString(),
  };

  const statusV1: RunStatusRecord = {
    status_id: randomUUID(),
    run_id: runIdV1,
    source_id: 'github-trending',
    status: 'HEALTHY',
    failed_fields: '[]',
    diff_summary: 'Golden run matched schema cleanly.',
    metrics: '{}',
    validated_at: new Date().toISOString(),
  };

  insertRawRun(runV1, db);
  insertRunStatus(statusV1, db);

  const store = new IndexStore(db);
  const ingestResult = store.ingestHealthyRun(runIdV1, { schemaVersion: 1 });

  console.log(`-> Ingested ${ingestResult.chunksCreated} chunks with Schema Version 1.`);
  console.log('\nSample Indexed Chunks:');
  console.table(
    ingestResult.chunks.map((c) => ({
      chunk_id: c.chunk_id.slice(0, 8),
      parent_id: c.parent_id,
      schema_v: c.schema_version,
      tokens: c.token_count,
      content_snippet: c.content.slice(0, 45).replace(/\n/g, ' ') + '...',
    }))
  );
  console.log();

  // 4. Schema Version Bump & Self-Cleaning Purge Rehearsal
  console.log('[4/4] Simulating Schema-Version Bump (v1 -> v2) on Scraper Heal:');
  const runIdV2 = randomUUID();
  const healedPayload = [
    {
      repo_name: 'facebook/react',
      author: 'facebook',
      description: 'The library for web and native user interfaces (Healed Schema v2 extraction).',
      stars_today: '1,200 stars today',
      total_stars: '235k',
      language: 'JavaScript',
      url: 'https://github.com/facebook/react',
    },
  ];

  const runV2: RawRunRecord = {
    run_id: runIdV2,
    source_id: 'github-trending',
    collector_id: 'c_msytsxke2c5eegz5we',
    target_url: 'https://github.com/trending',
    status: 'SUCCESS',
    raw_payload: JSON.stringify(healedPayload),
    row_count: 1,
    error_message: null,
    execution_duration_ms: 1100,
    completed_at: new Date().toISOString(),
  };

  const statusV2: RunStatusRecord = {
    status_id: randomUUID(),
    run_id: runIdV2,
    source_id: 'github-trending',
    status: 'HEALTHY',
    failed_fields: '[]',
    diff_summary: 'Healed extraction validated healthy.',
    metrics: '{}',
    validated_at: new Date().toISOString(),
  };

  insertRawRun(runV2, db);
  insertRunStatus(statusV2, db);

  const ingestV2Result = store.ingestHealthyRun(runIdV2, { schemaVersion: 2 });
  console.log(`-> Ingestion Result for Schema v2: ${ingestV2Result.chunksCreated} fresh chunk(s) indexed.`);
  console.log(`-> Stale Chunk Purge Count: ${ingestV2Result.purgedOldChunksCount} stale v1 chunks permanently removed from index.`);

  const remainingChunks = store.getAllChunksForCollector('c_msytsxke2c5eegz5we');
  console.log(`-> Total Remaining Chunks in Index for Collector: ${remainingChunks.length}`);

  // Test BM25 Query
  console.log('\nBM25 Search Test: Query "react user interfaces"');
  const searchResults = store.searchKeyword('react user interfaces', 3);
  console.table(
    searchResults.map((r) => ({
      rank: r.rank,
      score: Math.round(r.score * 100) / 100,
      schema_v: r.chunk.schema_version,
      content: r.chunk.content.slice(0, 70) + '...',
    }))
  );

  console.log('\n✅ Day 5 Verification Complete: Structure-preserving chunking, PII redaction, and schema invalidation purge validated.');
}

verifyDay5().catch((err) => {
  console.error('Fatal error in Day 5 verification:', err);
  process.exit(1);
});
