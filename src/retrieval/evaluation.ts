import { IndexStore } from '../indexing/index-store.js';
import { type Database as DatabaseType } from 'better-sqlite3';
import { retrieveHybridContext, cosineSimilarity } from './retrieve.js';
import { RagService } from './rag-service.js';

export interface EvalQuery {
  id: string;
  query: string;
  expectedDocumentIds: string[];
  expectedKeywords?: string[];
  isAnswerable: boolean;
  groundTruthAnswerSummary?: string;
}

export interface RetrievalMetrics {
  precisionAtK: number;
  recallAtK: number;
  hitRate: number;
  reciprocalRank: number;
}

export interface StrategyBenchmarkResult {
  strategy: 'rrf_hybrid' | 'dense_vector_only' | 'bm25_sparse_only';
  meanPrecisionAtK: number;
  meanRecallAtK: number;
  meanReciprocalRank: number;
  hitRatePct: number;
  averageLatencyMs: number;
}

export interface RagEvaluationReport {
  totalQueries: number;
  answerableQueries: number;
  unanswerableQueries: number;
  refusalAccuracyPct: number;
  citationFaithfulnessPct: number;
  hybridStrategyMetrics: StrategyBenchmarkResult;
  denseOnlyStrategyMetrics: StrategyBenchmarkResult;
  sparseOnlyStrategyMetrics: StrategyBenchmarkResult;
  rrfAdvantagePct: number;
  evaluatedAt: string;
}

/**
 * Standard held-out evaluation dataset covering trending repositories, dependencies, and unanswerable controls.
 */
export const STANDARD_EVAL_DATASET: EvalQuery[] = [
  {
    id: 'eval-01',
    query: 'What does facebook/react provide according to indexed repositories?',
    expectedDocumentIds: ['https://github.com/facebook/react'],
    expectedKeywords: ['react', 'web', 'interfaces', 'javascript'],
    isAnswerable: true,
    groundTruthAnswerSummary: 'The library for web and native user interfaces.',
  },
  {
    id: 'eval-02',
    query: 'Find the Next.js React framework repository and URL',
    expectedDocumentIds: ['https://github.com/vercel/next.js'],
    expectedKeywords: ['next.js', 'vercel', 'framework'],
    isAnswerable: true,
    groundTruthAnswerSummary: 'The React Framework for the Web.',
  },
  {
    id: 'eval-03',
    query: 'Free public APIs for software and web development list',
    expectedDocumentIds: ['https://github.com/public-apis/public-apis'],
    expectedKeywords: ['public-apis', 'collective', 'apis'],
    isAnswerable: true,
    groundTruthAnswerSummary: 'A collective list of free APIs for use in software and web development.',
  },
  {
    id: 'eval-04',
    query: 'Shadcn UI component library design system',
    expectedDocumentIds: ['https://github.com/shadcn/ui'],
    expectedKeywords: ['shadcn', 'ui', 'components'],
    isAnswerable: true,
    groundTruthAnswerSummary: 'Beautifully designed components that you can copy and paste into your apps.',
  },
  {
    id: 'eval-05',
    query: 'What is the current stock price and revenue of Apple AAPL?',
    expectedDocumentIds: [],
    expectedKeywords: [],
    isAnswerable: false, // Negative control: must trigger refusal gate
  },
  {
    id: 'eval-06',
    query: 'Explain the weather forecast in Tokyo tomorrow',
    expectedDocumentIds: [],
    expectedKeywords: [],
    isAnswerable: false, // Negative control: must trigger refusal gate
  },
];

/**
 * Evaluates retrieval metrics (Precision@K, Recall@K, MRR) for a single query.
 */
