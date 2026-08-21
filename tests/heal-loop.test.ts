import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initiateHeal, approveHeal, rejectHeal, HealInProgressError } from '../src/healing/heal-loop.js';
import { CircuitBreaker, CircuitBreakerTrippedError } from '../src/healing/circuit-breaker.js';
import { initSchema, insertRawRun, type RawRunRecord } from '../src/db/database.js';
import { type SentinelReport } from '../src/sentinel/types.js';

describe('The Self-Healing Loop & Circuit Breaker', () => {
  let db: ReturnType<typeof Database>;

  const mockRun: RawRunRecord = {
    run_id: 'run-corrupted-123',
    source_id: 'github-trending',
    collector_id: 'c_heal_test_collector',
    target_url: 'https://github.com/trending',
    status: 'SUCCESS',
    raw_payload: JSON.stringify([{ repo_name: null, stars: null }]),
    row_count: 1,
    error_message: null,
    execution_duration_ms: 1200,
    completed_at: new Date().toISOString(),
  };

  const mockReport: SentinelReport = {
    runId: 'run-corrupted-123',
    sourceId: 'github-trending',
    status: 'SCHEMA_CORRUPTED',
    failedFields: ['repo_name', 'stars_today'],
    diffSummary: 'Schema corruption detected: fields [repo_name, stars_today] missing.',
    metrics: { totalRows: 1, failedFieldsCount: 2, failureRatePct: 100, ruleBreakdowns: {} },
    ruleResults: [],
    validatedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    insertRawRun(mockRun, db);
  });

  afterEach(() => {
    db.close();
  });

  it('initiates heal with Gemma diagnosis under 900 chars and captures awaiting_approval preview', async () => {
    const mockPreviewPayload = {
      status: 'awaiting_approval',
      preview_result: [
        { repo_name: 'healed-project/core', stars_today: '500 stars today' },
      ],
    };

    const mockCli = vi.fn().mockResolvedValue({
      stdout: JSON.stringify(mockPreviewPayload),
      stderr: '',
      exitCode: 0,
    });

    const result = await initiateHeal(mockRun, mockReport, {
      db,
      cliExecutor: mockCli,
    });

    expect(result.status).toBe('AWAITING_APPROVAL');
    expect(result.diagnosis.characterCount).toBeLessThan(900);
    expect(result.attempt.status).toBe('AWAITING_APPROVAL');
    expect(result.previewResult).toEqual(mockPreviewPayload);

    // Verify safe argument array was passed
    expect(mockCli).toHaveBeenCalledWith(
      'heal',
      expect.arrayContaining(['scraper', 'heal', 'c_heal_test_collector', expect.any(String), '--url', 'https://github.com/trending'])
    );

    const breaker = new CircuitBreaker(db);
    expect(breaker.getState('c_heal_test_collector').status).toBe('HEALING');
  });

  it('manually approves pending heal and transitions state to RECOVERED', async () => {
    const mockCli = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ status: 'awaiting_approval' }),
      stderr: '',
      exitCode: 0,
    });

    const initResult = await initiateHeal(mockRun, mockReport, { db, cliExecutor: mockCli });

    const approveCli = vi.fn().mockResolvedValue({
      stdout: 'Collector approved successfully.',
      stderr: '',
      exitCode: 0,
    });

    const approveResult = await approveHeal(initResult.attempt.attempt_id, {
      db,
      cliExecutor: approveCli,
    });

    expect(approveResult.success).toBe(true);
    expect(approveResult.attempt.status).toBe('APPROVED');
    expect(approveCli).toHaveBeenCalledWith('approve', ['scraper', 'approve', 'c_heal_test_collector']);

    const breaker = new CircuitBreaker(db);
    expect(breaker.getState('c_heal_test_collector').status).toBe('RECOVERED');
    expect(breaker.getState('c_heal_test_collector').consecutive_failures).toBe(0);
  });

  it('blocks concurrent heal executions on the same collector with HealInProgressError', async () => {
    let resolveCli: (value: { stdout: string; stderr: string; exitCode: number }) => void;
    const slowCliPromise = new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
      resolveCli = resolve;
    });

    const mockCli = vi.fn().mockReturnValue(slowCliPromise);

    // Start first heal (will pause awaiting slowCliPromise)
    const healPromise1 = initiateHeal(mockRun, mockReport, { db, cliExecutor: mockCli });

    // Attempt second overlapping heal on same collector -> must reject immediately with HealInProgressError
    await expect(
      initiateHeal(mockRun, mockReport, { db, cliExecutor: mockCli })
    ).rejects.toThrow(HealInProgressError);

    // Resolve first heal
    resolveCli!({ stdout: JSON.stringify({ status: 'awaiting_approval' }), stderr: '', exitCode: 0 });
    const res1 = await healPromise1;
    expect(res1.status).toBe('AWAITING_APPROVAL');

    // After first completes, subsequent heal call is allowed again
    const healPromise3 = await initiateHeal(mockRun, mockReport, {
      db,
      cliExecutor: vi.fn().mockResolvedValue({ stdout: '{}', stderr: '', exitCode: 0 }),
    });
    expect(healPromise3.status).toBe('AWAITING_APPROVAL');
  });

  it('records circuit breaker strike on rejection and trips after 3 consecutive strikes', async () => {
    const breaker = new CircuitBreaker(db);
    const mockCli = vi.fn().mockResolvedValue({ stdout: '{}', stderr: '', exitCode: 0 });

    // Strike 1
    const heal1 = await initiateHeal(mockRun, mockReport, { db, cliExecutor: mockCli });
    await rejectHeal(heal1.attempt.attempt_id, 'Strike 1', { db, cliExecutor: mockCli });
    expect(breaker.getState('c_heal_test_collector').consecutive_failures).toBe(1);
    expect(breaker.getState('c_heal_test_collector').status).toBe('DEGRADED');

    // Strike 2
    const heal2 = await initiateHeal(mockRun, mockReport, { db, cliExecutor: mockCli });
    await rejectHeal(heal2.attempt.attempt_id, 'Strike 2', { db, cliExecutor: mockCli });
    expect(breaker.getState('c_heal_test_collector').consecutive_failures).toBe(2);
    expect(breaker.getState('c_heal_test_collector').status).toBe('DEGRADED');

    // Strike 3 (Breaker Trips!)
    const heal3 = await initiateHeal(mockRun, mockReport, { db, cliExecutor: mockCli });
    await rejectHeal(heal3.attempt.attempt_id, 'Strike 3', { db, cliExecutor: mockCli });

    const trippedState = breaker.getState('c_heal_test_collector');
    expect(trippedState.consecutive_failures).toBe(3);
    expect(trippedState.status).toBe('DEGRADED_PERMANENT');
    expect(breaker.isTripped('c_heal_test_collector')).toBe(true);

    // Further heal attempts must be blocked
    await expect(initiateHeal(mockRun, mockReport, { db, cliExecutor: mockCli })).rejects.toThrow(
      CircuitBreakerTrippedError
    );

    // Manual reset restores breaker to HEALTHY
    breaker.reset('c_heal_test_collector');
    expect(breaker.getState('c_heal_test_collector').status).toBe('HEALTHY');
    expect(breaker.isTripped('c_heal_test_collector')).toBe(false);
  });
});
