import { type RunStatusType } from '../db/database.js';
import { type SourceConfig } from '../config/sources.js';

export interface FieldBaselineMetrics {
  medianLength: number;
  medianNullRate: number;
  observedTypes: string[];
}

export interface BaselineMetrics {
  sampleSize: number;
  medianRowCount: number;
  fields: Record<string, FieldBaselineMetrics>;
}

export interface RuleResult {
  passed: boolean;
  ruleName: string;
  suggestedStatus?: RunStatusType;
  failedFields: string[];
  reason?: string;
  metrics?: Record<string, unknown>;
}

export interface SentinelRule {
  name: string;
  check: (payload: Record<string, unknown>[], baseline: BaselineMetrics, config: SourceConfig) => RuleResult;
}

export interface SentinelReport {
  runId: string;
  sourceId: string;
  status: RunStatusType;
  failedFields: string[];
  diffSummary: string;
  metrics: {
    totalRows: number;
    failedFieldsCount: number;
    failureRatePct: number;
    ruleBreakdowns: Record<string, unknown>;
  };
  ruleResults: RuleResult[];
  validatedAt: string;
}
