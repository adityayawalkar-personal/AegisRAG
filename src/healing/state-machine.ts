import { type CollectorStateType } from '../db/database.js';

export class InvalidStateTransitionError extends Error {
  constructor(public from: CollectorStateType, public to: CollectorStateType, public collectorId: string) {
    super(
      `Invalid collector state transition from '${from}' to '${to}' for collector '${collectorId}'. Allowed transitions are strictly constrained.`
    );
    this.name = 'InvalidStateTransitionError';
  }
}

/**
 * Explicit state transition table defining allowed collector lifecycle transitions:
 * HEALTHY -> DEGRADED -> HEALING -> RECOVERED -> HEALTHY
 * Terminal DEGRADED_PERMANENT on circuit breaker trip (manual reset only).
 */
export const ALLOWED_TRANSITIONS: Record<CollectorStateType, CollectorStateType[]> = {
  HEALTHY: ['DEGRADED'],
  DEGRADED: ['HEALING', 'DEGRADED_PERMANENT', 'HEALTHY'],
  HEALING: ['RECOVERED', 'DEGRADED', 'DEGRADED_PERMANENT'],
  RECOVERED: ['HEALTHY', 'DEGRADED'],
  DEGRADED_PERMANENT: ['HEALTHY'], // Manual reset only
};

export function canTransition(from: CollectorStateType, to: CollectorStateType): boolean {
  if (from === to) return true; // Idempotent transition
  const allowed = ALLOWED_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

export function validateStateTransition(
  from: CollectorStateType,
  to: CollectorStateType,
  collectorId: string
): void {
  if (!canTransition(from, to)) {
    throw new InvalidStateTransitionError(from, to, collectorId);
  }
}
