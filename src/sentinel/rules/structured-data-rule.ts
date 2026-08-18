import { type SentinelRule, type RuleResult, type BaselineMetrics } from '../types.js';
import { type SourceConfig } from '../../config/sources.js';
import { stringSimilarity } from '../similarity.js';

export const structuredDataRule: SentinelRule = {
  name: 'structured_data_cross_check',
  check: (
    rows: Record<string, unknown>[],
    _baseline: BaselineMetrics,
    _config: SourceConfig
  ): RuleResult => {
    if (rows.length === 0) {
      return {
        passed: true,
        ruleName: 'structured_data_cross_check',
        failedFields: [],
      };
    }

    const divergentFields: Set<string> = new Set();
    let checkedFieldsCount = 0;
    let mismatchedCount = 0;

    for (const row of rows) {
      // Look for secondary structured metadata (e.g. schema.org / OpenGraph / json_ld)
      const structuredRef =
        (row._structured_data as Record<string, unknown>) ||
        (row.json_ld as Record<string, unknown>) ||
        (row.open_graph as Record<string, unknown>);

      if (!structuredRef || typeof structuredRef !== 'object') {
        continue;
      }

      for (const [key, primaryVal] of Object.entries(row)) {
        if (key.startsWith('_') || key === 'json_ld' || key === 'open_graph') continue;
        const refVal = structuredRef[key];
        if (refVal === undefined || refVal === null || primaryVal === undefined || primaryVal === null) {
          continue;
        }

        checkedFieldsCount++;
        const strPrimary = String(primaryVal).trim();
        const strRef = String(refVal).trim();

        const sim = stringSimilarity(strPrimary, strRef);
        // If similarity is very low (< 0.4) on non-empty values, flag divergence
        if (sim < 0.4 && strPrimary.length > 2 && strRef.length > 2) {
          divergentFields.add(key);
          mismatchedCount++;
        }
      }
    }

    const isDivergent = divergentFields.size > 0 && mismatchedCount > 0;

    return {
      passed: !isDivergent,
      ruleName: 'structured_data_cross_check',
      suggestedStatus: isDivergent ? 'DIVERGENT' : undefined,
      failedFields: Array.from(divergentFields),
      reason: isDivergent
        ? `Structured data cross-check divergence detected in field(s): ${Array.from(divergentFields).join(', ')}`
        : undefined,
      metrics: {
        checkedFieldsCount,
        mismatchedCount,
        divergentFields: Array.from(divergentFields),
      },
    };
  },
};
