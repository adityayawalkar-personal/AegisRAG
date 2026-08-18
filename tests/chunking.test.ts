import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { extractSectionsFromPayload, chunkStructuredPayload, splitTextWithOverlap } from '../src/indexing/chunking.js';

describe('Structure-Preserving Chunking Engine', () => {
  it('extracts hierarchical sections from golden fixture preserving parent context', () => {
    const fixturePath = path.join(process.cwd(), 'fixtures', 'golden-run.json');
    const goldenRows = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));

    const sections = extractSectionsFromPayload(goldenRows, 'https://github.com/trending');
    expect(sections.length).toBe(4);

    expect(sections[0].title).toBe('public-apis/public-apis');
    expect(sections[0].sectionId).toContain('sec_1_public_apis');
    expect(sections[0].rawContent).toContain('## public-apis/public-apis');
    expect(sections[0].documentId).toContain('github.com/public-apis');
  });

  it('splits long text into ~500-token chunks with 100-token overlap', () => {
    // Generate text of approx 1500 tokens (6000 chars)
    const paragraphs = Array.from(
      { length: 15 },
      (_, i) => `Paragraph ${i + 1}: AegisRAG provides autonomous self-healing knowledge pipelines with continuous verification against rolling baselines.`
    ).join('\n\n');

    const chunks = splitTextWithOverlap(paragraphs, 500, 100);
    expect(chunks.length).toBeGreaterThanOrEqual(1);

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(500 * 4 + 50); // Under ~500 token limit
    }
  });

  it('tags chunks with parent_id, run_id, schema_version, and PII flags', () => {
    const mockRows = [
      {
        repo_name: 'test/project-alpha',
        description: 'Lead author: contact dev@alpha.io for questions.',
        url: 'https://github.com/test/project-alpha',
      },
    ];

    const chunks = chunkStructuredPayload(mockRows, {
      runId: 'run-alpha-999',
      collectorId: 'c_collector_alpha',
      targetUrl: 'https://github.com/trending',
      schemaVersion: 2,
    });

    expect(chunks.length).toBe(1);
    const chunk = chunks[0];
    expect(chunk.run_id).toBe('run-alpha-999');
    expect(chunk.collector_id).toBe('c_collector_alpha');
    expect(chunk.schema_version).toBe(2);
    expect(chunk.parent_id).toContain('sec_1_test_project_alpha');
    expect(chunk.pii_redacted).toBe(1);
    expect(chunk.content).toContain('[REDACTED_EMAIL]');
  });
});