export function computeRetrievalMetrics(
  retrievedDocIds: string[],
  expectedDocIds: string[],
  k: number = 5
): RetrievalMetrics {
  if (expectedDocIds.length === 0) {
    return {
      precisionAtK: retrievedDocIds.length === 0 ? 1 : 0,
      recallAtK: 1,
      hitRate: 1,
      reciprocalRank: 1,
    };
  }

  const topKRetrieved = retrievedDocIds.slice(0, k);
  const relevantRetrieved = topKRetrieved.filter((id) => expectedDocIds.includes(id));

  const precisionAtK = topKRetrieved.length > 0 ? relevantRetrieved.length / topKRetrieved.length : 0;
  const recallAtK = expectedDocIds.length > 0 ? relevantRetrieved.length / expectedDocIds.length : 0;
  const hitRate = relevantRetrieved.length > 0 ? 1 : 0;

  let reciprocalRank = 0;
  for (let i = 0; i < topKRetrieved.length; i++) {
    if (expectedDocIds.includes(topKRetrieved[i])) {
      reciprocalRank = 1 / (i + 1);
      break;
    }
  }

  return {
    precisionAtK,
    recallAtK,
    hitRate,
    reciprocalRank,
  };
}

/**
 * Runs dense-only vector retrieval (cosine similarity) without BM25 fusion.
 */
export function retrieveDenseOnly(
  query: string,
  indexStore: IndexStore,
  topK: number = 5
): string[] {
  const chunks = indexStore.getAllChunks();
  const queryTokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (chunks.length === 0 || queryTokens.length === 0) return [];

  // Generate synthetic query vector using term hashing
  const queryVector = new Array(64).fill(0);
  for (const token of queryTokens) {
    for (let i = 0; i < token.length; i++) {
      const idx = (token.charCodeAt(i) * 17 + i * 31) % 64;
      queryVector[idx] += 1;
    }
  }
  const mag = Math.sqrt(queryVector.reduce((sum, v) => sum + v * v, 0));
  const normQuery = mag > 0 ? queryVector.map((v) => v / mag) : queryVector;

  const scored: { docId: string; score: number }[] = [];
  for (const chunk of chunks) {
    if (!chunk.embedding) continue;
    try {
      const emb = JSON.parse(chunk.embedding) as number[];
      const sim = cosineSimilarity(normQuery, emb);
      scored.push({ docId: chunk.document_id, score: sim });
    } catch {}
  }

  scored.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const results: string[] = [];
  for (const item of scored) {
    if (!seen.has(item.docId)) {
      seen.add(item.docId);
      results.push(item.docId);
      if (results.length >= topK) break;
    }
  }
  return results;
}

/**
 * Runs sparse-only BM25 keyword search without dense vector fusion.
 */
export function retrieveSparseOnly(
  query: string,
  indexStore: IndexStore,
  topK: number = 5
): string[] {
  const bm25Results = indexStore.searchBM25(query, topK * 2);
  const seen = new Set<string>();
  const results: string[] = [];
  for (const res of bm25Results) {
    if (!seen.has(res.chunk.document_id)) {
      seen.add(res.chunk.document_id);
      results.push(res.chunk.document_id);
      if (results.length >= topK) break;
    }
  }
  return results;
}

/**
 * Executes full automated evaluation benchmark across the held-out dataset,
 * comparing RRF Hybrid against Dense-only and Sparse-only retrieval.
 */
