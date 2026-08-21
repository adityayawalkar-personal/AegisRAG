import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import { type Database as DatabaseType } from 'better-sqlite3';
import { insertRawRun, type RawRunRecord, getDatabase } from './db/database.js';
import { loadSourcesConfig, type SourceConfig } from './config/sources.js';
import { Sentinel } from './sentinel/sentinel.js';
import { type SentinelReport } from './sentinel/types.js';
import { resolveBdataCliBinary } from './healing/heal-loop.js';

dotenv.config();

export interface ScraperExecutionResult {
  run: RawRunRecord;
  success: boolean;
  parsedData: unknown[] | null;
  sentinelReport?: SentinelReport;
}

export interface CliExecutionOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunnerOptions {
  timeoutMs?: number;
  customEnv?: NodeJS.ProcessEnv;
  db?: DatabaseType;
  validateWithSentinel?: boolean;
  executor?: (collectorId: string, targetUrl: string, options: RunnerOptions) => Promise<CliExecutionOutput>;
}

const DEFAULT_TIMEOUT_MS = 180000; // 3 minutes timeout

/**
 * Executes a Bright Data Scraper Studio collector safely via execFile argument arrays.
 * Guarantees that untrusted strings are never passed through shell string concatenation.
 * Direct Node execution of @brightdata/cli ensures shell: false on all platforms.
 */
export async function executeCollectorCli(
  collectorId: string,
  targetUrl: string,
  options: RunnerOptions = {}
): Promise<CliExecutionOutput> {
  return new Promise((resolve) => {
    const cliJsPath = resolveBdataCliBinary();
    const isDirectNode = cliJsPath.endsWith('.js');
    const binary = isDirectNode ? process.execPath : cliJsPath;
    const args = isDirectNode
      ? [cliJsPath, 'scraper', 'run', collectorId, targetUrl, '--pretty']
      : ['scraper', 'run', collectorId, targetUrl, '--pretty'];

    const child = execFile(
      binary,
      args,
      {
        timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        shell: false, // Strict: Zero shell interpolation on all platforms
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...options.customEnv,
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          const exitCode = typeof error.code === 'number' ? error.code : 1;
          resolve({
            stdout: stdout ? stdout.toString() : '',
            stderr: stderr ? stderr.toString() : error.message,
            exitCode,
          });
          return;
        }

        resolve({
          stdout: stdout ? stdout.toString() : '',
          stderr: stderr ? stderr.toString() : '',
          exitCode: 0,
        });
      }
    );
  });
}

/**
 * Runs a collector for a given source configuration and records the result in SQLite raw_runs.
 * Automatically triggers Sentinel validation on the completed run.
 */
