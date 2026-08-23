import { type SentinelReport } from './types.js';
import { type GoldenVerificationSummary } from '../healing/golden-comparison.js';

export interface HealthDeduction {
  dimension: 'completeness' | 'type_validity' | 'baseline_drift' | 'bot_challenge' | 'golden_verification';
  points: number;
  reason: string;
}

export interface HealthScoreResult {
  score: number; // 0 to 100
  rating: 'HEALTHY' | 'DEGRADED' | 'CRITICAL';
  deductions: HealthDeduction[];
  timestamp: string;
}

/**
 * Computes a transparent, deterministic Health Score (0-100) from observable Sentinel signals.
 * Zero LLM-hallucinated scoring: every point deducted maps to an explicit validation breach.
 */
export function computeHealthScore(
  sentinelReport: SentinelReport,
  goldenSummary?: GoldenVerificationSummary
): HealthScoreResult {
  let score = 100;
  const deductions: HealthDeduction[] = [];

  // 1. Raw Execution / Schema Failure
  if (sentinelReport.status === 'FAILED') {
    deductions.push({
      dimension: 'completeness',
      points: 100,
      reason: `Raw extraction execution failed: ${sentinelReport.diffSummary}`,
    });
    return {
      score: 0,
      rating: 'CRITICAL',
      deductions,
      timestamp: new Date().toISOString(),
    };
  }

  // 2. Soft Failure / Bot Wall / CAPTCHA Challenge
  if (sentinelReport.status === 'SOFT_FAILURE') {
    const pts = 60;
    score -= pts;
    deductions.push({
      dimension: 'bot_challenge',
      points: pts,
      reason: 'Output resembles bot wall or Cloudflare challenge page (BLOCKED classification)',
    });
  }

  // 3. Schema & Field Completeness Failure
  const failureRate = sentinelReport.metrics.failureRatePct || 0;
  if (failureRate > 0) {
    // Deduct proportional points (up to 40)
    const pts = Math.min(40, Math.round(failureRate * 0.4));
    score -= pts;
    deductions.push({
      dimension: 'completeness',
      points: pts,
      reason: `${failureRate}% of expected schema fields failed validation (${sentinelReport.failedFields.length} field(s): [${sentinelReport.failedFields.join(', ')}])`,
    });
  }

  // 4. Baseline Drift Detections
  const ruleBreakdowns = sentinelReport.metrics.ruleBreakdowns || {};
  const driftRule = ruleBreakdowns['baseline_drift_comparison'] as { passed?: boolean; failedFields?: string[] } | undefined;
  if (driftRule && !driftRule.passed && driftRule.failedFields && driftRule.failedFields.length > 0) {
    const pts = 15;
    score -= pts;
    deductions.push({
      dimension: 'baseline_drift',
      points: pts,
      reason: `Statistical drift detected against 5-run median baseline in [${driftRule.failedFields.join(', ')}]`,
    });
  }

  // 5. Post-Heal Golden-Row Verification Breaches
  if (goldenSummary && !goldenSummary.isVerified && goldenSummary.discrepancies.length > 0) {
    const pts = Math.min(30, goldenSummary.discrepancies.length * 10);
    score -= pts;
    deductions.push({
      dimension: 'golden_verification',
      points: pts,
      reason: `${goldenSummary.discrepancies.length} field(s) breached golden snapshot tolerance band`,
    });
  }

  // Final score clamping
  const finalScore = Math.max(0, Math.min(100, score));

  let rating: HealthScoreResult['rating'] = 'HEALTHY';
  if (finalScore < 50) {
    rating = 'CRITICAL';
  } else if (finalScore < 80) {
    rating = 'DEGRADED';
  }

  return {
    score: finalScore,
    rating,
    deductions,
    timestamp: new Date().toISOString(),
  };
}