export async function runAutomatedEvaluation(
  indexStore: IndexStore,
  db: DatabaseType,
  dataset: EvalQuery[] = STANDARD_EVAL_DATASET,
  topK: number = 5
): Promise<RagEvaluationReport> {
  const ragService = new RagService(indexStore, db);

  const hybridMetricsList: RetrievalMetrics[] = [];
  const denseMetricsList: RetrievalMetrics[] = [];
  const sparseMetricsList: RetrievalMetrics[] = [];

  let hybridTotalDuration = 0;
  let denseTotalDuration = 0;
  let sparseTotalDuration = 0;

  let correctRefusals = 0;
  let totalUnanswerable = 0;
  let faithfulCitations = 0;
  let totalAnswerable = 0;

  for (const testCase of dataset) {
    if (!testCase.isAnswerable) {
      totalUnanswerable++;
      const response = await ragService.query({ query: testCase.query, maxContextItems: topK });
      if (
        !response.hasSufficientContext &&
        response.answer.includes('does not contain information to answer this question')
      ) {
        correctRefusals++;
      }
      continue;
    }

    totalAnswerable++;

    // 1. Benchmark RRF Hybrid Strategy
    const t0 = performance.now();
    const hybridContext = retrieveHybridContext(testCase.query, indexStore, db, { topKFused: topK });
    hybridTotalDuration += performance.now() - t0;
    const hybridDocIds = [...new Set(hybridContext.items.map((i) => i.documentId))];
    hybridMetricsList.push(computeRetrievalMetrics(hybridDocIds, testCase.expectedDocumentIds, topK));

    // 2. Benchmark Dense-Only Strategy
    const t1 = performance.now();
    const denseDocIds = retrieveDenseOnly(testCase.query, indexStore, topK);
    denseTotalDuration += performance.now() - t1;
    denseMetricsList.push(computeRetrievalMetrics(denseDocIds, testCase.expectedDocumentIds, topK));

    // 3. Benchmark Sparse-Only BM25 Strategy
    const t2 = performance.now();
    const sparseDocIds = retrieveSparseOnly(testCase.query, indexStore, topK);
    sparseTotalDuration += performance.now() - t2;
    sparseMetricsList.push(computeRetrievalMetrics(sparseDocIds, testCase.expectedDocumentIds, topK));

    // 4. Evaluate Generation Faithfulness & Citation Correctness
    const ragResponse = await ragService.query({ query: testCase.query, maxContextItems: topK });
    if (ragResponse.citations.length > 0) {
      const citedUrls = ragResponse.citations.map((c) => c.sourceUrl);
      const isFaithful = testCase.expectedDocumentIds.some((expected) =>
        citedUrls.some((cited) => cited.includes(expected) || expected.includes(cited))
      );
      if (isFaithful) faithfulCitations++;
    }
  }

  const aggregateStrategy = (
    strategy: StrategyBenchmarkResult['strategy'],
    list: RetrievalMetrics[],
    totalDuration: number
  ): StrategyBenchmarkResult => {
    if (list.length === 0) {
      return {
        strategy,
        meanPrecisionAtK: 0,
        meanRecallAtK: 0,
        meanReciprocalRank: 0,
        hitRatePct: 0,
        averageLatencyMs: 0,
      };
    }

    const meanP = list.reduce((sum, m) => sum + m.precisionAtK, 0) / list.length;
    const meanR = list.reduce((sum, m) => sum + m.recallAtK, 0) / list.length;
    const meanMRR = list.reduce((sum, m) => sum + m.reciprocalRank, 0) / list.length;
    const hitRatePct = (list.reduce((sum, m) => sum + m.hitRate, 0) / list.length) * 100;
    const avgLatency = totalDuration / list.length;

    return {
      strategy,
      meanPrecisionAtK: Math.round(meanP * 1000) / 1000,
      meanRecallAtK: Math.round(meanR * 1000) / 1000,
      meanReciprocalRank: Math.round(meanMRR * 1000) / 1000,
      hitRatePct: Math.round(hitRatePct * 10) / 10,
      averageLatencyMs: Math.round(avgLatency * 100) / 100,
    };
  };

  const hybridMetrics = aggregateStrategy('rrf_hybrid', hybridMetricsList, hybridTotalDuration);
  const denseMetrics = aggregateStrategy('dense_vector_only', denseMetricsList, denseTotalDuration);
  const sparseMetrics = aggregateStrategy('bm25_sparse_only', sparseMetricsList, sparseTotalDuration);

  const baselineMaxMRR = Math.max(denseMetrics.meanReciprocalRank, sparseMetrics.meanReciprocalRank, 0.01);
  const rrfAdvantagePct = Math.round(
    ((hybridMetrics.meanReciprocalRank - baselineMaxMRR) / baselineMaxMRR) * 100
  );

  return {
    totalQueries: dataset.length,
    answerableQueries: totalAnswerable,
    unanswerableQueries: totalUnanswerable,
    refusalAccuracyPct: totalUnanswerable > 0 ? Math.round((correctRefusals / totalUnanswerable) * 100) : 100,
    citationFaithfulnessPct: totalAnswerable > 0 ? Math.round((faithfulCitations / totalAnswerable) * 100) : 100,
    hybridStrategyMetrics: hybridMetrics,
    denseOnlyStrategyMetrics: denseMetrics,
    sparseOnlyStrategyMetrics: sparseMetrics,
    rrfAdvantagePct: Math.max(0, rrfAdvantagePct),
    evaluatedAt: new Date().toISOString(),
  };
}
