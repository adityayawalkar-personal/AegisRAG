import { type Database as DatabaseType } from 'better-sqlite3';
import { 
  getDatabase, 
  getRunById, 
  getRunStatusByRunId, 
  insertChunks, 
  deleteChunksByCollectorAndSchemaVersion,
  getChunksByCollector,
  type ChunkRecord,
  type RawRunRecord,
  type RunStatusRecord
} from '../db/database.js';
import { chunkStructuredPayload, type ChunkingOptions } from './chunking.js';
import { BM25Index, type BM25SearchResult } from './bm25.js';

export interface IngestionResult {
  runId: string;
  collectorId: string;
  schemaVersion: number;
  chunksCreated: number;
  piiRedactionsCount: number;
  purgedOldChunksCount: number;
  chunks: ChunkRecord[];
}

export class IndexStore {
  private db: DatabaseType;
  public bm25: BM25Index;

  constructor(db: DatabaseType = getDatabase()) {
    this.db = db;
    this.bm25 = new BM25Index();
    this.syncBm25FromDatabase();
  }

  /**
   * Hydrates the in-memory BM25 index from persistent SQLite chunk records.
   */
  public syncBm25FromDatabase(): void {
    const stmt = this.db.prepare(`SELECT * FROM chunks_index`);
    const allChunks = stmt.all() as ChunkRecord[];
    this.bm25.clear();
    this.bm25.addChunks(allChunks);
  }

  /**
   * Ingests and indexes verified healthy runs.
   * Enforces Guardrail: Rejects runs that failed Sentinel validation.
   */
  public ingestHealthyRun(
    runId: string,
    options: ChunkingOptions = {}
  ): IngestionResult {
    const run = getRunById(runId, this.db);
    if (!run) throw new Error(`Run '${runId}' not found in database.`);

    const statusRecord = getRunStatusByRunId(runId, this.db);
    if (!statusRecord) {
      throw new Error(`Run '${runId}' has not been validated by the Sentinel yet. Ingestion blocked.`);
    }

    if (statusRecord.status !== 'HEALTHY') {
      throw new Error(
        `Ingestion blocked by Sentinel Quality Gate: Run '${runId}' has status '${statusRecord.status}' (must be HEALTHY). Reason: ${statusRecord.diff_summary}`
      );
    }

    if (!run.raw_payload) {
      throw new Error(`Run '${runId}' has empty raw payload.`);
    }

    let parsedPayload: Record<string, unknown>[] = [];
    try {
      const parsed = JSON.parse(run.raw_payload);
      parsedPayload = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      throw new Error(`Failed to parse raw payload JSON for run '${runId}'.`);
    }

    const schemaVersion = options.schemaVersion ?? 1;

    // 1. Stale-Data Self-Cleaning: Delete superseded schema chunks for this collector
    const purgedCount = this.purgeSupersededSchemaChunks(run.collector_id, schemaVersion);

    // 2. Structure-preserving chunking + PII redaction
    const chunks = chunkStructuredPayload(
      parsedPayload,
      {
        runId: run.run_id,
        collectorId: run.collector_id,
        targetUrl: run.target_url,
        schemaVersion,
      },
      options
    );

    // 3. Generate deterministic dense vector embeddings (mock float vector for search compatibility)
    for (const chunk of chunks) {
      chunk.embedding = JSON.stringify(this.generateMockEmbedding(chunk.content));
    }

    // 4. Persist to SQLite chunks_index table
    insertChunks(chunks, this.db);

    // 5. Index into BM25 sparse index
    this.bm25.addChunks(chunks);

    const piiRedactions = chunks.filter((c) => c.pii_redacted === 1).length;

    console.log(
      `[index-store] 📦 Ingested run '${runId}': ${chunks.length} chunks indexed (schema v${schemaVersion}, ${purgedCount} stale chunks purged, ${piiRedactions} chunks PII-sanitized).`
    );

    return {
      runId: run.run_id,
      collectorId: run.collector_id,
      schemaVersion,
      chunksCreated: chunks.length,
      piiRedactionsCount: piiRedactions,
      purgedOldChunksCount: purgedCount,
      chunks,
    };
  }

  /**
   * Purges all chunks tagged with superseded schema versions from both SQLite and BM25 index.
   */
  public purgeSupersededSchemaChunks(collectorId: string, currentVersion: number): number {
    const purgedFromDb = deleteChunksByCollectorAndSchemaVersion(collectorId, currentVersion, this.db);
    const purgedFromBm25 = this.bm25.removeChunksByCollectorAndSchemaVersion(collectorId, currentVersion);

    if (purgedFromDb > 0) {
      console.log(
        `[index-store] 🧹 Self-cleaning: Purged ${purgedFromDb} superseded schema chunks (< v${currentVersion}) for collector '${collectorId}'.`
      );
    }

    return purgedFromDb;
  }

  /**
   * Generates a 64-dimensional pseudo-embedding vector for demonstration and testing.
   */
  private generateMockEmbedding(text: string): number[] {
    const vector: number[] = new Array(64).fill(0);
    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i);
      const dim = (charCode * (i + 1)) % 64;
      vector[dim] += Math.sin(charCode);
    }
    // Normalize vector
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vector.map((v) => Math.round((v / magnitude) * 10000) / 10000);
  }

  public searchKeyword(query: string, topK: number = 10): BM25SearchResult[] {
    return this.bm25.search(query, topK);
  }

  public searchBM25(query: string, topK: number = 10): BM25SearchResult[] {
    return this.bm25.search(query, topK);
  }

  public getAllChunksForCollector(collectorId: string, schemaVersion?: number): ChunkRecord[] {
    return getChunksByCollector(collectorId, schemaVersion, this.db);
  }

  public getAllChunks(): ChunkRecord[] {
    const stmt = this.db.prepare(`SELECT * FROM chunks_index`);
    return stmt.all() as ChunkRecord[];
  }

  public size(): number {
    return this.bm25.size();
  }
}
