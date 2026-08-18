import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { Sentinel, validateRun } from '../src/sentinel/sentinel.js';
import { initSchema, insertRawRun, getRunStatusByRunId, type RawRunRecord } from '../src/db/database.js';
import { type SourceConfig } from '../src/config/sources.js';

describe('The Sentinel — Accuracy & Validation Layer', () => {
  let db: ReturnType<typeof Database>;

  const testConfig: SourceConfig = {
    source_id: 'test-source',
    name: 'Test Source',
    target_url: 'https://github.com/trending',
    collector_id: 'c_test_sentinel',
    expected_fields: ['repo_name', 'author', 'description', 'stars_today', 'total_stars', 'language', 'url'],
    field_types: {
      repo_name: 'string',
      author: 'string',
      description: 'string',
      stars_today: 'string',
      total_stars: 'string',
      language: 'string',
      url: 'url',
    },
    validation_thresholds: {
      baseline_window: 5,
      corruption_threshold_pct: 20,
      duplicate_threshold_pct: 50,
    },
  };

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);

    // Seed 5 historical runs into memoryDb to form a stable baseline
    for (let i = 0; i < 5; i++) {
      const historicalRecord: RawRunRecord = {
        run_id: `hist-run-${i}`,
        source_id: 'test-source',
        collector_id: 'c_test_sentinel',
        target_url: 'https://github.com/trending',
        status: 'SUCCESS',
        raw_payload: JSON.stringify([
          {
            repo_name: `author/repo-${i}-1`,
            author: 'author',
            description: 'A healthy valid description string that is long enough.',
            stars_today: '100 stars today',
            total_stars: '10,000',
            language: 'TypeScript',
            url: 'https://github.com/author/repo-1',
          },
          {
            repo_name: `author/repo-${i}-2`,
            author: 'author',
            description: 'Another high quality project with extensive documentation.',
            stars_today: '200 stars today',
            total_stars: '20,000',
            language: 'Python',
            url: 'https://github.com/author/repo-2',
          },
        ]),
        row_count: 2,
        error_message: null,
        execution_duration_ms: 1200,
        completed_at: new Date(Date.now() - (5 - i) * 60000).toISOString(),
      };
      insertRawRun(historicalRecord, db);
    }
  });

  afterEach(() => {
    db.close();
  });

  it('asserts sentinel.validate() returns HEALTHY against fixtures/golden-run.json', () => {
    const fixturePath = path.join(process.cwd(), 'fixtures', 'golden-run.json');
    const rawFixture = fs.readFileSync(fixturePath, 'utf-8');

    const goldenRunRecord: RawRunRecord = {
      run_id: 'golden-run-001',
      source_id: 'test-source',
      collector_id: 'c_test_sentinel',
      target_url: 'https://github.com/trending',
      status: 'SUCCESS',
      raw_payload: rawFixture,
      row_count: 4,
      error_message: null,
      execution_duration_ms: 980,
      completed_at: new Date().toISOString(),
    };

    insertRawRun(goldenRunRecord, db);

    const sentinel = new Sentinel(undefined, db);
    const report = sentinel.validate(goldenRunRecord, { sourceConfig: testConfig, db });

    expect(report.status).toBe('HEALTHY');
    expect(report.failedFields.length).toBe(0);
    expect(report.diffSummary).toContain('matches schema expectations');

    // Verify written to SQLite run_status
    const statusRecord = getRunStatusByRunId('golden-run-001', db);
    expect(statusRecord).toBeDefined();
    expect(statusRecord?.status).toBe('HEALTHY');
  });

  it('keeps status HEALTHY on a single flaky null field (<20% failure threshold)', () => {
    // 1 field out of 7 is null on 1 row -> failure rate = 1/7 = 14.2% (< 20%)
    const flakyPayload = [
      {
        repo_name: 'test/flaky-repo-1',
        author: 'test',
        description: 'Valid description here',
        stars_today: null, // Flaky field
        total_stars: '15,000',
        language: 'Rust',
        url: 'https://github.com/test/flaky-repo-1',
      },
      {
        repo_name: 'test/flaky-repo-2',
        author: 'test',
        description: 'Valid description 2',
        stars_today: '50 stars today',
        total_stars: '12,000',
        language: 'Go',
        url: 'https://github.com/test/flaky-repo-2',
      },
    ];

    const flakyRunRecord: RawRunRecord = {
      run_id: 'flaky-run-001',
      source_id: 'test-source',
      collector_id: 'c_test_sentinel',
      target_url: 'https://github.com/trending',
      status: 'SUCCESS',
      raw_payload: JSON.stringify(flakyPayload),
      row_count: 2,
      error_message: null,
      execution_duration_ms: 1100,
      completed_at: new Date().toISOString(),
    };

    insertRawRun(flakyRunRecord, db);

    const sentinel = new Sentinel(undefined, db);
    const report = sentinel.validate(flakyRunRecord, { sourceConfig: testConfig, db });

    // Should remain HEALTHY because 14.2% < 20% threshold
    expect(report.status).toBe('HEALTHY');
    expect(report.failedFields).toEqual(['stars_today']);
    expect(report.diffSummary).toContain('under 20% threshold');
  });

  it('flags SCHEMA_CORRUPTED when failure rate exceeds 20% threshold', () => {
    // 3 fields out of 7 missing -> 3/7 = 42.8% (> 20%)
    const corruptedPayload = [
      {
        repo_name: null, // Missing
        author: null, // Missing
        description: null, // Missing
        stars_today: '10 stars today',
        total_stars: '500',
        language: 'Ruby',
        url: 'https://github.com/test/broken',
      },
    ];

    const corruptedRunRecord: RawRunRecord = {
      run_id: 'corrupted-run-001',
      source_id: 'test-source',
      collector_id: 'c_test_sentinel',
      target_url: 'https://github.com/trending',
      status: 'SUCCESS',
      raw_payload: JSON.stringify(corruptedPayload),
      row_count: 1,
      error_message: null,
      execution_duration_ms: 1400,
      completed_at: new Date().toISOString(),
    };

    insertRawRun(corruptedRunRecord, db);

    const sentinel = new Sentinel(undefined, db);
    const report = sentinel.validate(corruptedRunRecord, { sourceConfig: testConfig, db });

    expect(report.status).toBe('SCHEMA_CORRUPTED');
    expect(report.failedFields.length).toBeGreaterThanOrEqual(3);
    expect(report.diffSummary).toContain('Schema corruption detected');
  });

  it('flags SOFT_FAILURE when rows contain near-duplicate text (CAPTCHA / block wall)', () => {
    // All rows return the exact same Cloudflare block text
    const blockPagePayload = [
      {
        repo_name: 'Attention Required! | Cloudflare',
        author: 'Cloudflare',
        description: 'Please complete the security check to access github.com. Ray ID: 8872a1.',
        stars_today: 'Cloudflare Ray ID: 8872a1',
        total_stars: '0',
        language: 'Security Check',
        url: 'https://github.com/blocked',
      },
      {
        repo_name: 'Attention Required! | Cloudflare',
        author: 'Cloudflare',
        description: 'Please complete the security check to access github.com. Ray ID: 8872a1.',
        stars_today: 'Cloudflare Ray ID: 8872a1',
        total_stars: '0',
        language: 'Security Check',
        url: 'https://github.com/blocked',
      },
      {
        repo_name: 'Attention Required! | Cloudflare',
        author: 'Cloudflare',
        description: 'Please complete the security check to access github.com. Ray ID: 8872a1.',
        stars_today: 'Cloudflare Ray ID: 8872a1',
        total_stars: '0',
        language: 'Security Check',
        url: 'https://github.com/blocked',
      },
    ];

    const softFailRunRecord: RawRunRecord = {
      run_id: 'soft-fail-run-001',
      source_id: 'test-source',
      collector_id: 'c_test_sentinel',
      target_url: 'https://github.com/trending',
      status: 'SUCCESS',
      raw_payload: JSON.stringify(blockPagePayload),
      row_count: 3,
      error_message: null,
      execution_duration_ms: 800,
      completed_at: new Date().toISOString(),
    };

    insertRawRun(softFailRunRecord, db);

    const sentinel = new Sentinel(undefined, db);
    const report = sentinel.validate(softFailRunRecord, { sourceConfig: testConfig, db });

    expect(report.status).toBe('SOFT_FAILURE');
    expect(report.diffSummary).toContain('Soft failure detected');
  });

  it('flags DIVERGENT when primary extraction diverges from secondary structured data', () => {
    const divergentPayload = [
      {
        repo_name: 'Some Random Unrelated Text Scraped By Broken Selector',
        author: 'test',
        description: 'Description text',
        stars_today: '10 stars',
        total_stars: '100',
        language: 'JS',
        url: 'https://github.com/test/repo',
        _structured_data: {
          repo_name: 'Official Clean Repository Title From JsonLD',
        },
      },
    ];

    const divergentRunRecord: RawRunRecord = {
      run_id: 'divergent-run-001',
      source_id: 'test-source',
      collector_id: 'c_test_sentinel',
      target_url: 'https://github.com/trending',
      status: 'SUCCESS',
      raw_payload: JSON.stringify(divergentPayload),
      row_count: 1,
      error_message: null,
      execution_duration_ms: 950,
      completed_at: new Date().toISOString(),
    };

    insertRawRun(divergentRunRecord, db);

    const sentinel = new Sentinel(undefined, db);
    const report = sentinel.validate(divergentRunRecord, { sourceConfig: testConfig, db });

    expect(report.status).toBe('DIVERGENT');
    expect(report.failedFields).toContain('repo_name');
  });
});
