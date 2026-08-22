import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { type Database as DatabaseType } from 'better-sqlite3';
import { 
  getDatabase, 
  insertHealAttempt, 
  updateHealAttempt, 
  getHealAttemptById,
  getLatestHealAttempts,
  setCollectorState,
  type RawRunRecord, 
  type HealAttemptRecord 
} from '../db/database.js';
import { getSourceById } from '../config/sources.js';
import { type SentinelReport } from '../sentinel/types.js';
import { CircuitBreaker, CircuitBreakerTrippedError } from './circuit-breaker.js';
import { generateHealDescription, type GemmaDiagnosisResult } from './gemma-client.js';
import { validateStateTransition } from './state-machine.js';
import { compareAgainstGoldenSnapshot, type GoldenDiscrepancy } from './golden-comparison.js';

export { compareAgainstGoldenSnapshot, type GoldenDiscrepancy };

export interface HealOptions {
  db?: DatabaseType;
  gemmaEndpoint?: string;
  cliExecutor?: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface HealInitiationResult {
  attempt: HealAttemptRecord;
  diagnosis: GemmaDiagnosisResult;
  previewResult: unknown | null;
  status: 'AWAITING_APPROVAL' | 'FAILED';
}

/**
 * In-memory mutex tracking active heal processes per collector.
 * Prevents concurrent heal triggers from racing on the same collector.
 */
const activeHealLocks = new Set<string>();

export class HealInProgressError extends Error {
  constructor(public collectorId: string) {
    super(`Heal already in progress for collector '${collectorId}'. Concurrent heal executions are blocked.`);
    this.name = 'HealInProgressError';
  }
}

/**
 * Resolves the installed @brightdata/cli JavaScript binary path.
 * Enables direct Node execution without shell wrappers or cmd.exe.
 */
export function resolveBdataCliBinary(): string {
  const localDist = path.join(process.cwd(), 'node_modules', '@brightdata', 'cli', 'dist', 'index.js');
  if (fs.existsSync(localDist)) {
    return localDist;
  }
  return 'bdata';
}

/**
 * Executes a Bright Data CLI heal/approve command safely via execFile argument arrays.
 * Standing Rule 1: Untrusted strings are strictly kept as isolated arguments in an array.
 * Security Note: shell: false is strictly enforced across all platforms (including Windows)
 * by invoking the node executable directly on the JS entrypoint.
 */
export async function defaultCliExecutor(
  _command: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const cliJsPath = resolveBdataCliBinary();
    const isDirectNode = cliJsPath.endsWith('.js');
    const binary = isDirectNode ? process.execPath : cliJsPath;
    const fullArgs = isDirectNode ? [cliJsPath, ...args] : args;

    execFile(
      binary,
      fullArgs,
      {
        timeout: 180000,
        maxBuffer: 10 * 1024 * 1024,
        shell: false, // Strict: Zero shell interpolation on all platforms
        cwd: process.cwd(),
        env: { ...process.env },
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
 * Initiates the self-healing workflow:
 * 1. Acquires concurrency lock on collector_id (fails fast on concurrent calls)
 * 2. Checks circuit breaker state
 * 3. Generates Gemma plain-language diagnosis (< 900 chars)
 * 4. Transitions state machine: (HEALTHY/RECOVERED) -> DEGRADED -> HEALING
 * 5. Triggers `bdata scraper heal` without --auto-approve
 * 6. Captures awaiting_approval envelope and preview_result
 */
export async function initiateHeal(
  run: RawRunRecord,
  sentinelReport: SentinelReport,
  options: HealOptions = {}
): Promise<HealInitiationResult> {
  const db = options.db || getDatabase();
  const breaker = new CircuitBreaker(db);
  const cliExec = options.cliExecutor || defaultCliExecutor;

  // 1. Concurrency Lock: Prevent overlapping heals on the same collector
  if (activeHealLocks.has(run.collector_id)) {
    throw new HealInProgressError(run.collector_id);
  }
  activeHealLocks.add(run.collector_id);

  try {
    // 2. Guard against tripped circuit breaker
    if (breaker.isTripped(run.collector_id)) {
      const state = breaker.getState(run.collector_id);
      throw new CircuitBreakerTrippedError(run.collector_id, state.consecutive_failures);
    }

    // 3. Load source configuration (Strict: throws if source config missing)
    const sourceConfig = getSourceById(run.source_id);
    if (!sourceConfig) {
      throw new Error(`Source configuration for source_id '${run.source_id}' not found. Cannot determine expected schema.`);
    }
    const expectedFields = sourceConfig.expected_fields;

    // 4. Generate Gemma plain-language repair description (< 900 chars)
    const diagnosis = await generateHealDescription(
      {
        collectorId: run.collector_id,
        targetUrl: run.target_url,
        failedFields: sentinelReport.failedFields,
        diffSummary: sentinelReport.diffSummary,
        expectedFields,
      },
      options.gemmaEndpoint
    );

    console.log(`[heal-loop] 🧠 Gemma Diagnosis (${diagnosis.characterCount} chars via ${diagnosis.generatedBy}): "${diagnosis.description}"`);

    // 5. Update collector state: (HEALTHY/RECOVERED) -> DEGRADED -> HEALING
    let currentState = breaker.getState(run.collector_id);
    if (currentState.status === 'HEALTHY' || currentState.status === 'RECOVERED') {
      validateStateTransition(currentState.status, 'DEGRADED', run.collector_id);
      currentState = {
        ...currentState,
        status: 'DEGRADED',
        updated_at: new Date().toISOString(),
      };
      setCollectorState(currentState, db);
    }

    validateStateTransition(currentState.status, 'HEALING', run.collector_id);
    setCollectorState(
      {
        ...currentState,
        status: 'HEALING',
        updated_at: new Date().toISOString(),
      },
      db
    );

    // 6. Execute bdata scraper heal with argument array (Standing Rule 1)
    console.log(`[heal-loop] 🛠️ Invoking CLI heal for collector '${run.collector_id}' on '${run.target_url}'...`);
    
    const healArgs = ['scraper', 'heal', run.collector_id, diagnosis.description, '--url', run.target_url, '--pretty'];
    const { stdout, stderr, exitCode } = await cliExec('heal', healArgs);

    const attemptId = randomUUID();
    const now = new Date().toISOString();
    const previousAttempts = getLatestHealAttempts(run.collector_id, 10, db);
    const attemptNumber = previousAttempts.length + 1;

    if (exitCode !== 0) {
      const errorMsg = `CLI heal exited with code ${exitCode}. Stderr: ${stderr.slice(0, 1000)}`;
      console.error(`[heal-loop] Heal attempt ${attemptId} failed: ${errorMsg}`);

      const failedAttempt: HealAttemptRecord = {
        attempt_id: attemptId,
        collector_id: run.collector_id,
        run_id: run.run_id,
        heal_description: diagnosis.description,
        preview_result: stdout || null,
        status: 'FAILED',
        error_message: errorMsg,
        attempt_number: attemptNumber,
        created_at: now,
        resolved_at: now,
        generated_by: diagnosis.generatedBy,
      };

      insertHealAttempt(failedAttempt, db);
      breaker.recordFailure(run.collector_id, errorMsg);

      return {
        attempt: failedAttempt,
        diagnosis,
        previewResult: null,
        status: 'FAILED',
      };
    }

    // Parse preview result from CLI stdout
    let previewJson: unknown = null;
    try {
      previewJson = JSON.parse(stdout);
    } catch {
      previewJson = stdout.trim() || null;
    }

    const awaitingAttempt: HealAttemptRecord = {
      attempt_id: attemptId,
      collector_id: run.collector_id,
      run_id: run.run_id,
      heal_description: diagnosis.description,
      preview_result: typeof previewJson === 'object' ? JSON.stringify(previewJson) : String(previewJson),
      status: 'AWAITING_APPROVAL',
      error_message: null,
      attempt_number: attemptNumber,
      created_at: now,
      resolved_at: null,
      generated_by: diagnosis.generatedBy,
    };

    insertHealAttempt(awaitingAttempt, db);

    console.log(`[heal-loop] ⏸️ Heal awaiting manual approval (Attempt ID: ${attemptId}). Preview captured.`);

    return {
      attempt: awaitingAttempt,
      diagnosis,
      previewResult: previewJson,
      status: 'AWAITING_APPROVAL',
    };
  } finally {
    // Release concurrency lock
    activeHealLocks.delete(run.collector_id);
  }
}

export interface ApproveHealResult {
  success: boolean;
  attempt: HealAttemptRecord;
  discrepancies?: GoldenDiscrepancy[];
}

/**
 * Manually approves a pending heal attempt, applying the repair to the live scraper.
 */
export async function approveHeal(
  attemptId: string,
  options: HealOptions & { verificationRows?: Record<string, unknown>[] } = {}
): Promise<ApproveHealResult> {
  const db = options.db || getDatabase();
  const cliExec = options.cliExecutor || defaultCliExecutor;
  const breaker = new CircuitBreaker(db);

  const attempt = getHealAttemptById(attemptId, db);
  if (!attempt) throw new Error(`Heal attempt '${attemptId}' not found.`);

  if (attempt.status !== 'AWAITING_APPROVAL') {
    throw new Error(`Cannot approve attempt in status '${attempt.status}'. Must be AWAITING_APPROVAL.`);
  }

  console.log(`[heal-loop] ✅ Approving heal attempt '${attemptId}' for collector '${attempt.collector_id}'...`);

  const approveArgs = ['scraper', 'approve', attempt.collector_id];
  const { stderr, exitCode } = await cliExec('approve', approveArgs);

  if (exitCode !== 0) {
    const errorMsg = `CLI approve exited with code ${exitCode}. Stderr: ${stderr.slice(0, 1000)}`;
    console.error(`[heal-loop] Approval failed: ${errorMsg}`);
    updateHealAttempt(attemptId, { status: 'FAILED', error_message: errorMsg, resolved_at: new Date().toISOString() }, db);
    breaker.recordFailure(attempt.collector_id, errorMsg);
    throw new Error(errorMsg);
  }

  const resolvedAt = new Date().toISOString();
  updateHealAttempt(attemptId, { status: 'APPROVED', resolved_at: resolvedAt }, db);
  breaker.recordSuccess(attempt.collector_id);

  // Tier 1 Detection: Compare new/preview row(s) against golden snapshot field-by-field
  let rowsToVerify: Record<string, unknown>[] = options.verificationRows || [];
  if (rowsToVerify.length === 0 && attempt.preview_result) {
    try {
      const parsed = JSON.parse(attempt.preview_result);
      if (Array.isArray(parsed)) {
        rowsToVerify = parsed;
      } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).preview_result)) {
        rowsToVerify = (parsed as Record<string, unknown>).preview_result as Record<string, unknown>[];
      }
    } catch {
      // Ignore parse error on non-JSON previews
    }
  }

  const discrepancies = compareAgainstGoldenSnapshot(attempt.collector_id, rowsToVerify);

  const updatedAttempt = getHealAttemptById(attemptId, db)!;
  console.log(`[heal-loop] 🎉 Heal approved successfully. Collector '${attempt.collector_id}' transitioned to RECOVERED.`);

  return {
    success: true,
    attempt: updatedAttempt,
    discrepancies,
  };
}

/**
 * Manually rejects a pending heal attempt, recording a failure strike against the circuit breaker.
 */
export async function rejectHeal(
  attemptId: string,
  reason: string = 'Manually rejected by operator',
  options: HealOptions = {}
): Promise<{ success: boolean; attempt: HealAttemptRecord }> {
  const db = options.db || getDatabase();
  const cliExec = options.cliExecutor || defaultCliExecutor;
  const breaker = new CircuitBreaker(db);

  const attempt = getHealAttemptById(attemptId, db);
  if (!attempt) throw new Error(`Heal attempt '${attemptId}' not found.`);

  console.log(`[heal-loop] ❌ Rejecting heal attempt '${attemptId}' for collector '${attempt.collector_id}'...`);

  const rejectArgs = ['scraper', 'approve', attempt.collector_id, '--reject'];
  await cliExec('reject', rejectArgs);

  const resolvedAt = new Date().toISOString();
  updateHealAttempt(attemptId, { status: 'REJECTED', error_message: reason, resolved_at: resolvedAt }, db);
  breaker.recordFailure(attempt.collector_id, reason);

  const updatedAttempt = getHealAttemptById(attemptId, db)!;
  console.log(`[heal-loop] Heal rejected. Strike recorded against circuit breaker.`);

  return {
    success: true,
    attempt: updatedAttempt,
  };
}
