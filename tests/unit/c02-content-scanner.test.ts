import { describe, expect, it } from 'vitest';

import {
  scanContentForRisks,
  scanEvidenceContent,
} from '@aeostudio/application/evidence-claims';

describe('C02 PII/Secret content scanner', () => {
  describe('scanContentForRisks', () => {
    it('returns clean for normal text content', () => {
      const result = scanContentForRisks(
        'This is a normal evidence document about product features.',
        'text/plain',
      );
      expect(result.clean).toBe(true);
      expect(result.findings).toHaveLength(0);
      expect(result.blocksExternalEgress).toBe(false);
    });

    it('detects AWS access keys', () => {
      const result = scanContentForRisks(
        'Config: AKIAIOSFODNN7EXAMPLE is the key.',
        'text/plain',
      );
      expect(result.clean).toBe(false);
      expect(result.findings.some((f) => f.category === 'AWS_ACCESS_KEY')).toBe(true);
      expect(result.blocksExternalEgress).toBe(true);
    });

    it('detects private key blocks', () => {
      const result = scanContentForRisks(
        '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----',
        'text/plain',
      );
      expect(result.clean).toBe(false);
      expect(result.findings.some((f) => f.category === 'PRIVATE_KEY')).toBe(true);
      expect(result.blocksExternalEgress).toBe(true);
    });

    it('detects GitHub tokens', () => {
      const result = scanContentForRisks(
        'Use token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12 for auth.',
        'text/plain',
      );
      expect(result.clean).toBe(false);
      expect(result.findings.some((f) => f.category === 'GITHUB_TOKEN')).toBe(true);
      expect(result.blocksExternalEgress).toBe(true);
    });

    it('detects JWT tokens', () => {
      const jwt =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
      const result = scanContentForRisks(`Authorization: ${jwt}`, 'text/plain');
      expect(result.clean).toBe(false);
      expect(result.findings.some((f) => f.category === 'JWT_TOKEN')).toBe(true);
      expect(result.blocksExternalEgress).toBe(true);
    });

    it('detects connection strings with credentials', () => {
      const result = scanContentForRisks(
        'DATABASE_URL=postgres://admin:secretpass@db.example.com:5432/mydb',
        'text/plain',
      );
      expect(result.clean).toBe(false);
      expect(result.findings.some((f) => f.category === 'CONNECTION_STRING')).toBe(true);
      expect(result.blocksExternalEgress).toBe(true);
    });

    it('detects US SSN', () => {
      const result = scanContentForRisks('Employee SSN: 123-45-6789', 'text/plain');
      expect(result.clean).toBe(false);
      expect(result.findings.some((f) => f.category === 'US_SSN')).toBe(true);
      expect(result.blocksExternalEgress).toBe(true);
    });

    it('detects credit card numbers', () => {
      const result = scanContentForRisks('Payment card: 4111 1111 1111 1111', 'text/plain');
      expect(result.clean).toBe(false);
      expect(result.findings.some((f) => f.category === 'CREDIT_CARD')).toBe(true);
      expect(result.blocksExternalEgress).toBe(true);
    });

    it('detects password assignments', () => {
      const result = scanContentForRisks('password = "SuperSecret123!"', 'text/plain');
      expect(result.clean).toBe(false);
      expect(result.findings.some((f) => f.category === 'PASSWORD')).toBe(true);
      expect(result.blocksExternalEgress).toBe(true);
    });

    it('skips non-textual content types', () => {
      const result = scanContentForRisks('AKIAIOSFODNN7EXAMPLE', 'application/pdf');
      expect(result.clean).toBe(true);
      expect(result.findings).toHaveLength(0);
    });

    it('scans JSON content', () => {
      const result = scanContentForRisks(
        '{"config": "api_key=ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"}',
        'application/json',
      );
      expect(result.clean).toBe(false);
      expect(result.blocksExternalEgress).toBe(true);
    });
  });

  describe('scanEvidenceContent', () => {
    it('scans UTF-8 text content', () => {
      const body = new TextEncoder().encode('Normal evidence content.');
      const result = scanEvidenceContent(body, 'text/plain');
      expect(result.clean).toBe(true);
    });

    it('detects secrets in binary text content', () => {
      const body = new TextEncoder().encode('key: AKIAIOSFODNN7EXAMPLE');
      const result = scanEvidenceContent(body, 'text/plain');
      expect(result.clean).toBe(false);
      expect(result.blocksExternalEgress).toBe(true);
    });

    it('returns clean for non-text content types', () => {
      const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header
      const result = scanEvidenceContent(body, 'image/png');
      expect(result.clean).toBe(true);
    });

    it('returns clean for invalid UTF-8 in text content', () => {
      const body = new Uint8Array([0xff, 0xfe, 0x00, 0x01]); // Invalid UTF-8
      const result = scanEvidenceContent(body, 'text/plain');
      expect(result.clean).toBe(true);
    });
  });
});
