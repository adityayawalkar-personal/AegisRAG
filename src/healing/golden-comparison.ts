import fs from 'node:fs';
import path from 'node:path';

export interface GoldenDiscrepancy {
  collectorId: string;
  rowIndex: number;
  field: string;
  goldenValue: unknown;
  actualValue: unknown;
  isBeyondTolerance: boolean;
  reason?: string;
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
 * Compares post-heal verification or preview rows against the golden snapshot.
 * Evaluates field-level agreement and identifies deviations beyond tolerance bands.
 */
export function compareAgainstGoldenSnapshot(
  collectorId: string,
  actualRows: Record<string, unknown>[],
  fixturesDir?: string,
  tolerancePct: number = 20
): GoldenDiscrepancy[] {
  if (!Array.isArray(actualRows) || actualRows.length === 0) {
    return [];
  }

  const dir = fixturesDir || path.join(process.cwd(), 'fixtures');
  const collectorFixturePath = path.join(dir, `${collectorId}.json`);
  const defaultFixturePath = path.join(dir, 'golden-run.json');

  let fixtureContent = '';
  if (fs.existsSync(collectorFixturePath)) {
    fixtureContent = fs.readFileSync(collectorFixturePath, 'utf-8');
  } else if (fs.existsSync(defaultFixturePath)) {
    fixtureContent = fs.readFileSync(defaultFixturePath, 'utf-8');
  } else {
    return [];
  }

  let goldenRows: Record<string, unknown>[] = [];
  try {
    const parsed = JSON.parse(fixtureContent);
    if (Array.isArray(parsed)) {
      goldenRows = parsed;
    }
  } catch {
    return [];
  }

  const discrepancies: GoldenDiscrepancy[] = [];

  for (let i = 0; i < actualRows.length; i++) {
    const actualRow = actualRows[i];
    const goldenRow = goldenRows[i];
    if (!actualRow || !goldenRow) continue;

    for (const [field, goldenVal] of Object.entries(goldenRow)) {
      if (goldenVal === undefined) continue;
      const actualVal = actualRow[field];
      if (actualVal === undefined) continue;

      const { withinTolerance, reason } = isValueWithinTolerance(goldenVal, actualVal, tolerancePct);
      if (!withinTolerance) {
        discrepancies.push({
          collectorId,
          rowIndex: i,
          field,
          goldenValue: goldenVal,
          actualValue: actualVal,
          isBeyondTolerance: true,
          reason,
        });
      }
    }
  }

  if (discrepancies.length > 0) {
    console.warn(
      `[heal-loop] ⚠️ Golden Snapshot Discrepancy detected for collector '${collectorId}' (${discrepancies.length} field mismatch(es) beyond tolerance):`
    );
    for (const d of discrepancies) {
      console.warn(
        `  - Collector '${d.collectorId}' [Field '${d.field}' at Row ${d.rowIndex}]: Golden = ${JSON.stringify(d.goldenValue)}, Actual = ${JSON.stringify(d.actualValue)} (${d.reason})`
      );
    }
  } else {
    console.log(`[heal-loop] ✨ Golden snapshot comparison: verified match within tolerance for collector '${collectorId}'.`);
  }

  return discrepancies;
}
