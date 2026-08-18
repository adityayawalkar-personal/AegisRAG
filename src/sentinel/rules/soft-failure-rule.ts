import { type SentinelRule, type RuleResult, type BaselineMetrics } from '../types.js';
import { type SourceConfig } from '../../config/sources.js';
import { calculateRowDuplicateRatio } from '../similarity.js';

const BOT_WALL_KEYWORDS = [
  'captcha',
  'cf-ray',
  'cloudflare',
  'verify you are human',
  'robot',
  'access denied',
  'security check',
  'ddos-guard',
  'blocked',
  'attention required',
];

export const softFailureRule: SentinelRule = {
  name: 'soft_failure_detection',
  check: (
    rows: Record<string, unknown>[],
    _baseline: BaselineMetrics,
    config: SourceConfig
  ): RuleResult => {
    if (rows.length === 0) {
      return {
        passed: true,
        ruleName: 'soft_failure_detection',
        failedFields: [],
      };
    }

    // 1. Check for near-duplicate text across rows
    const duplicateThreshold = config.validation_thresholds.duplicate_threshold_pct / 100 || 0.5;
    const { duplicateRatio, duplicateCount } = calculateRowDuplicateRatio(rows);

    const isDuplicateWall = duplicateRatio >= duplicateThreshold && rows.length > 2;

    // 2. Check for bot wall / CAPTCHA keyword signatures
    let botKeywordMatchCount = 0;
    for (const row of rows) {
      const rowText = Object.values(row)
        .map((v) => (v ? String(v).toLowerCase() : ''))
        .join(' ');

      if (BOT_WALL_KEYWORDS.some((kw) => rowText.includes(kw))) {
        botKeywordMatchCount++;
      }
    }

    const hasBotKeywords = botKeywordMatchCount >= Math.max(1, Math.floor(rows.length * 0.5));

    const isSoftFailure = isDuplicateWall || hasBotKeywords;

    return {
      passed: !isSoftFailure,
      ruleName: 'soft_failure_detection',
      suggestedStatus: isSoftFailure ? 'SOFT_FAILURE' : undefined,
      failedFields: isSoftFailure ? config.expected_fields : [],
      reason: isSoftFailure
        ? isDuplicateWall
          ? `Soft failure detected: ${Math.round(duplicateRatio * 100)}% of rows contain near-duplicate content (likely block/CAPTCHA page)`
          : `Soft failure detected: ${botKeywordMatchCount}/${rows.length} rows matched bot-wall or access-denied keywords`
        : undefined,
      metrics: {
        duplicateRatio: Math.round(duplicateRatio * 100),
        duplicateCount,
        botKeywordMatchCount,
        totalRows: rows.length,
      },
    };
  },
};
