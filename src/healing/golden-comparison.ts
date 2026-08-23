import fs from 'node:fs';
import path from 'node:path';
import { type Database as DatabaseType } from 'better-sqlite3';
import { getGoldenRows, getDatabase } from '../db/database.js';

export interface GoldenDiscrepancy {
  collectorId: string;
  rowIndex: number;
  rowIdentifier?: string;
  field: string;
  goldenValue: unknown;
  actualValue: unknown;
  isBeyondTolerance: boolean;
  reason?: string;
}

const IDENTIFIER_CANDIDATES = [
  'url',
  'product_page_url',
  'repo_name',
  'slug',
  'id',
  'title',
  'name',
  'link',
  'href',
];

/**
 * Finds the first stable structural identifier field present across rows.
 */
export function findRowIdentifierField(rows: Record<string, unknown>[]): string | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const sample = rows[0];
  if (!sample || typeof sample !== 'object') return null;

  for (const candidate of IDENTIFIER_CANDIDATES) {
    if (candidate in sample && sample[candidate] !== null && sample[candidate] !== undefined && String(sample[candidate]).trim() !== '') {
      return candidate;
    }
  }
  return null;
}

export interface GoldenVerificationSummary {
  collectorId: string;
  coveredFields: string[];
  uncoveredFields: string[];
  discrepancies: GoldenDiscrepancy[];
  isVerified: boolean;
  coveragePct: number;
  capturedAt?: string;
  source: 'database_golden_rows' | 'collector_fixture' | 'default_golden_run' | 'none';
  matchStrategy: 'structural_identifier' | 'array_index';
  identifierField?: string;
}

export interface CompareOptions {
  fixturesDir?: string;
  tolerancePct?: number;
  db?: DatabaseType;
  expectedFields?: string[];
}

/**
 * Checks whether two values are within acceptable tolerance:
 * - Strings / Enums / Arrays / Objects: Exact match
 * - Numbers / Formatted numeric strings (e.g. "245 stars today" vs "250 stars today"):
 *   Allow up to 20% natural variance for dynamic web counts.
 */
export function isValueWithinTolerance(
  goldenVal: unknown,
  actualVal: unknown,
  tolerancePct: number = 20
): { withinTolerance: boolean; reason?: string } {
  // If exact serialization match
  if (JSON.stringify(goldenVal) === JSON.stringify(actualVal)) {
    return { withinTolerance: true };
  }

  // Attempt numeric comparison if both contain numbers
  const numGolden = extractNumeric(goldenVal);
  const numActual = extractNumeric(actualVal);

  if (numGolden !== null && numActual !== null && numGolden > 0) {
    const pctDiff = (Math.abs(numActual - numGolden) / numGolden) * 100;
    if (pctDiff <= tolerancePct) {
      return {
        withinTolerance: true,
        reason: `Numeric variance ${pctDiff.toFixed(1)}% is within ${tolerancePct}% tolerance band`,
      };
    } else {
      return {
        withinTolerance: false,
        reason: `Numeric difference ${pctDiff.toFixed(1)}% exceeds ${tolerancePct}% tolerance band (golden: ${numGolden}, actual: ${numActual})`,
      };
    }
  }

  return {
    withinTolerance: false,
    reason: `Exact value mismatch: expected ${JSON.stringify(goldenVal)}, got ${JSON.stringify(actualVal)}`,
  };
}

function extractNumeric(val: unknown): number | null {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const cleaned = val.replace(/,/g, '');
    const match = cleaned.match(/[-+]?[0-9]*\.?[0-9]+/);
    if (match) {
      const parsed = parseFloat(match[0]);
      if (!isNaN(parsed)) return parsed;
    }
  }
  return null;
}

/**
 * Compares post-heal verification rows against golden reference snapshots (database `golden_rows` or fixtures).
 * Returns complete verification summary including covered vs uncovered fields and tolerance discrepancies.
 */
