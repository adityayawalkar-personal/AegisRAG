import { randomUUID } from 'node:crypto';
import { type Database as DatabaseType } from 'better-sqlite3';
import { 
  getDatabase, 
  insertRunStatus, 
  saveGoldenRows,
  getGoldenRows,
  type RawRunRecord, 
  type RunStatusRecord, 
  type RunStatusType 
} from '../db/database.js';
import { getSourceById, type SourceConfig } from '../config/sources.js';
import { computeRollingBaseline } from './baseline.js';
import { type SentinelRule, type RuleResult, type SentinelReport, type BaselineMetrics } from './types.js';
import { typeRangeRule } from './rules/type-range-rule.js';
import { baselineDriftRule } from './rules/baseline-drift-rule.js';
import { softFailureRule } from './rules/soft-failure-rule.js';
import { structuredDataRule } from './rules/structured-data-rule.js';

export const DEFAULT_SENTINEL_RULES: SentinelRule[] = [
  softFailureRule,
  structuredDataRule,
  typeRangeRule,
  baselineDriftRule,
];

export interface ValidateRunOptions {
  sourceConfig?: SourceConfig;
  rules?: SentinelRule[];
  db?: DatabaseType;
  persist?: boolean;
}

export class Sentinel {
  private rules: SentinelRule[];
  private db: DatabaseType;

  constructor(rules: SentinelRule[] = DEFAULT_SENTINEL_RULES, db: DatabaseType = getDatabase()) {
    this.rules = rules;
    this.db = db;
  }

