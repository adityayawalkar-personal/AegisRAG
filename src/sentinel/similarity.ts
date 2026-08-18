/**
 * Fast, pure-TypeScript string similarity and duplicate content detection.
 * Used for detecting soft failures such as CAPTCHA walls and block pages.
 */

/**
 * Calculates Dice coefficient similarity between two strings (0.0 to 1.0).
 */
export function stringSimilarity(a: string, b: string): number {
  if (!a && !b) return 1.0;
  if (!a || !b) return 0.0;
  if (a === b) return 1.0;

  const str1 = a.toLowerCase().trim();
  const str2 = b.toLowerCase().trim();

  if (str1.length < 2 || str2.length < 2) {
    return str1 === str2 ? 1.0 : 0.0;
  }

  const bigrams1 = new Map<string, number>();
  for (let i = 0; i < str1.length - 1; i++) {
    const bigram = str1.substring(i, i + 2);
    bigrams1.set(bigram, (bigrams1.get(bigram) || 0) + 1);
  }

  let intersectionSize = 0;
  for (let i = 0; i < str2.length - 1; i++) {
    const bigram = str2.substring(i, i + 2);
    const count = bigrams1.get(bigram) || 0;
    if (count > 0) {
      bigrams1.set(bigram, count - 1);
      intersectionSize++;
    }
  }

  return (2.0 * intersectionSize) / (str1.length + str2.length - 2);
}

/**
 * Computes the fraction of rows that share high text similarity (> 0.75) with each other.
 * If more than threshold (e.g. 50%) of rows are near-duplicates, it indicates a block page or error template.
 */
export function calculateRowDuplicateRatio(
  rows: Record<string, unknown>[],
  similarityThreshold: number = 0.75
): { duplicateRatio: number; duplicateCount: number; maxDuplicateCluster: number } {
  if (rows.length <= 1) {
    return { duplicateRatio: 0, duplicateCount: 0, maxDuplicateCluster: 0 };
  }

  // Flatten each row into a concatenated text representation
  const rowTexts = rows.map((r) => {
    return Object.entries(r)
      .filter(([k]) => k !== 'input' && k !== 'run_id' && k !== 'id')
      .map(([, v]) => (v === null || v === undefined ? '' : String(v)))
      .join(' ')
      .trim();
  });

  let duplicatePairs = 0;
  let totalPairs = 0;
  const duplicateClusters = new Map<number, number>();

  for (let i = 0; i < rowTexts.length; i++) {
    for (let j = i + 1; j < rowTexts.length; j++) {
      totalPairs++;
      const textA = rowTexts[i];
      const textB = rowTexts[j];

      // Skip comparing two empty rows
      if (!textA && !textB) continue;

      const sim = stringSimilarity(textA, textB);
      if (sim >= similarityThreshold) {
        duplicatePairs++;
        duplicateClusters.set(i, (duplicateClusters.get(i) || 0) + 1);
        duplicateClusters.set(j, (duplicateClusters.get(j) || 0) + 1);
      }
    }
  }

  const uniqueDuplicateRows = duplicateClusters.size;
  const duplicateRatio = uniqueDuplicateRows / rows.length;
  const maxDuplicateCluster = duplicateClusters.size > 0 ? Math.max(...duplicateClusters.values()) + 1 : 0;

  return {
    duplicateRatio,
    duplicateCount: uniqueDuplicateRows,
    maxDuplicateCluster,
  };
}
