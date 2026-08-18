import { z } from 'zod';
import { type SentinelRule, type RuleResult, type BaselineMetrics } from '../types.js';
import { type SourceConfig } from '../../config/sources.js';

export const typeRangeRule: SentinelRule = {
  name: 'type_and_range_validation',
  check: (
    rows: Record<string, unknown>[],
    _baseline: BaselineMetrics,
    config: SourceConfig
  ): RuleResult => {
    if (rows.length === 0) {
      return {
        passed: false,
        ruleName: 'type_and_range_validation',
        failedFields: config.expected_fields,
        reason: 'Payload contains zero extracted rows',
        metrics: { invalidRowCount: 0, totalRows: 0 },
      };
    }

    const failedFieldCounts: Record<string, number> = {};
    for (const field of config.expected_fields) {
      failedFieldCounts[field] = 0;
    }

    let invalidRowCount = 0;

    for (const row of rows) {
      let rowHasError = false;

      for (const field of config.expected_fields) {
        const val = row[field];
        const fieldType = config.field_types?.[field] || 'string';

        if (val === null || val === undefined) {
          failedFieldCounts[field]++;
          rowHasError = true;
          continue;
        }

        let isValid = true;
        switch (fieldType) {
          case 'url':
            isValid = typeof val === 'string' && (val.startsWith('http://') || val.startsWith('https://') || val.startsWith('/'));
            break;
          case 'number':
            isValid = typeof val === 'number' && !isNaN(val) && val >= 0;
            break;
          case 'array':
            isValid = Array.isArray(val);
            break;
          case 'date':
            isValid = typeof val === 'string' && !isNaN(Date.parse(val));
            break;
          case 'string':
          default:
            isValid = typeof val === 'string' && val.trim().length > 0;
            break;
        }

        if (!isValid) {
          failedFieldCounts[field]++;
          rowHasError = true;
        }
      }

      if (rowHasError) {
        invalidRowCount++;
      }
    }

    const failedFields = Object.entries(failedFieldCounts)
      .filter(([, count]) => count > 0)
      .map(([field]) => field);

    const failureRate = invalidRowCount / rows.length;
    const passed = failedFields.length === 0;

    return {
      passed,
      ruleName: 'type_and_range_validation',
      failedFields,
      reason: passed
        ? undefined
        : `${failedFields.length} field(s) had type or range validation issues across ${invalidRowCount}/${rows.length} row(s)`,
      metrics: {
        invalidRowCount,
        totalRows: rows.length,
        failureRatePct: Math.round(failureRate * 100),
        failedFieldCounts,
      },
    };
  },
};
