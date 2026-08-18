import http, { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { 
  getDatabase, 
  getCollectorState, 
  getLatestRuns, 
  getLatestRunStatus, 
  getLatestHealAttempts, 
  getHealAttemptById,
  type RawRunRecord, 
  type RunStatusRecord, 
  type HealAttemptRecord 
} from '../db/database.js';
import { loadSourcesConfig, getSourceById } from '../config/sources.js';
import { IndexStore } from '../indexing/index-store.js';
import { RagService } from '../retrieval/rag-service.js';
import { runCollector } from '../scraper-runner.js';
import { approveHeal, rejectHeal } from '../healing/heal-loop.js';
import { CircuitBreaker } from '../healing/circuit-breaker.js';
import { authenticateRequest, sendUnauthorized } from './auth.js';

dotenv.config();

const PORT = parseInt(process.env.PORT || '3000', 10);
const PUBLIC_DIR = path.join(process.cwd(), 'public');

export function createServer(customDb?: ReturnType<typeof getDatabase>): http.Server {
  const db = customDb || getDatabase();
  const indexStore = new IndexStore(db);
  const ragService = new RagService(indexStore, db);
  const breaker = new CircuitBreaker(db);

  return http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    try {
      // 1. Static Files (Dashboard UI)
      if (pathname === '/' || pathname === '/index.html') {
        serveStaticFile(path.join(PUBLIC_DIR, 'index.html'), 'text/html', res);
        return;
      }
      if (pathname === '/style.css') {
        serveStaticFile(path.join(PUBLIC_DIR, 'style.css'), 'text/css', res);
        return;
      }
      if (pathname === '/app.js') {
        serveStaticFile(path.join(PUBLIC_DIR, 'app.js'), 'application/javascript', res);
        return;
      }

      // 2. Health & Telemetry Endpoint (GET /api/health)
      if (pathname === '/api/health' && req.method === 'GET') {
        const sources = loadSourcesConfig();
        const collectors = sources.map((s) => {
          const state = breaker.getState(s.collector_id);
          const isTripped = breaker.isTripped(s.collector_id);
          const latestRun = getLatestRuns(s.source_id, 1, db)[0] || null;
          const latestStatus = getLatestRunStatus(s.source_id, 1, db)[0] || null;
          const healAttempts = getLatestHealAttempts(s.collector_id, 5, db);
          return {
            sourceId: s.source_id,
            collectorId: s.collector_id,
            name: s.name,
            targetUrl: s.target_url,
            state: state.status,
            consecutiveFailures: state.consecutive_failures,
            circuitBreakerTripped: isTripped,
            lastHealedAt: state.last_healed_at,
            latestRun,
            latestStatus,
            healAttempts,
          };
        });

        const totalChunksStmt = db.prepare(`SELECT COUNT(*) as count FROM chunks_index`);
        const totalChunks = (totalChunksStmt.get() as { count: number }).count;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'ONLINE',
            serverTime: new Date().toISOString(),
            totalChunksIndexed: totalChunks,
            bm25IndexSize: indexStore.bm25.size(),
            collectors,
          })
        );
        return;
      }

      // 3. Incident Replay Endpoint (GET /api/incident-replay)
      if (pathname === '/api/incident-replay' && req.method === 'GET') {
        const sources = loadSourcesConfig();
        const source = sources[0];
        const collectorId = source.collector_id;

        const runs = getLatestRuns(source.source_id, 10, db);
        const statuses = getLatestRunStatus(source.source_id, 10, db);
        const healAttempts = getLatestHealAttempts(collectorId, 10, db);

        // Build chronological timeline events
        const events: {
          timestamp: string;
          type: 'RUN' | 'SENTINEL_ALERT' | 'HEAL_DIAGNOSIS' | 'APPROVAL_GATE' | 'STATE_TRANSITION';
          title: string;
          details: Record<string, unknown>;
        }[] = [];

        for (const run of runs) {
          events.push({
            timestamp: run.completed_at,
            type: 'RUN',
            title: `Collector Execution (${run.status})`,
            details: { runId: run.run_id, status: run.status, rowCount: run.row_count, durationMs: run.execution_duration_ms },
          });
        }

        for (const st of statuses) {
          events.push({
            timestamp: st.validated_at,
            type: 'SENTINEL_ALERT',
            title: `Sentinel Validation: ${st.status}`,
            details: { runId: st.run_id, status: st.status, diffSummary: st.diff_summary, failedFields: JSON.parse(st.failed_fields) },
          });
        }

        for (const h of healAttempts) {
          events.push({
            timestamp: h.created_at,
            type: 'HEAL_DIAGNOSIS',
            title: `Gemma Diagnosis Generated (Attempt #${h.attempt_number})`,
            details: { attemptId: h.attempt_id, description: h.heal_description, status: h.status },
          });
          if (h.resolved_at) {
            events.push({
              timestamp: h.resolved_at,
              type: 'APPROVAL_GATE',
              title: `Operator Heal Action: ${h.status}`,
              details: { attemptId: h.attempt_id, status: h.status },
            });
          }
        }

        events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ collectorId, eventCount: events.length, timeline: events.slice(0, 20) }));
        return;
      }

      // 4. Authenticated RAG Query Endpoint (POST /api/query)
      if (pathname === '/api/query' && req.method === 'POST') {
        if (!authenticateRequest(req)) {
          sendUnauthorized(res);
          return;
        }

        const body = await parseJsonBody<{ query?: string; maxContextItems?: number }>(req);
        if (!body.query || typeof body.query !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'BAD_REQUEST', message: 'Field "query" is required.' }));
          return;
        }

        const queryResponse = await ragService.query({
          query: body.query,
          maxContextItems: body.maxContextItems || 5,
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(queryResponse));
        return;
      }

      // 5. Authenticated Trigger Scraper Run (POST /api/trigger-run)
      if (pathname === '/api/trigger-run' && req.method === 'POST') {
        if (!authenticateRequest(req)) {
          sendUnauthorized(res);
          return;
        }

        const body = await parseJsonBody<{ sourceId?: string }>(req);
        const sourceId = body.sourceId || 'github-trending';
        const sourceConfig = getSourceById(sourceId);

        if (!sourceConfig) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'NOT_FOUND', message: `Source '${sourceId}' not found.` }));
          return;
        }

        const runResult = await runCollector(sourceConfig, { db, validateWithSentinel: true });

        // If healthy, automatically ingest into vector/BM25 index
        if (runResult.sentinelReport?.status === 'HEALTHY') {
          try {
            indexStore.ingestHealthyRun(runResult.run.run_id);
          } catch (err) {
            console.error('[server] Ingestion after run failed:', err);
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(runResult));
        return;
      }

      // 6. Authenticated Approve Heal (POST /api/heal/approve)
      if (pathname === '/api/heal/approve' && req.method === 'POST') {
        if (!authenticateRequest(req)) {
          sendUnauthorized(res);
          return;
        }

        const body = await parseJsonBody<{ attemptId?: string }>(req);
        if (!body.attemptId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'BAD_REQUEST', message: 'Field "attemptId" is required.' }));
          return;
        }

        const approveResult = await approveHeal(body.attemptId, { db });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(approveResult));
        return;
      }

      // 7. Authenticated Reject Heal (POST /api/heal/reject)
      if (pathname === '/api/heal/reject' && req.method === 'POST') {
        if (!authenticateRequest(req)) {
          sendUnauthorized(res);
          return;
        }

        const body = await parseJsonBody<{ attemptId?: string; reason?: string }>(req);
        if (!body.attemptId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'BAD_REQUEST', message: 'Field "attemptId" is required.' }));
          return;
        }

        const rejectResult = await rejectHeal(body.attemptId, body.reason, { db });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rejectResult));
        return;
      }

      // 404 Route Not Found
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'NOT_FOUND', message: `Route ${pathname} not found.` }));
    } catch (err: unknown) {
      console.error(`[server] Unhandled error on ${pathname}:`, err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) }));
    }
  });
}

function serveStaticFile(filePath: string, contentType: string, res: ServerResponse): void {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

async function parseJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Payload too large (max 1MB)'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : ({} as T));
      } catch (err) {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

// Start server if executed directly
if (process.argv[1]?.endsWith('app.ts') || process.argv[1]?.endsWith('app.js')) {
  const server = createServer();
  server.listen(PORT, () => {
    console.log(`\n🚀 AegisRAG API & Dashboard Server running on http://localhost:${PORT}`);
    console.log(`🔒 API Authentication Secret: ${process.env.API_AUTH_SECRET || 'aegisrag-secret-token-2026'}\n`);
  });
}
