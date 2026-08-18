import { type ChunkRecord } from '../db/database.js';

export interface BM25SearchResult {
  chunk: ChunkRecord;
  score: number;
  rank: number;
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'he',
  'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the', 'to', 'was', 'were', 'will', 'with'
]);

export function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

export class BM25Index {
  private documents: Map<string, ChunkRecord> = new Map();
  private docTokens: Map<string, string[]> = new Map();
  private docLengths: Map<string, number> = new Map();
  private avgDocLength: number = 0;
  private totalDocLength: number = 0;
  private docFreqs: Map<string, number> = new Map(); // Term -> number of documents containing term
  private k1: number;
  private b: number;

  constructor(k1: number = 1.2, b: number = 0.75) {
    this.k1 = k1;
    this.b = b;
  }

  public addChunk(chunk: ChunkRecord): void {
    if (this.documents.has(chunk.chunk_id)) {
      this.removeChunk(chunk.chunk_id);
    }

    const tokens = tokenize(chunk.content);
    this.documents.set(chunk.chunk_id, chunk);
    this.docTokens.set(chunk.chunk_id, tokens);
    this.docLengths.set(chunk.chunk_id, tokens.length);

    this.totalDocLength += tokens.length;
    this.avgDocLength = this.documents.size > 0 ? this.totalDocLength / this.documents.size : 0;

    const uniqueTokens = new Set(tokens);
    for (const token of uniqueTokens) {
      this.docFreqs.set(token, (this.docFreqs.get(token) || 0) + 1);
    }
  }

  public addChunks(chunks: ChunkRecord[]): void {
    for (const chunk of chunks) {
      this.addChunk(chunk);
    }
  }

  public removeChunk(chunkId: string): void {
    const tokens = this.docTokens.get(chunkId);
    if (!tokens) return;

    const uniqueTokens = new Set(tokens);
    for (const token of uniqueTokens) {
      const current = this.docFreqs.get(token) || 0;
      if (current <= 1) {
        this.docFreqs.delete(token);
      } else {
        this.docFreqs.set(token, current - 1);
      }
    }

    this.totalDocLength -= tokens.length;
    this.documents.delete(chunkId);
    this.docTokens.delete(chunkId);
    this.docLengths.delete(chunkId);

    this.avgDocLength = this.documents.size > 0 ? this.totalDocLength / this.documents.size : 0;
  }

  public removeChunksByCollectorAndSchemaVersion(collectorId: string, olderThanVersion: number): number {
    let removedCount = 0;
    for (const [chunkId, chunk] of this.documents.entries()) {
      if (chunk.collector_id === collectorId && chunk.schema_version < olderThanVersion) {
        this.removeChunk(chunkId);
        removedCount++;
      }
    }
    return removedCount;
  }

  public clear(): void {
    this.documents.clear();
    this.docTokens.clear();
    this.docLengths.clear();
    this.docFreqs.clear();
    this.totalDocLength = 0;
    this.avgDocLength = 0;
  }

  public size(): number {
    return this.documents.size;
  }

  public search(query: string, topK: number = 10): BM25SearchResult[] {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0 || this.documents.size === 0) {
      return [];
    }

    const N = this.documents.size;
    const scores: { chunk: ChunkRecord; score: number }[] = [];

    for (const [chunkId, docTokens] of this.docTokens.entries()) {
      const chunk = this.documents.get(chunkId)!;
      const docLen = this.docLengths.get(chunkId) || 0;
      let score = 0;

      // Calculate term frequencies in current document
      const termCounts = new Map<string, number>();
      for (const t of docTokens) {
        termCounts.set(t, (termCounts.get(t) || 0) + 1);
      }

      for (const qTerm of queryTokens) {
        const tf = termCounts.get(qTerm) || 0;
        if (tf === 0) continue;

        const df = this.docFreqs.get(qTerm) || 0;
        // IDF with smoothing
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));

        // BM25 term weighting
        const numerator = tf * (this.k1 + 1);
        const denominator = tf + this.k1 * (1 - this.b + this.b * (docLen / (this.avgDocLength || 1)));

        score += idf * (numerator / denominator);
      }

      if (score > 0) {
        scores.push({ chunk, score });
      }
    }

    scores.sort((a, b) => b.score - a.score);

    return scores.slice(0, topK).map((item, index) => ({
      chunk: item.chunk,
      score: item.score,
      rank: index + 1,
    }));
  }
}
