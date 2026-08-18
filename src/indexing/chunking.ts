import { randomUUID } from 'node:crypto';
import { filterPii } from './pii-filter.js';
import { type ChunkRecord } from '../db/database.js';

export interface DocumentSection {
  sectionId: string;
  documentId: string;
  headingPath: string[];
  title: string;
  rawContent: string;
  metadata?: Record<string, unknown>;
}

export interface ChunkingOptions {
  targetTokens?: number; // default ~500 tokens (~2000 chars)
  overlapTokens?: number; // default ~100 tokens (~400 chars)
  schemaVersion?: number;
}

const DEFAULT_TARGET_TOKENS = 500;
const DEFAULT_OVERLAP_TOKENS = 100;
const CHARS_PER_TOKEN = 4; // Standard token-to-char ratio

/**
 * Estimates token count for a string using ~4 chars/token heuristic.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Parses structured JSON rows or markdown into document sections with heading hierarchy.
 */
export function extractSectionsFromPayload(
  rows: Record<string, unknown>[],
  defaultDocId: string = 'doc-001'
): DocumentSection[] {
  const sections: DocumentSection[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const title = String(row.repo_name || row.title || row.name || `Section ${i + 1}`).trim();
    const docId = String(row.url || row.product_page_url || row.changelog_url || defaultDocId).trim();
    const sectionId = `sec_${i + 1}_${title.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40)}`;

    const contentParts: string[] = [];
    contentParts.push(`## ${title}`);

    for (const [key, val] of Object.entries(row)) {
      if (key.startsWith('_') || key === 'input') continue;
      if (val === null || val === undefined || val === '') continue;

      if (typeof val === 'object') {
        const jsonStr = JSON.stringify(val);
        if (jsonStr !== '[]' && jsonStr !== '{}') {
          contentParts.push(`${key}: ${jsonStr}`);
        }
      } else {
        contentParts.push(`${key}: ${val}`);
      }
    }

    const rawContent = contentParts.join('\n');

    sections.push({
      sectionId,
      documentId: docId,
      headingPath: [title],
      title,
      rawContent,
      metadata: row,
    });
  }

  return sections;
}

/**
 * Recursively splits long text into target token chunks with sliding overlap.
 */
export function splitTextWithOverlap(
  text: string,
  targetTokens: number = DEFAULT_TARGET_TOKENS,
  overlapTokens: number = DEFAULT_OVERLAP_TOKENS
): string[] {
  const targetChars = targetTokens * CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * CHARS_PER_TOKEN;

  if (text.length <= targetChars) {
    return [text.trim()];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = start + targetChars;

    if (end >= text.length) {
      chunks.push(text.slice(start).trim());
      break;
    }

    // Try finding a natural break point (paragraph or sentence boundary)
    const slice = text.slice(start, end);
    let breakPoint = slice.lastIndexOf('\n\n');
    if (breakPoint === -1 || breakPoint < targetChars * 0.5) {
      breakPoint = slice.lastIndexOf('. ');
    }
    if (breakPoint === -1 || breakPoint < targetChars * 0.5) {
      breakPoint = slice.lastIndexOf('\n');
    }
    if (breakPoint === -1 || breakPoint < targetChars * 0.5) {
      breakPoint = slice.lastIndexOf(' ');
    }

    const chunkEnd = breakPoint !== -1 ? start + breakPoint + 1 : end;
    const chunkText = text.slice(start, chunkEnd).trim();
    if (chunkText) {
      chunks.push(chunkText);
    }

    start = Math.max(start + 1, chunkEnd - overlapChars);
  }

  return chunks;
}

/**
 * Converts verified healthy extraction rows into structure-preserving, PII-sanitized chunks.
 */
export function chunkStructuredPayload(
  rows: Record<string, unknown>[],
  metadata: {
    runId: string;
    collectorId: string;
    targetUrl: string;
    schemaVersion?: number;
  },
  options: ChunkingOptions = {}
): ChunkRecord[] {
  const sections = extractSectionsFromPayload(rows, metadata.targetUrl);
  const chunks: ChunkRecord[] = [];
  const now = new Date().toISOString();
  const schemaVersion = options.schemaVersion ?? metadata.schemaVersion ?? 1;

  for (const section of sections) {
    // 1. PII Filtering before chunking/embedding
    const piiResult = filterPii(section.rawContent);
    const sanitizedText = piiResult.sanitizedText;

    // 2. Split section into ~500-token chunks with 100-token overlap
    const textChunks = splitTextWithOverlap(
      sanitizedText,
      options.targetTokens ?? DEFAULT_TARGET_TOKENS,
      options.overlapTokens ?? DEFAULT_OVERLAP_TOKENS
    );

    for (let i = 0; i < textChunks.length; i++) {
      const chunkContent = textChunks[i];
      const chunkId = randomUUID();

      chunks.push({
        chunk_id: chunkId,
        parent_id: section.sectionId,
        document_id: section.documentId,
        collector_id: metadata.collectorId,
        run_id: metadata.runId,
        schema_version: schemaVersion,
        heading_path: JSON.stringify(section.headingPath),
        content: chunkContent,
        token_count: estimateTokens(chunkContent),
        embedding: null, // Populated during dense vector embedding phase
        pii_redacted: piiResult.isRedacted ? 1 : 0,
        created_at: now,
      });
    }
  }

  return chunks;
}
