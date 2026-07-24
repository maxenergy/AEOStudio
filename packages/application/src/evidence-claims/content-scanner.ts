/**
 * PII and Secret detection for Evidence content.
 *
 * Scans uploaded content for high-risk PII and secrets before it enters
 * the generation pipeline or is sent to external providers.
 */

export interface ContentScanFinding {
  kind: 'SECRET' | 'PII';
  category: string;
  /** Character offset in the decoded text where the finding starts. */
  offset: number;
  /** Length of the matched pattern. */
  length: number;
}

export interface ContentScanResult {
  clean: boolean;
  findings: ContentScanFinding[];
  /** True if any finding blocks external provider egress. */
  blocksExternalEgress: boolean;
}

/**
 * Patterns that indicate secrets which must never leave the platform.
 * Each pattern is intentionally conservative to reduce false positives.
 */
const SECRET_PATTERNS: { category: string; pattern: RegExp }[] = [
  // AWS Access Key ID (starts with AKIA)
  { category: 'AWS_ACCESS_KEY', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  // AWS Secret Access Key (40 char base64-like)
  { category: 'AWS_SECRET_KEY', pattern: /\b(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/g },
  // Generic API key patterns
  { category: 'API_KEY', pattern: /\b(?:api[_-]?key|apikey|api[_-]?secret)\s*[=:]\s*['"]?[A-Za-z0-9_\-]{20,}['"]?/gi },
  // Bearer tokens
  { category: 'BEARER_TOKEN', pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/g },
  // Private key blocks
  { category: 'PRIVATE_KEY', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },
  // GitHub tokens
  { category: 'GITHUB_TOKEN', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  // Slack tokens
  { category: 'SLACK_TOKEN', pattern: /\bxox[baprs]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24,32}\b/g },
  // Connection strings with credentials
  { category: 'CONNECTION_STRING', pattern: /\b(?:postgres|postgresql|mysql|mongodb|redis):\/\/[^:\s]+:[^@\s]+@/gi },
  // JWT tokens
  { category: 'JWT_TOKEN', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  // Generic password assignments
  { category: 'PASSWORD', pattern: /\b(?:password|passwd|pwd)\s*[=:]\s*['"][^'"]{8,}['"]/gi },
];

/**
 * High-risk PII patterns that block external egress by default.
 */
const PII_PATTERNS: { category: string; pattern: RegExp }[] = [
  // US Social Security Number (SSN)
  { category: 'US_SSN', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  // Credit card numbers (Visa, MC, Amex, Discover)
  { category: 'CREDIT_CARD', pattern: /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g },
  // National ID patterns (generic)
  { category: 'NATIONAL_ID', pattern: /\b(?:national[_ ]?id|ssn|social[_ ]?security)\s*[#:]\s*\d{3}[- ]?\d{2}[- ]?\d{4}\b/gi },
  // Passport numbers (generic pattern)
  { category: 'PASSPORT', pattern: /\bpassport\s*[#:]\s*[A-Z0-9]{6,12}\b/gi },
  // Driver's license (generic)
  { category: 'DRIVERS_LICENSE', pattern: /\bdriver(?:'s)?\s*licen[cs]e\s*[#:]\s*[A-Z0-9]{6,15}\b/gi },
  // Bank account numbers with routing
  { category: 'BANK_ACCOUNT', pattern: /\b(?:routing|account)\s*[#:]\s*\d{8,17}\b/gi },
  // Date of birth patterns with explicit label
  { category: 'DATE_OF_BIRTH', pattern: /\b(?:date[_ ]?of[_ ]?birth|dob|birth[_ ]?date)\s*[#:]\s*\d{1,4}[-/]\d{1,2}[-/]\d{1,4}\b/gi },
  // Medical record numbers
  { category: 'MEDICAL_RECORD', pattern: /\b(?:medical|mrn|patient)\s*(?:record)?\s*[#:]\s*[A-Z0-9]{6,20}\b/gi },
];

/**
 * Scan text content for secrets and high-risk PII.
 *
 * @param text - Decoded text content to scan
 * @param contentType - MIME type of the content (only text types are scanned)
 * @returns Scan result with findings and egress blocking decision
 */
export function scanContentForRisks(text: string, contentType: string): ContentScanResult {
  const findings: ContentScanFinding[] = [];

  // Only scan textual content
  if (!isTextualContent(contentType)) {
    return { clean: true, findings: [], blocksExternalEgress: false };
  }

  // Scan for secrets
  for (const { category, pattern } of SECRET_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      findings.push({
        kind: 'SECRET',
        category,
        offset: match.index,
        length: match[0].length,
      });
    }
  }

  // Scan for PII
  for (const { category, pattern } of PII_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      findings.push({
        kind: 'PII',
        category,
        offset: match.index,
        length: match[0].length,
      });
    }
  }

  // Sort by offset
  findings.sort((a, b) => a.offset - b.offset);

  // Any secret or high-risk PII blocks external egress
  const blocksExternalEgress = findings.length > 0;

  return {
    clean: findings.length === 0,
    findings,
    blocksExternalEgress,
  };
}

/**
 * Scan binary content by attempting to decode as UTF-8 text.
 * Falls back to clean result if content is not valid text.
 */
export function scanEvidenceContent(body: Uint8Array, contentType: string): ContentScanResult {
  if (!isTextualContent(contentType)) {
    // For non-text content, we cannot scan for text patterns
    // In production, this would use specialized scanners for PDF, images, etc.
    return { clean: true, findings: [], blocksExternalEgress: false };
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    return scanContentForRisks(text, contentType);
  } catch {
    // Not valid UTF-8 text, cannot scan
    return { clean: true, findings: [], blocksExternalEgress: false };
  }
}

function isTextualContent(contentType: string): boolean {
  const normalized = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return (
    normalized.startsWith('text/') ||
    normalized === 'application/json' ||
    normalized === 'application/xml' ||
    normalized === 'application/xhtml+xml' ||
    normalized === 'application/javascript' ||
    normalized === 'application/x-yaml' ||
    normalized === 'application/yaml'
  );
}
