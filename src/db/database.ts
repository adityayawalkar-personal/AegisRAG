import Database, { type Database as DatabaseType } from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

export type RunStatusType = 'HEALTHY' | 'DIVERGENT' | 'SOFT_FAILURE' | 'SCHEMA_CORRUPTED' | 'FAILED';

export interface RawRunRecord {
  run_id: string;
  source_id: string;
  collector_id: string;
  target_url: string;
  status: 'SUCCESS' | 'FAILED';
  raw_payload: string | null;
  row_count: number;
  error_message: string | null;
  execution_duration_ms: number;
  completed_at: string;
}

export interface RunStatusRecord {
  status_id: string;
  run_id: string;
  source_id: string;
  status: RunStatusType;
  failed_fields: string; // JSON string array
  diff_summary: string;
  metrics: string; // JSON object
  validated_at: string;
}

const DEFAULT_DB_DIR = path.join(process.cwd(), 'data');
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'aegisrag.db');

let defaultDbInstance: DatabaseType | null = null;

export function getDatabase(dbPath: string = DEFAULT_DB_PATH): DatabaseType {
  if (dbPath === DEFAULT_DB_PATH && defaultDbInstance) {
    return defaultDbInstance;
  }

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  initSchema(db);

  if (dbPath === DEFAULT_DB_PATH) {
    defaultDbInstance = db;
  }

  return db;
}

export function initSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS raw_runs (
      run_id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      collector_id TEXT NOT NULL,
      target_url TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('SUCCESS', 'FAILED')),
      raw_payload TEXT,
      row_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      execution_duration_ms INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS run_status (
      status_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('HEALTHY', 'DIVERGENT', 'SOFT_FAILURE', 'SCHEMA_CORRUPTED', 'FAILED')),
      failed_fields TEXT NOT NULL,
      diff_summary TEXT NOT NULL,
      metrics TEXT NOT NULL,
      validated_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES raw_runs(run_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_raw_runs_source_completed 
    ON raw_runs(source_id, completed_at DESC);

    CREATE INDEX IF NOT EXISTS idx_raw_runs_status 
    ON raw_runs(status);

    CREATE INDEX IF NOT EXISTS idx_run_status_source_validated 
    ON run_status(source_id, validated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_run_status_run_id 
    ON run_status(run_id);
  `);
}

export function insertRawRun(record: RawRunRecord, db: DatabaseType = getDatabase()): void {
  const stmt = db.prepare(`
    INSERT INTO raw_runs (
      run_id,
      source_id,
      collector_id,
      target_url,
      status,
      raw_payload,
      row_count,
      error_message,
      execution_duration_ms,
      completed_at
    ) VALUES (
      @run_id,
      @source_id,
      @collector_id,
      @target_url,
      @status,
      @raw_payload,
      @row_count,
      @error_message,
      @execution_duration_ms,
      @completed_at
    )
  `);

  stmt.run(record);
}

export function insertRunStatus(record: RunStatusRecord, db: DatabaseType = getDatabase()): void {
  const stmt = db.prepare(`
    INSERT INTO run_status (
      status_id,
      run_id,
      source_id,
      status,
      failed_fields,
      diff_summary,
      metrics,
      validated_at
    ) VALUES (
      @status_id,
      @run_id,
      @source_id,
      @status,
      @failed_fields,
      @diff_summary,
      @metrics,
      @validated_at
    )
  `);

  stmt.run(record);
}

export function getLatestRuns(
  sourceId: string,
  limit: number = 10,
  db: DatabaseType = getDatabase()
): RawRunRecord[] {
  const stmt = db.prepare(`
    SELECT * FROM raw_runs 
    WHERE source_id = ? 
    ORDER BY completed_at DESC 
    LIMIT ?
  `);

  return stmt.all(sourceId, limit) as RawRunRecord[];
}

export function getLatestSuccessfulRuns(
  sourceId: string,
  limit: number = 5,
  db: DatabaseType = getDatabase()
): RawRunRecord[] {
  const stmt = db.prepare(`
    SELECT * FROM raw_runs 
    WHERE source_id = ? AND status = 'SUCCESS'
    ORDER BY completed_at DESC 
    LIMIT ?
  `);

  return stmt.all(sourceId, limit) as RawRunRecord[];
}

export function getRunById(
  runId: string,
  db: DatabaseType = getDatabase()
): RawRunRecord | undefined {
  const stmt = db.prepare(`
    SELECT * FROM raw_runs WHERE run_id = ?
  `);

  return stmt.get(runId) as RawRunRecord | undefined;
}

export function getLatestRunStatus(
  sourceId: string,
  limit: number = 10,
  db: DatabaseType = getDatabase()
): RunStatusRecord[] {
  const stmt = db.prepare(`
    SELECT * FROM run_status 
    WHERE source_id = ? 
    ORDER BY validated_at DESC 
    LIMIT ?
  `);

  return stmt.all(sourceId, limit) as RunStatusRecord[];
}

export function getRunStatusByRunId(
  runId: string,
  db: DatabaseType = getDatabase()
): RunStatusRecord | undefined {
  const stmt = db.prepare(`
    SELECT * FROM run_status WHERE run_id = ?
  `);

  return stmt.get(runId) as RunStatusRecord | undefined;
}

export function countRuns(
  sourceId?: string,
  db: DatabaseType = getDatabase()
): number {
  if (sourceId) {
    const stmt = db.prepare(`SELECT COUNT(*) as count FROM raw_runs WHERE source_id = ?`);
    const result = stmt.get(sourceId) as { count: number };
    return result.count;
  }
  const stmt = db.prepare(`SELECT COUNT(*) as count FROM raw_runs`);
  const result = stmt.get() as { count: number };
  return result.count;
}
