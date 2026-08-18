import { type Database as DatabaseType } from 'better-sqlite3';
import { getDatabase, getChunksByParentId, getRunById, type ChunkRecord, type RawRunRecord } from '../db/database.js';
import { IndexStore } from '../indexing/index-store.js';

export interface RetrievedContextItem {
  chunkId: string;
  parentId: string;
  documentId: string;
  sourceUrl: string;
  headingPath: string[];
  content: string;
  parentSectionFullText: string;
  schemaVersion: number;
  lastVerifiedAt: string;
  rrfScore: number;
  vectorRank?: number;
  bm25Rank?: number;
}

export interface HybridRetrievalResult {
  query: string;
  items: RetrievedContextItem[];
  formattedContextBlock: string;
  totalCandidateCount: number;
}

export interface RetrievalOptions {
  topKVector?: number;
  topKBm25?: number;
  topKFused?: number;
  rrfK?: number; // Constant k for RRF (default 60)
  expandToParentSection?: boolean;
}

/**
 * Computes cosine similarity between two numeric vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

/**
 * Executes hybrid vector + BM25 search in parallel, applies Reciprocal Rank Fusion (RRF),
 * expands top child chunks to parent sections, and assembles a context block with timestamps.
 */
export function retrieveHybridContext(
  query: string,
  indexStore: IndexStore,
  db: DatabaseType = getDatabase(),
  options: RetrievalOptions = {}
): HybridRetrievalResult {
  const topKVector = options.topKVector ?? 20;
  const topKBm25 = options.topKBm25 ?? 20;
  const topKFused = options.topKFused ?? 5;
  const rrfK = options.rrfK ?? 60;
  const expandParent = options.expandToParentSection ?? true;

  // 1. Parallel BM25 Search
  const bm25Results = indexStore.searchKeyword(query, topKBm25);
  const bm25Ranks = new Map<string, { rank: number; score: number }>();
  bm25Results.forEach((res, idx) => {
    bm25Ranks.set(res.chunk.chunk_id, { rank: idx + 1, score: res.score });
  });

  // 2. Parallel Vector Search (Simulated dense vector matching from stored embeddings)
  const stmt = db.prepare(`SELECT * FROM chunks_index WHERE embedding IS NOT NULL`);
  const allIndexedChunks = stmt.all() as ChunkRecord[];

  // Generate query pseudo-embedding for matching
  const queryVector: number[] = new Array(64).fill(0);
  for (let i = 0; i < query.length; i++) {
    const charCode = query.charCodeAt(i);
    const dim = (charCode * (i + 1)) % 64;
    queryVector[dim] += Math.sin(charCode);
  }
  const magnitude = Math.sqrt(queryVector.reduce((sum, v) => sum + v * v, 0)) || 1;
  const normalizedQuery = queryVector.map((v) => v / magnitude);

  const vectorScores: { chunk: ChunkRecord; score: number }[] = [];
  for (const chunk of allIndexedChunks) {
    if (!chunk.embedding) continue;
    try {
      const vec = JSON.parse(chunk.embedding) as number[];
      const sim = cosineSimilarity(normalizedQuery, vec);
      if (sim > 0.05) {
        vectorScores.push({ chunk, score: sim });
      }
    } catch {
      // Ignore malformed embeddings
    }
  }

  vectorScores.sort((a, b) => b.score - a.score);
  const vectorResults = vectorScores.slice(0, topKVector);
  const vectorRanks = new Map<string, { rank: number; score: number }>();
  vectorResults.forEach((res, idx) => {
    vectorRanks.set(res.chunk.chunk_id, { rank: idx + 1, score: res.score });
  });

  // 3. Reciprocal Rank Fusion (RRF)
  const allChunkIds = new Set([...bm25Ranks.keys(), ...vectorRanks.keys()]);
  const chunkMap = new Map<string, ChunkRecord>();

  for (const res of bm25Results) chunkMap.set(res.chunk.chunk_id, res.chunk);
  for (const res of vectorResults) chunkMap.set(res.chunk.chunk_id, res.chunk);

  const rrfScores: { chunkId: string; score: number; vectorRank?: number; bm25Rank?: number }[] = [];

  for (const chunkId of allChunkIds) {
    const vRank = vectorRanks.get(chunkId)?.rank;
    const bRank = bm25Ranks.get(chunkId)?.rank;

    let score = 0;
    if (vRank !== undefined) {
      score += 1.0 / (rrfK + vRank);
    }
    if (bRank !== undefined) {
      score += 1.0 / (rrfK + bRank);
    }

    rrfScores.push({
      chunkId,
      score,
      vectorRank: vRank,
      bm25Rank: bRank,
    });
  }

  rrfScores.sort((a, b) => b.score - a.score);
  const topFused = rrfScores.slice(0, topKFused);

  // 4. Parent Section Expansion & Run Attribution
  const seenParents = new Set<string>();
  const retrievedItems: RetrievedContextItem[] = [];

  for (const item of topFused) {
    const chunk = chunkMap.get(item.chunkId);
    if (!chunk) continue;

    // Deduplicate on parent_id if expanding to avoid redundant section duplication
    if (expandParent && seenParents.has(chunk.parent_id)) {
      continue;
    }
    seenParents.add(chunk.parent_id);

    // Retrieve full parent section text
    let parentText = chunk.content;
    if (expandParent) {
      const siblingChunks = getChunksByParentId(chunk.parent_id, db);
      if (siblingChunks.length > 0) {
        parentText = siblingChunks.map((c) => c.content).join('\n\n');
      }
    }

    // Retrieve run completion timestamp for freshness citation
    const run = getRunById(chunk.run_id, db);
    const lastVerified = run?.completed_at || chunk.created_at;

    let headingPath: string[] = [];
    try {
      headingPath = JSON.parse(chunk.heading_path);
    } catch {
      headingPath = [chunk.parent_id];
    }

    retrievedItems.push({
      chunkId: chunk.chunk_id,
      parentId: chunk.parent_id,
      documentId: chunk.document_id,
      sourceUrl: chunk.document_id,
      headingPath,
      content: chunk.content,
      parentSectionFullText: parentText,
      schemaVersion: chunk.schema_version,
      lastVerifiedAt: lastVerified,
      rrfScore: Math.round(item.score * 10000) / 10000,
      vectorRank: item.vectorRank,
      bm25Rank: item.bm25Rank,
    });
  }

  // 5. Assemble Structured Context Block for RAG Prompt
  const contextBlocks = retrievedItems.map((item, index) => {
    return `[Context Item ${index + 1}]
Source URL: ${item.sourceUrl}
Heading: ${item.headingPath.join(' > ')}
Last Verified: ${item.lastVerifiedAt}
Schema Version: v${item.schemaVersion}
Content:
${expandParent ? item.parentSectionFullText : item.content}`;
  });

  const formattedContextBlock = contextBlocks.join('\n\n--------------------\n\n');

  return {
    query,
    items: retrievedItems,
    formattedContextBlock,
    totalCandidateCount: allChunkIds.size,
  };
}
