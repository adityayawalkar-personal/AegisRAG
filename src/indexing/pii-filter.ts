export interface PiiFilterResult {
  sanitizedText: string;
  emailCount: number;
  phoneCount: number;
  sensitiveCount: number;
  totalRedactions: number;
  isRedacted: boolean;
  redactionLog: string[];
}

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;

// Matches US and international phone formats with country codes, dashes, parentheses, or dots
const PHONE_REGEX = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;

// Matches US SSN format XXX-XX-XXXX
const SSN_REGEX = /\b\d{3}-\d{2}-\d{4}\b/g;

export function filterPii(text: string): PiiFilterResult {
  if (!text) {
    return {
      sanitizedText: '',
      emailCount: 0,
      phoneCount: 0,
      sensitiveCount: 0,
      totalRedactions: 0,
      isRedacted: false,
      redactionLog: [],
    };
  }

  const logs: string[] = [];
  let emailCount = 0;
  let phoneCount = 0;
  let sensitiveCount = 0;

  // 1. Redact Emails
  let sanitized = text.replace(EMAIL_REGEX, (match) => {
    emailCount++;
    logs.push(`Redacted email address: ${match.slice(0, 3)}***@***`);
    return '[REDACTED_EMAIL]';
  });

  // 2. Redact SSNs
  sanitized = sanitized.replace(SSN_REGEX, () => {
    sensitiveCount++;
    logs.push('Redacted government SSN identifier');
    return '[REDACTED_SSN]';
  });

  // 3. Redact Phone Numbers
  sanitized = sanitized.replace(PHONE_REGEX, (match) => {
    // Avoid false positives on short numbers or standard version strings like v4.2.0
    if (match.length < 10 || match.startsWith('v')) return match;
    phoneCount++;
    logs.push(`Redacted phone number pattern: ***-***-${match.slice(-4)}`);
    return '[REDACTED_PHONE]';
  });

  const totalRedactions = emailCount + phoneCount + sensitiveCount;

  if (totalRedactions > 0) {
    console.log(`[pii-filter] 🔒 Sanitized ${totalRedactions} PII element(s) before embedding: ${logs.join('; ')}`);
  }

  return {
    sanitizedText: sanitized,
    emailCount,
    phoneCount,
    sensitiveCount,
    totalRedactions,
    isRedacted: totalRedactions > 0,
    redactionLog: logs,
  };
}
