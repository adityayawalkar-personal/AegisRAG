import { type SentinelRule, type RuleResult, type BaselineMetrics } from '../types.js';
import { type SourceConfig } from '../../config/sources.js';

export const baselineDriftRule: SentinelRule = {
  name: 'baseline_drift_comparison',
  check: (
    rows: Record<string, unknown>[],
    baseline: BaselineMetrics,
    config: SourceConfig
  ): RuleResult => {
    if (rows.length === 0 || baseline.sampleSize === 0) {
      return {
        passed: true,
        ruleName: 'baseline_drift_comparison',
        failedFields: [],
        metrics: { baselineSampleSize: baseline.sampleSize },
      };
    }

    const failedFields: string[] = [];
    const driftDetails: Record<string, unknown> = {};

    for (const field of config.expected_fields) {
      const fieldBaseline = baseline.fields[field];
      if (!fieldBaseline) continue;

      let nullCount = 0;
      let totalLength = 0;
      let nonNullCount = 0;

      for (const row of rows) {
        const val = row[field];
        if (val === null || val === undefined || val === '') {
          nullCount++;
        } else {
          nonNullCount++;
          totalLength += String(val).length;
        }
      }

      const currentNullRate = nullCount / rows.length;
      const currentAvgLength = nonNullCount > 0 ? totalLength / nonNullCount : 0;

      // Drift condition 1: Null rate increases by > 30% over baseline median
      const nullRateDrift = currentNullRate - fieldBaseline.medianNullRate;
      const hasNullRateDrift = nullRateDrift > 0.3 && currentNullRate > 0.3;

      // Drift condition 2: Non-empty field length collapses to near zero (< 20% of baseline median)
      const hasLengthCollapse =
        fieldBaseline.medianLength > 10 &&
        currentAvgLength < fieldBaseline.medianLength * 0.2 &&
        nonNullCount > 0;

      if (hasNullRateDrift || hasLengthCollapse) {
        failedFields.push(field);
      }

      driftDetails[field] = {
        baselineNullRate: fieldBaseline.medianNullRate,
        currentNullRate,
        baselineMedianLength: fieldBaseline.medianLength,
        currentAvgLength,
        hasNullRateDrift,
        hasLengthCollapse,
      };
    }

    const passed = failedFields.length === 0;

    return {
      passed,
      ruleName: 'baseline_drift_comparison',
      failedFields,
      reason: passed
        ? undefined
        : `Baseline drift detected in fields: ${failedFields.join(', ')}`,
      metrics: {
        baselineSampleSize: baseline.sampleSize,
        driftDetails,
      },
    };
  },
};
