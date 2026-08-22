import fs from 'node:fs';
import path from 'node:path';

export interface GoldenDiscrepancy {
  collectorId: string;
  rowIndex: number;
  field: string;
  goldenValue: unknown;
  actualValue: unknown;
}

/**
 * Compares post-heal verification or preview rows against the golden snapshot.
 * Tier 1 detection only: Identifies and logs field-level disagreements without
 * altering control-flow or blocking the transition to RECOVERED.
 */
export function compareAgainstGoldenSnapshot(
  collectorId: string,
  actualRows: Record<string, unknown>[],
  fixturesDir?: string
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

      const isMismatch = JSON.stringify(actualVal) !== JSON.stringify(goldenVal);
      if (isMismatch) {
        discrepancies.push({
          collectorId,
          rowIndex: i,
          field,
          goldenValue: goldenVal,
          actualValue: actualVal,
        });
      }
    }
  }

  if (discrepancies.length > 0) {
    console.warn(
      `[heal-loop] ⚠️ Golden Snapshot Discrepancy detected for collector '${collectorId}' (${discrepancies.length} field mismatch(es)):`
    );
    for (const d of discrepancies) {
      console.warn(
        `  - Collector '${d.collectorId}' [Field '${d.field}' at Row ${d.rowIndex}]: Golden = ${JSON.stringify(d.goldenValue)}, Actual = ${JSON.stringify(d.actualValue)}`
      );
    }
  } else {
    console.log(`[heal-loop] ✨ Golden snapshot comparison: verified match for collector '${collectorId}'.`);
  }

  return discrepancies;
}