export async function runCollector(
  source: SourceConfig,
  options: RunnerOptions = {}
): Promise<ScraperExecutionResult> {
  const runId = randomUUID();
  const startTime = Date.now();
  const completedAt = new Date().toISOString();
  const db = options.db || getDatabase();
  const shouldValidate = options.validateWithSentinel !== false;

  console.log(`[scraper-runner] Starting run ${runId} for source '${source.source_id}' (${source.collector_id})...`);

  const execFn = options.executor || executeCollectorCli;
  const { stdout, stderr, exitCode } = await execFn(
    source.collector_id,
    source.target_url,
    options
  );

  const durationMs = Date.now() - startTime;

  if (exitCode !== 0) {
    const errorMsg = `CLI exited with code ${exitCode}. Stderr: ${stderr.slice(0, 1000)}`;
    console.error(`[scraper-runner] Run ${runId} FAILED: ${errorMsg}`);

    const failedRecord: RawRunRecord = {
      run_id: runId,
      source_id: source.source_id,
      collector_id: source.collector_id,
      target_url: source.target_url,
      status: 'FAILED',
      raw_payload: stdout.trim() || null,
      row_count: 0,
      error_message: errorMsg,
      execution_duration_ms: durationMs,
      completed_at: completedAt,
    };

    insertRawRun(failedRecord, db);

    let sentinelReport: SentinelReport | undefined;
    if (shouldValidate) {
      const sentinel = new Sentinel(undefined, db);
      sentinelReport = sentinel.validate(failedRecord, { sourceConfig: source, db });
    }

    return {
      run: failedRecord,
      success: false,
      parsedData: null,
      sentinelReport,
    };
  }

  // Attempt JSON parsing of stdout
  let parsedData: unknown[] | null = null;
  let rowCount = 0;
  let parseError: string | null = null;

  try {
    const rawJson = JSON.parse(stdout);
    if (Array.isArray(rawJson)) {
      parsedData = rawJson;
      rowCount = rawJson.length;
    } else if (rawJson && typeof rawJson === 'object') {
      parsedData = [rawJson];
      rowCount = 1;
    } else {
      parseError = 'Output was not a JSON array or object';
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    parseError = `JSON parse error: ${msg}`;
  }

  if (parseError) {
    console.error(`[scraper-runner] Run ${runId} FAILED on parse: ${parseError}`);

    const failedRecord: RawRunRecord = {
      run_id: runId,
      source_id: source.source_id,
      collector_id: source.collector_id,
      target_url: source.target_url,
      status: 'FAILED',
      raw_payload: stdout.slice(0, 5000),
      row_count: 0,
      error_message: parseError,
      execution_duration_ms: durationMs,
      completed_at: completedAt,
    };

    insertRawRun(failedRecord, db);

    let sentinelReport: SentinelReport | undefined;
    if (shouldValidate) {
      const sentinel = new Sentinel(undefined, db);
      sentinelReport = sentinel.validate(failedRecord, { sourceConfig: source, db });
    }

    return {
      run: failedRecord,
      success: false,
      parsedData: null,
      sentinelReport,
    };
  }

  console.log(`[scraper-runner] Run ${runId} SUCCESS: Extracted ${rowCount} rows in ${durationMs}ms`);

  const successRecord: RawRunRecord = {
    run_id: runId,
    source_id: source.source_id,
    collector_id: source.collector_id,
    target_url: source.target_url,
    status: 'SUCCESS',
    raw_payload: JSON.stringify(parsedData),
    row_count: rowCount,
    error_message: null,
    execution_duration_ms: durationMs,
    completed_at: completedAt,
  };

  insertRawRun(successRecord, db);

  let sentinelReport: SentinelReport | undefined;
  if (shouldValidate) {
    const sentinel = new Sentinel(undefined, db);
    sentinelReport = sentinel.validate(successRecord, { sourceConfig: source, db });
    console.log(`[sentinel] Run ${runId} validated: ${sentinelReport.status} — ${sentinelReport.diffSummary}`);
  }

  return {
    run: successRecord,
    success: true,
    parsedData,
    sentinelReport,
  };
}

/**
 * Loops through all configured sources and executes each collector in sequence.
 */
export async function runAllSources(
  configPath?: string,
  options: RunnerOptions = {}
): Promise<ScraperExecutionResult[]> {
  const sources = loadSourcesConfig(configPath);
  console.log(`[scraper-runner] Executing ${sources.length} configured source(s)...`);

  const results: ScraperExecutionResult[] = [];
  for (const source of sources) {
    try {
      const result = await runCollector(source, options);
      results.push(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[scraper-runner] Unexpected error running source '${source.source_id}': ${msg}`);
    }
  }

  return results;
}

// CLI entrypoint
if (process.argv[1] && process.argv[1].endsWith('scraper-runner.ts')) {
  runAllSources()
    .then((results) => {
      const successful = results.filter(r => r.success).length;
      console.log(`\n[scraper-runner] Batch complete: ${successful}/${results.length} succeeded.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[scraper-runner] Fatal runner error:', err);
      process.exit(1);
    });
}
