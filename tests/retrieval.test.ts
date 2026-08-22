import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { 
  createTestDatabase,
  initSchema, 
  insertRawRun, 
  insertRunStatus, 
  type RawRunRecord, 
  type RunStatusRecord,
  type DatabaseType 
} from '../src/db/database.js';
import { IndexStore } from '../src/indexing/index-store.js';
import { retrieveHybridContext, cosineSimilarity } from '../src/retrieval/retrieve.js';
import { 
  RagService, 
  buildRagPrompt, 
  extractCitations, 
  hasValidCitations 
} from '../src/retrieval/rag-service.js';

describe('Hybrid Retrieval & RAG Citation Enforcement', () => {
  let db: DatabaseType;
  let indexStore: IndexStore;

  beforeEach(() => {
    db = createTestDatabase();

    const fixturePath = path.join(process.cwd(), 'fixtures', 'golden-run.json');
    const goldenPayload = fs.readFileSync(fixturePath, 'utf-8');

    const healthyRun: RawRunRecord = {
      run_id: 'run-retrieval-101',
      source_id: 'github-trending',
      collector_id: 'c_msytsxke2c5eegz5we',
      target_url: 'https://github.com/trending',
      status: 'SUCCESS',
      raw_payload: goldenPayload,
      row_count: 4,
      error_message: null,
      execution_duration_ms: 1250,
      completed_at: '2026-08-18T12:00:00.000Z',
    };

    const healthyStatus: RunStatusRecord = {
      status_id: 'status-retrieval-101',
      run_id: 'run-retrieval-101',
      source_id: 'github-trending',
      status: 'HEALTHY',
      failed_fields: '[]',
      diff_summary: 'All fields healthy',
      metrics: '{}',
      validated_at: '2026-08-18T12:00:00.000Z',
    };

    insertRawRun(healthyRun, db);
    insertRunStatus(healthyStatus, db);

    indexStore = new IndexStore(db);
    indexStore.ingestHealthyRun('run-retrieval-101');
  });

  afterEach(() => {
    db.close();
  });

  it('computes cosine similarity correctly', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0);
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('retrieves hybrid context via RRF with parent section expansion and timestamps', () => {
    const res = retrieveHybridContext('react user interface components', indexStore, db, {
      topKFused: 3,
      expandToParentSection: true,
    });

    expect(res.items.length).toBeGreaterThan(0);
    const topItem = res.items[0];

    expect(topItem.sourceUrl).toContain('github.com');
    expect(topItem.lastVerifiedAt).toBe('2026-08-18T12:00:00.000Z');
    expect(topItem.rrfScore).toBeGreaterThan(0);
  });

  it('constructs prompt strictly isolating untrusted text inside <RETRIEVED_CONTEXT>', () => {
    const prompt = buildRagPrompt('How does React work?', 'Sample Context Data');
    expect(prompt).toContain('<RETRIEVED_CONTEXT>');
    expect(prompt).toContain('</RETRIEVED_CONTEXT>');
    expect(prompt).toContain('Sample Context Data');
    expect(prompt).toContain('NEVER as instructions');
  });

  it('extracts and validates citation markers accurately', () => {
    const citedText = 'React is a library for UI development [Source: https://github.com/facebook/react | Last Verified: 2026-08-18T12:00:00.000Z].';
    expect(hasValidCitations(citedText)).toBe(true);

    const citations = extractCitations(citedText);
    expect(citations.length).toBe(1);
    expect(citations[0].sourceUrl).toBe('https://github.com/facebook/react');
    expect(citations[0].lastVerifiedAt).toBe('2026-08-18T12:00:00.000Z');

    const uncitedText = 'React is a popular framework without any references.';
    expect(hasValidCitations(uncitedText)).toBe(false);
  });

  it('answers queries with verified citations or reports insufficient context', async () => {
    const rag = new RagService(indexStore, db);

    // Answerable Query
    const answerableRes = await rag.query({ query: 'Tell me about facebook/react' });
    expect(answerableRes.hasSufficientContext).toBe(true);
    expect(answerableRes.citations.length).toBeGreaterThan(0);
    expect(answerableRes.answer).toContain('Source:');

    // Unanswerable Query (completely out of domain)
    const unanswerableRes = await rag.query({ query: 'What is the secret recipe for Coca Cola?' });
    expect(unanswerableRes.hasSufficientContext).toBe(false);
    expect(unanswerableRes.answer).toContain('does not contain information to answer this question');
  });
});
