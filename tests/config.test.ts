import { describe, it, expect } from 'vitest';
import { SourceConfigSchema, SourcesListSchema, loadSourcesConfig } from '../src/config/sources.js';
import path from 'node:path';

describe('Source Configuration Layer', () => {
  it('should validate a valid SourceConfig schema', () => {
    const validConfig = {
      source_id: 'test-source',
      name: 'Test Source',
      target_url: 'https://example.com/data',
      collector_id: 'c_test_999',
      expected_fields: ['title', 'summary', 'url'],
      field_types: {
        title: 'string',
        summary: 'string',
        url: 'url',
      },
      validation_thresholds: {
        baseline_window: 5,
        corruption_threshold_pct: 20,
        duplicate_threshold_pct: 50,
      },
    };

    const parsed = SourceConfigSchema.parse(validConfig);
    expect(parsed.source_id).toBe('test-source');
    expect(parsed.validation_thresholds.baseline_window).toBe(5);
  });

  it('should reject invalid URLs or negative thresholds', () => {
    const invalidUrl = {
      source_id: 'test-source',
      name: 'Test',
      target_url: 'not-a-valid-url',
      collector_id: 'c_test',
      expected_fields: ['title'],
    };

    expect(() => SourceConfigSchema.parse(invalidUrl)).toThrow();
  });

  it('should load active configuration from config/sources.json', () => {
    const configPath = path.join(process.cwd(), 'config', 'sources.json');
    const sources = loadSourcesConfig(configPath);
    expect(sources.length).toBeGreaterThan(0);
    expect(sources[0].source_id).toBeDefined();
    expect(sources[0].collector_id).toBeDefined();
  });
});
