import { describe, it, expect } from 'vitest';
import { canTransition, validateStateTransition, InvalidStateTransitionError } from '../src/healing/state-machine.js';

describe('Collector State Machine', () => {
  it('allows valid lifecycle state transitions', () => {
    expect(canTransition('HEALTHY', 'DEGRADED')).toBe(true);
    expect(canTransition('DEGRADED', 'HEALING')).toBe(true);
    expect(canTransition('HEALING', 'RECOVERED')).toBe(true);
    expect(canTransition('RECOVERED', 'HEALTHY')).toBe(true);
    expect(canTransition('HEALING', 'DEGRADED')).toBe(true);
    expect(canTransition('DEGRADED', 'DEGRADED_PERMANENT')).toBe(true);
    expect(canTransition('DEGRADED_PERMANENT', 'HEALTHY')).toBe(true);
  });

  it('allows idempotent state transitions (same state to same state)', () => {
    expect(canTransition('HEALTHY', 'HEALTHY')).toBe(true);
    expect(canTransition('DEGRADED', 'DEGRADED')).toBe(true);
    expect(canTransition('HEALING', 'HEALING')).toBe(true);
  });

  it('rejects illegal transitions and throws InvalidStateTransitionError', () => {
    // Cannot skip from HEALTHY directly to RECOVERED or HEALING
    expect(canTransition('HEALTHY', 'RECOVERED')).toBe(false);
    expect(canTransition('HEALTHY', 'HEALING')).toBe(false);
    expect(canTransition('HEALTHY', 'DEGRADED_PERMANENT')).toBe(false);

    // Cannot transition from DEGRADED_PERMANENT to anything except HEALTHY (via manual reset)
    expect(canTransition('DEGRADED_PERMANENT', 'HEALING')).toBe(false);
    expect(canTransition('DEGRADED_PERMANENT', 'RECOVERED')).toBe(false);

    expect(() => validateStateTransition('HEALTHY', 'RECOVERED', 'c_test')).toThrow(InvalidStateTransitionError);
    expect(() => validateStateTransition('DEGRADED_PERMANENT', 'HEALING', 'c_test')).toThrow(InvalidStateTransitionError);
  });
});