export function compareAgainstGoldenSnapshot(
  collectorId: string,
  actualRows: Record<string, unknown>[],
  options: CompareOptions | string = {}
): GoldenVerificationSummary {
  const opts: CompareOptions = typeof options === 'string' ? { fixturesDir: options } : options;
  const tolerancePct = opts.tolerancePct ?? 20;
  const db = opts.db || getDatabase();
  const dir = opts.fixturesDir || path.join(process.cwd(), 'fixtures');

  let goldenRows: Record<string, unknown>[] = [];
  let source: GoldenVerificationSummary['source'] = 'none';
  let capturedAt: string | undefined;

  // 1. Check SQLite golden_rows table first (captured during first HEALTHY run)
  try {
    const dbGolden = getGoldenRows(collectorId, db);
    if (dbGolden && dbGolden.snapshot_json) {
      const parsed = JSON.parse(dbGolden.snapshot_json);
      if (Array.isArray(parsed) && parsed.length > 0) {
        goldenRows = parsed;
        source = 'database_golden_rows';
        capturedAt = dbGolden.captured_at;
      }
    }
  } catch {
    // Fall back to file fixtures
  }

  // 2. Check collector-specific fixture file
  if (goldenRows.length === 0) {
    const collectorFixturePath = path.join(dir, `${collectorId}.json`);
    if (fs.existsSync(collectorFixturePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(collectorFixturePath, 'utf-8'));
        if (Array.isArray(parsed) && parsed.length > 0) {
          goldenRows = parsed;
          source = 'collector_fixture';
        }
      } catch {}
    }
  }

  // 3. Check default golden-run.json fixture file
  if (goldenRows.length === 0) {
    const defaultFixturePath = path.join(dir, 'golden-run.json');
    if (fs.existsSync(defaultFixturePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(defaultFixturePath, 'utf-8'));
        if (Array.isArray(parsed) && parsed.length > 0) {
          goldenRows = parsed;
          source = 'default_golden_run';
        }
      } catch {}
    }
  }

  if (goldenRows.length === 0 || !Array.isArray(actualRows) || actualRows.length === 0) {
    return {
      collectorId,
      coveredFields: [],
      uncoveredFields: opts.expectedFields || [],
      discrepancies: [],
      isVerified: true,
      coveragePct: 0,
      source: 'none',
      matchStrategy: 'array_index',
    };
  }

  // Determine structural identifier field if present (e.g. url, product_page_url, repo_name, slug)
  const identifierField = findRowIdentifierField(goldenRows) || findRowIdentifierField(actualRows) || undefined;
  const matchStrategy: GoldenVerificationSummary['matchStrategy'] = identifierField ? 'structural_identifier' : 'array_index';

  // Build a fast lookup map for golden rows by structural identifier
  const goldenRowsByKey = new Map<string, Record<string, unknown>>();
  if (identifierField) {
    for (const r of goldenRows) {
      if (r && r[identifierField] !== null && r[identifierField] !== undefined) {
        goldenRowsByKey.set(String(r[identifierField]).trim().toLowerCase(), r);
      }
    }
  }

  // Determine all fields in actual rows and golden rows
  const goldenFieldsSet = new Set<string>();
  for (const r of goldenRows) {
    Object.keys(r).forEach((k) => goldenFieldsSet.add(k));
  }

  const allRelevantFields = new Set<string>(opts.expectedFields || []);
  for (const r of actualRows) {
    Object.keys(r).forEach((k) => allRelevantFields.add(k));
  }

  const coveredFields: string[] = [];
  const uncoveredFields: string[] = [];

  for (const field of allRelevantFields) {
    if (goldenFieldsSet.has(field)) {
      coveredFields.push(field);
    } else {
      uncoveredFields.push(field);
    }
  }

  const discrepancies: GoldenDiscrepancy[] = [];

  for (let i = 0; i < actualRows.length; i++) {
    const actualRow = actualRows[i];
    if (!actualRow) continue;

    // Structural key lookup with fallback to array index
    let goldenRow: Record<string, unknown> | undefined;
    let rowIdentifier: string | undefined;

    if (identifierField && actualRow[identifierField] !== null && actualRow[identifierField] !== undefined) {
      rowIdentifier = String(actualRow[identifierField]).trim();
      goldenRow = goldenRowsByKey.get(rowIdentifier.toLowerCase());
    }

    if (!goldenRow) {
      goldenRow = goldenRows[i];
    }

    if (!goldenRow) continue;

    for (const field of coveredFields) {
      const goldenVal = goldenRow[field];
      const actualVal = actualRow[field];
      if (goldenVal === undefined || actualVal === undefined) continue;

      const { withinTolerance, reason } = isValueWithinTolerance(goldenVal, actualVal, tolerancePct);
      if (!withinTolerance) {
        discrepancies.push({
          collectorId,
          rowIndex: i,
          rowIdentifier,
          field,
          goldenValue: goldenVal,
          actualValue: actualVal,
          isBeyondTolerance: true,
          reason,
        });
      }
    }
  }

  const totalFieldsCount = coveredFields.length + uncoveredFields.length;
  const coveragePct = totalFieldsCount > 0 ? Math.round((coveredFields.length / totalFieldsCount) * 100) : 0;
  const isVerified = discrepancies.length === 0;

  if (discrepancies.length > 0) {
    console.warn(
      `[heal-loop] ⚠️ Golden Snapshot Discrepancy detected for collector '${collectorId}' (${discrepancies.length} field mismatch(es) beyond tolerance via ${matchStrategy}):`
    );
    for (const d of discrepancies) {
      console.warn(
        `  - Collector '${d.collectorId}' [Field '${d.field}' at Row ${d.rowIndex}${d.rowIdentifier ? ` (${d.rowIdentifier})` : ''}]: Golden = ${JSON.stringify(d.goldenValue)}, Actual = ${JSON.stringify(d.actualValue)} (${d.reason})`
      );
    }
  } else {
    console.log(
      `[heal-loop] ✨ Golden snapshot comparison verified for collector '${collectorId}' (${coveredFields.length} field(s) verified via ${matchStrategy}${identifierField ? ` on '${identifierField}'` : ''}, ${uncoveredFields.length} uncovered via source '${source}').`
    );
  }

  return {
    collectorId,
    coveredFields,
    uncoveredFields,
    discrepancies,
    isVerified,
    coveragePct,
    capturedAt,
    source,
    matchStrategy,
    identifierField,
  };
}
