import { describe, it, expect } from 'vitest';
import { filterPii } from '../src/indexing/pii-filter.js';

describe('PII Redaction Filter', () => {
  it('redacts email addresses cleanly', () => {
    const raw = 'Maintainer contact: aditya.lead@example.com or support@aegisrag.io.';
    const result = filterPii(raw);

    expect(result.isRedacted).toBe(true);
    expect(result.emailCount).toBe(2);
    expect(result.sanitizedText).toContain('[REDACTED_EMAIL]');
    expect(result.sanitizedText).not.toContain('aditya.lead@example.com');
  });

  it('redacts phone numbers across international and US formats', () => {
    const raw = 'Call support at +1-800-555-0199 or (555) 234-5678 immediately.';
    const result = filterPii(raw);

    expect(result.isRedacted).toBe(true);
    expect(result.phoneCount).toBeGreaterThanOrEqual(1);
    expect(result.sanitizedText).toContain('[REDACTED_PHONE]');
  });

  it('passes clean text through without modifying it', () => {
    const clean = 'Hyperion Engine Architecture v4.2.0 introduces zero-copy memory buffers.';
    const result = filterPii(clean);

    expect(result.isRedacted).toBe(false);
    expect(result.totalRedactions).toBe(0);
    expect(result.sanitizedText).toBe(clean);
  });
});