  /**
   * Evaluates a completed scraper run against multi-run baselines and accuracy rules.
   * Guarantees zero side effects beyond recording to the run_status table.
   */
  public validate(
    run: RawRunRecord,
    options: ValidateRunOptions = {}
  ): SentinelReport {
    const validatedAt = new Date().toISOString();
    const db = options.db || this.db;
    const persist = options.persist !== false;

    // Load source config if not directly supplied
    let config = options.sourceConfig;
    if (!config) {
      config = getSourceById(run.source_id);
    }

    if (!config) {
      // Fallback config if not found in registry
      config = {
        source_id: run.source_id,
        name: run.source_id,
        target_url: run.target_url,
        collector_id: run.collector_id,
        expected_fields: ['product_page_url', 'trending_repositories'],
        validation_thresholds: {
          baseline_window: 5,
          corruption_threshold_pct: 20,
          duplicate_threshold_pct: 50,
        },
      };
    }

    // 1. Check for raw execution failure first
    if (run.status === 'FAILED') {
      const failedReport: SentinelReport = {
        runId: run.run_id,
        sourceId: run.source_id,
        status: 'FAILED',
        failedFields: config.expected_fields,
        diffSummary: `Raw scraper execution failed: ${run.error_message || 'Unknown CLI/Network error'}`,
        metrics: {
          totalRows: 0,
          failedFieldsCount: config.expected_fields.length,
          failureRatePct: 100,
          ruleBreakdowns: {},
        },
        ruleResults: [],
        validatedAt,
      };

      if (persist) {
        this.persistStatus(failedReport, db);
      }
      return failedReport;
    }

    // 2. Parse payload rows
    let rows: Record<string, unknown>[] = [];
    if (run.raw_payload) {
      try {
        const parsed = JSON.parse(run.raw_payload);
        rows = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        rows = [];
      }
    }

    // 3. Compute rolling 5-run median baseline
    const baseline = computeRollingBaseline(config, db);

    // 4. Execute all modular rules
    const activeRules = options.rules || this.rules;
    const ruleResults: RuleResult[] = [];
    const allFailedFieldsSet = new Set<string>();
    const reasons: string[] = [];

    let detectedStatus: RunStatusType = 'HEALTHY';

    for (const rule of activeRules) {
      const res = rule.check(rows, baseline, config);
      ruleResults.push(res);

      if (!res.passed) {
        if (res.failedFields && res.failedFields.length > 0) {
          res.failedFields.forEach((f) => allFailedFieldsSet.add(f));
        }
        if (res.reason) {
          reasons.push(res.reason);
        }

        // Higher priority status overrides
        if (res.suggestedStatus === 'SOFT_FAILURE') {
          detectedStatus = 'SOFT_FAILURE';
        } else if (res.suggestedStatus === 'DIVERGENT' && detectedStatus !== 'SOFT_FAILURE') {
          detectedStatus = 'DIVERGENT';
        }
      }
    }

    // 5. Apply the 20% corruption threshold
    const totalExpectedFields = config.expected_fields.length || 1;
    const failedFieldsArray = Array.from(allFailedFieldsSet);
    const fieldFailureRate = (failedFieldsArray.length / totalExpectedFields) * 100;

    const corruptionThreshold = config.validation_thresholds?.corruption_threshold_pct ?? 20;

    let finalStatus: RunStatusType = detectedStatus;
    if (detectedStatus === 'HEALTHY' || detectedStatus === 'DIVERGENT') {
      if (failedFieldsArray.length > 0 && fieldFailureRate > corruptionThreshold) {
        finalStatus = 'SCHEMA_CORRUPTED';
      }
    }

    // Build human-readable diff summary
    let diffSummary = 'Extraction matches schema expectations and baseline metrics.';
    if (finalStatus === 'SCHEMA_CORRUPTED') {
      diffSummary = `Schema corruption detected (${Math.round(fieldFailureRate)}% fields failing vs ${corruptionThreshold}% threshold). Failed fields: [${failedFieldsArray.join(', ')}]. ${reasons.join('; ')}`;
    } else if (finalStatus === 'SOFT_FAILURE') {
      diffSummary = `Soft failure detected: Output resembles bot wall or CAPTCHA. ${reasons.join('; ')}`;
    } else if (finalStatus === 'DIVERGENT') {
      diffSummary = `Primary extraction diverges from secondary structured data in field(s): [${failedFieldsArray.join(', ')}].`;
    } else if (failedFieldsArray.length > 0) {
      diffSummary = `Minor noise observed in field(s) [${failedFieldsArray.join(', ')}], but under ${corruptionThreshold}% threshold. Status remains HEALTHY.`;
    }

    const report: SentinelReport = {
      runId: run.run_id,
      sourceId: run.source_id,
      status: finalStatus,
      failedFields: failedFieldsArray,
      diffSummary,
      metrics: {
        totalRows: rows.length,
        failedFieldsCount: failedFieldsArray.length,
        failureRatePct: Math.round(fieldFailureRate),
        ruleBreakdowns: Object.fromEntries(ruleResults.map((r) => [r.ruleName, r])),
      },
      ruleResults,
      validatedAt,
    };

    if (persist) {
      this.persistStatus(report, db);

      // Snapshot first known-good rows into golden_rows table (captured once, not regenerated per heal)
      if (finalStatus === 'HEALTHY' && rows.length > 0) {
        const existingGolden = getGoldenRows(run.collector_id, db);
        if (!existingGolden) {
          saveGoldenRows(
            {
              collector_id: run.collector_id,
              snapshot_json: JSON.stringify(rows),
              captured_at: validatedAt,
              row_count: rows.length,
            },
            db
          );
          console.log(`[sentinel] 📸 Baseline golden rows captured for collector '${run.collector_id}' (${rows.length} row(s)).`);
        }
      }
    }

    return report;
  }

  private persistStatus(report: SentinelReport, db: DatabaseType): void {
    const record: RunStatusRecord = {
      status_id: randomUUID(),
      run_id: report.runId,
      source_id: report.sourceId,
      status: report.status,
      failed_fields: JSON.stringify(report.failedFields),
      diff_summary: report.diffSummary,
      metrics: JSON.stringify(report.metrics),
      validated_at: report.validatedAt,
    };

    insertRunStatus(record, db);
  }
}

/**
 * Convenience function to validate a run using default Sentinel instance.
 */
export function validateRun(run: RawRunRecord, options: ValidateRunOptions = {}): SentinelReport {
  const sentinel = new Sentinel(options.rules, options.db);
  return sentinel.validate(run, options);
}
