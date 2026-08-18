import { type Database as DatabaseType } from 'better-sqlite3';
import { getDatabase, getCollectorState, setCollectorState, type CollectorStateRecord } from '../db/database.js';
import { validateStateTransition } from './state-machine.js';

export const MAX_CONSECUTIVE_HEAL_FAILURES = 3;

export class CircuitBreakerTrippedError extends Error {
  constructor(public collectorId: string, public failureCount: number) {
    super(
      `Circuit breaker tripped for collector '${collectorId}' after ${failureCount} consecutive failed/rejected heal attempts. Collector is locked in DEGRADED_PERMANENT. Manual reset required.`
    );
    this.name = 'CircuitBreakerTrippedError';
  }
}

export class CircuitBreaker {
  constructor(private db: DatabaseType = getDatabase()) {}

  public getState(collectorId: string): CollectorStateRecord {
    return getCollectorState(collectorId, this.db);
  }

  public isTripped(collectorId: string): boolean {
    const state = this.getState(collectorId);
    return state.status === 'DEGRADED_PERMANENT' || state.consecutive_failures >= MAX_CONSECUTIVE_HEAL_FAILURES;
  }

  public recordSuccess(collectorId: string): CollectorStateRecord {
    const current = this.getState(collectorId);
    const nextStatus = current.status === 'HEALING' ? 'RECOVERED' : 'HEALTHY';
    validateStateTransition(current.status, nextStatus, collectorId);

    const updated: CollectorStateRecord = {
      ...current,
      status: nextStatus,
      consecutive_failures: 0,
      last_healed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    setCollectorState(updated, this.db);
    return updated;
  }

  public recordFailure(collectorId: string, reason?: string): CollectorStateRecord {
    const current = this.getState(collectorId);
    const newFailureCount = current.consecutive_failures + 1;
    const shouldTrip = newFailureCount >= MAX_CONSECUTIVE_HEAL_FAILURES;
    const nextStatus = shouldTrip ? 'DEGRADED_PERMANENT' : 'DEGRADED';

    validateStateTransition(current.status, nextStatus, collectorId);

    const updated: CollectorStateRecord = {
      ...current,
      status: nextStatus,
      consecutive_failures: newFailureCount,
      updated_at: new Date().toISOString(),
    };

    setCollectorState(updated, this.db);

    if (shouldTrip) {
      console.warn(
        `[circuit-breaker] ⚡ CIRCUIT BREAKER TRIPPED for collector '${collectorId}' (${newFailureCount}/${MAX_CONSECUTIVE_HEAL_FAILURES} failures). Status set to DEGRADED_PERMANENT. ${reason || ''}`
      );
    }

    return updated;
  }

  public reset(collectorId: string): CollectorStateRecord {
    const current = this.getState(collectorId);
    validateStateTransition(current.status, 'HEALTHY', collectorId);

    const resetState: CollectorStateRecord = {
      collector_id: collectorId,
      status: 'HEALTHY',
      consecutive_failures: 0,
      last_healed_at: current.last_healed_at,
      updated_at: new Date().toISOString(),
    };

    setCollectorState(resetState, this.db);
    console.log(`[circuit-breaker] 🔄 Circuit breaker manually reset for collector '${collectorId}'. Status: HEALTHY.`);
    return resetState;
  }
}
