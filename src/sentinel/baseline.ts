import { type Database as DatabaseType } from 'better-sqlite3';
import { getDatabase, getLatestSuccessfulRuns } from '../db/database.js';
import { type SourceConfig } from '../config/sources.js';
import { type BaselineMetrics, type FieldBaselineMetrics } from './types.js';

export function calculateMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function computeRollingBaseline(
  sourceConfig: SourceConfig,
  db: DatabaseType = getDatabase()
): BaselineMetrics {
  const windowSize = sourceConfig.validation_thresholds.baseline_window || 5;
  const successfulRuns = getLatestSuccessfulRuns(sourceConfig.source_id, windowSize, db);

  if (successfulRuns.length === 0) {
    // Empty default baseline if no historical runs exist yet
    const emptyFields: Record<string, FieldBaselineMetrics> = {};
    for (const field of sourceConfig.expected_fields) {
      emptyFields[field] = {
        medianLength: 0,
        medianNullRate: 0,
        observedTypes: [],
      };
    }
    return {
      sampleSize: 0,
      medianRowCount: 0,
      fields: emptyFields,
    };
  }

  const rowCounts: number[] = [];
  const fieldNullRates: Record<string, number[]> = {};
  const fieldLengths: Record<string, number[]> = {};
  const fieldTypes: Record<string, Set<string>> = {};

  for (const field of sourceConfig.expected_fields) {
    fieldNullRates[field] = [];
    fieldLengths[field] = [];
    fieldTypes[field] = new Set<string>();
  }

  for (const run of successfulRuns) {
    rowCounts.push(run.row_count);
    if (!run.raw_payload) continue;

    let rows: Record<string, unknown>[] = [];
    try {
      const parsed = JSON.parse(run.raw_payload);
      rows = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      continue;
    }

    if (rows.length === 0) continue;

    for (const field of sourceConfig.expected_fields) {
      let nullsInRun = 0;
      let totalLengthInRun = 0;
      let nonNullCountInRun = 0;

      for (const row of rows) {
        const val = row[field];
        if (val === null || val === undefined || val === '') {
          nullsInRun++;
        } else {
          nonNullCountInRun++;
          const strVal = String(val);
          totalLengthInRun += strVal.length;
          fieldTypes[field].add(typeof val);
        }
      }

      fieldNullRates[field].push(nullsInRun / rows.length);
      if (nonNullCountInRun > 0) {
        fieldLengths[field].push(totalLengthInRun / nonNullCountInRun);
      }
    }
  }

  const fieldsMetrics: Record<string, FieldBaselineMetrics> = {};
  for (const field of sourceConfig.expected_fields) {
    fieldsMetrics[field] = {
      medianNullRate: calculateMedian(fieldNullRates[field] || []),
      medianLength: calculateMedian(fieldLengths[field] || []),
      observedTypes: Array.from(fieldTypes[field] || []),
    };
  }

  return {
    sampleSize: successfulRuns.length,
    medianRowCount: calculateMedian(rowCounts),
    fields: fieldsMetrics,
  };
}
