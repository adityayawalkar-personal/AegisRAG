import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
import { getSourceById, type SourceConfig } from '../config/sources.js';
import { type SentinelReport } from '../sentinel/types.js';
import { CircuitBreaker, CircuitBreakerTrippedError } from './circuit-breaker.js';
import { generateHealDescription, type GemmaDiagnosisResult } from './gemma-client.js';
import { validateStateTransition } from './state-machine.js';

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
 * Executes a Bright Data CLI heal/approve command safely via execFile argument arrays.
 * Standing Rule 1: Untrusted strings are strictly kept as isolated arguments in an array.
 */
export async function defaultCliExecutor(
  _command: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const binary = isWindows ? 'npx.cmd' : 'npx';
    const fullArgs = ['-p', '@brightdata/cli', 'bdata', ...args];

    execFile(
      binary,
      fullArgs,
      {
        timeout: 180000,
        maxBuffer: 10 * 1024 * 1024,
        shell: isWindows, // Safe with argument arrays
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
 * 1. Checks circuit breaker state
 * 2. Generates Gemma plain-language diagnosis (< 900 chars)
 * 3. Transitions state machine: (HEALTHY/RECOVERED) -> DEGRADED -> HEALING
 * 4. Triggers `bdata scraper heal` without --auto-approve
 * 5. Captures awaiting_approval envelope and preview_result
 */
export async function initiateHeal(
  run: RawRunRecord,
  sentinelReport: SentinelReport,
  options: HealOptions = {}
): Promise<HealInitiationResult> {
  const db = options.db || getDatabase();
  const breaker = new CircuitBreaker(db);
  const cliExec = options.cliExecutor || defaultCliExecutor;

  // 1. Guard against tripped circuit breaker
  if (breaker.isTripped(run.collector_id)) {
    const state = breaker.getState(run.collector_id);
    throw new CircuitBreakerTrippedError(run.collector_id, state.consecutive_failures);
  }

  // 2. Load source configuration
  const sourceConfig = getSourceById(run.source_id);
  const expectedFields = sourceConfig?.expected_fields || sentinelReport.failedFields;

  // 3. Generate Gemma plain-language repair description (< 900 chars)
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

  // 4. Update collector state: (HEALTHY/RECOVERED) -> DEGRADED -> HEALING
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

  // 5. Execute bdata scraper heal with argument array (Standing Rule 1)
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
  };

  insertHealAttempt(awaitingAttempt, db);

  console.log(`[heal-loop] ⏸️ Heal awaiting manual approval (Attempt ID: ${attemptId}). Preview captured.`);

  return {
    attempt: awaitingAttempt,
    diagnosis,
    previewResult: previewJson,
    status: 'AWAITING_APPROVAL',
  };
}

/**
 * Manually approves a pending heal attempt, applying the repair to the live scraper.
 */
export async function approveHeal(
  attemptId: string,
  options: HealOptions = {}
): Promise<{ success: boolean; attempt: HealAttemptRecord }> {
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

  const updatedAttempt = getHealAttemptById(attemptId, db)!;
  console.log(`[heal-loop] 🎉 Heal approved successfully. Collector '${attempt.collector_id}' transitioned to RECOVERED.`);

  return {
    success: true,
    attempt: updatedAttempt,
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
