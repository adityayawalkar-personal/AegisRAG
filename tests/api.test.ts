import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { AddressInfo } from 'node:net';
import { createServer } from '../src/server/app.js';
import { initSchema, insertRawRun, insertRunStatus, type RawRunRecord, type RunStatusRecord } from '../src/db/database.js';
import { getAuthSecret } from '../src/server/auth.js';

describe('Server REST API Endpoints & Auth Gate', () => {
  let db: ReturnType<typeof Database>;
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;

  beforeEach(async () => {
    process.env.API_AUTH_SECRET = 'test-token-secret-12345';

    db = new Database(':memory:');
    initSchema(db);

    const healthyRun: RawRunRecord = {
      run_id: 'api-test-run-1',
      source_id: 'github-trending',
      collector_id: 'c_msytsxke2c5eegz5we',
      target_url: 'https://github.com/trending',
      status: 'SUCCESS',
      raw_payload: JSON.stringify([{ repo_name: 'test/repo', description: 'Testing repo' }]),
      row_count: 1,
      error_message: null,
      execution_duration_ms: 1000,
      completed_at: new Date().toISOString(),
    };

    const healthyStatus: RunStatusRecord = {
      status_id: 'api-test-status-1',
      run_id: 'api-test-run-1',
      source_id: 'github-trending',
      status: 'HEALTHY',
      failed_fields: '[]',
      diff_summary: 'All healthy',
      metrics: '{}',
      validated_at: new Date().toISOString(),
    };

    insertRawRun(healthyRun, db);
    insertRunStatus(healthyStatus, db);

    server = createServer(db);
    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });

  it('GET /api/health returns health console metrics and collector telemetry', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);

    const data = (await res.json()) as { status: string; collectors: unknown[] };
    expect(data.status).toBe('ONLINE');
    expect(data.collectors.length).toBeGreaterThan(0);
  });

  it('GET /api/incident-replay returns structured incident events', async () => {
    const res = await fetch(`${baseUrl}/api/incident-replay`);
    expect(res.status).toBe(200);

    const data = (await res.json()) as { timeline: unknown[] };
    expect(Array.isArray(data.timeline)).toBe(true);
  });

  it('POST /api/query rejects unauthorized requests without API key', async () => {
    const res = await fetch(`${baseUrl}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Tell me about test/repo' }),
    });

    expect(res.status).toBe(401);
  });

  it('POST /api/query answers authenticated requests with valid x-api-key', async () => {
    const res = await fetch(`${baseUrl}/api/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': getAuthSecret(),
      },
      body: JSON.stringify({ query: 'Tell me about test/repo' }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as { query: string; answer: string };
    expect(data.query).toBe('Tell me about test/repo');
    expect(data.answer).toBeDefined();
  });
});
