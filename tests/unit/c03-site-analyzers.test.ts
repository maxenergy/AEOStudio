import { describe, expect, it } from 'vitest';

import {
  AnalyzerRegistry,
  AnswerReadinessAnalyzerV1,
  ContentEvidenceAnalyzerV1,
  IndexabilityAnalyzerV1,
  InternalLinkGraphAnalyzerV1,
  StructuredDataAnalyzerV1,
  TechnicalHtmlAnalyzerV1,
  createDefaultRegistry,
  type AnalyzerContext,
} from '../../apps/worker/src/site-analyzers.js';

function createContext(html: string, status = 200): AnalyzerContext {
  return {
    snapshot: {
      id: 'test-snapshot-id',
      url: 'https://example.test/page',
      checksum: 'a'.repeat(64),
      contentType: 'text/html',
      sizeBytes: html.length,
      capturedAt: '2026-07-25T00:00:00.000Z',
      objectRef: 'memory+test://snapshot',
    },
    html,
    status,
    finalUrl: 'https://example.test/page',
  };
}

describe('C03 Site Analyzers', () => {
  describe('AnalyzerRegistry', () => {
    it('registers and retrieves analyzers by id and version', () => {
      const registry = new AnalyzerRegistry();
      const analyzer = new TechnicalHtmlAnalyzerV1();
      registry.register(analyzer);

      expect(registry.get('technical-html', 'v1')).toBe(analyzer);
      expect(registry.get('technical-html', 'v2')).toBeUndefined();
    });

    it('throws on duplicate registration', () => {
      const registry = new AnalyzerRegistry();
      registry.register(new TechnicalHtmlAnalyzerV1());
      expect(() => registry.register(new TechnicalHtmlAnalyzerV1())).toThrow(
        'ANALYZER_ALREADY_REGISTERED',
      );
    });

    it('lists all analyzers', () => {
      const registry = createDefaultRegistry();
      const analyzers = registry.list();
      expect(analyzers.length).toBe(6);
      expect(analyzers.map((a) => a.id)).toContain('technical-html');
      expect(analyzers.map((a) => a.id)).toContain('indexability');
      expect(analyzers.map((a) => a.id)).toContain('structured-data');
      expect(analyzers.map((a) => a.id)).toContain('content-evidence');
      expect(analyzers.map((a) => a.id)).toContain('answer-readiness');
      expect(analyzers.map((a) => a.id)).toContain('internal-link-graph');
    });

    it('analyzeAll returns findings with analyzer metadata', () => {
      const registry = createDefaultRegistry();
      const context = createContext('<html><head><title>Test</title></head><body></body></html>');
      const findings = registry.analyzeAll(context);

      expect(findings.length).toBeGreaterThan(0);
      for (const finding of findings) {
        expect(finding).toHaveProperty('analyzerId');
        expect(finding).toHaveProperty('analyzerVersion');
        expect(finding).toHaveProperty('findingType');
        expect(finding).toHaveProperty('severity');
      }
    });
  });

  describe('TechnicalHtmlAnalyzerV1', () => {
    const analyzer = new TechnicalHtmlAnalyzerV1();

    it('detects missing title', () => {
      const findings = analyzer.analyze(createContext('<html><head></head><body></body></html>'));
      expect(findings.some((f) => f.findingType === 'TITLE_MISSING')).toBe(true);
    });

    it('detects valid title', () => {
      const findings = analyzer.analyze(
        createContext(
          '<html><head><title>Valid Page Title Here</title></head><body></body></html>',
        ),
      );
      expect(findings.some((f) => f.findingType === 'TITLE_MISSING')).toBe(false);
    });

    it('detects title too long', () => {
      const longTitle = 'A'.repeat(70);
      const findings = analyzer.analyze(
        createContext(`<html><head><title>${longTitle}</title></head><body></body></html>`),
      );
      expect(findings.some((f) => f.findingType === 'TITLE_TOO_LONG')).toBe(true);
    });

    it('detects missing meta description', () => {
      const findings = analyzer.analyze(createContext('<html><head></head><body></body></html>'));
      expect(findings.some((f) => f.findingType === 'META_DESCRIPTION_MISSING')).toBe(true);
    });

    it('detects missing lang attribute', () => {
      const findings = analyzer.analyze(createContext('<html><head></head><body></body></html>'));
      expect(findings.some((f) => f.findingType === 'HTML_LANG_MISSING')).toBe(true);
    });

    it('passes with lang attribute', () => {
      const findings = analyzer.analyze(
        createContext('<html lang="en"><head></head><body></body></html>'),
      );
      expect(findings.some((f) => f.findingType === 'HTML_LANG_MISSING')).toBe(false);
    });

    it('detects HTTP error status', () => {
      const findings = analyzer.analyze(createContext('<html></html>', 500));
      expect(findings.some((f) => f.findingType === 'HTTP_ERROR_STATUS')).toBe(true);
    });

    it('detects missing H1', () => {
      const findings = analyzer.analyze(
        createContext('<html><body><p>No heading</p></body></html>'),
      );
      expect(findings.some((f) => f.findingType === 'H1_MISSING')).toBe(true);
    });

    it('detects multiple H1', () => {
      const findings = analyzer.analyze(
        createContext('<html><body><h1>First</h1><h1>Second</h1></body></html>'),
      );
      expect(findings.some((f) => f.findingType === 'H1_MULTIPLE')).toBe(true);
    });
  });

  describe('IndexabilityAnalyzerV1', () => {
    const analyzer = new IndexabilityAnalyzerV1();

    it('detects noindex directive', () => {
      const findings = analyzer.analyze(
        createContext(
          '<html><head><meta name="robots" content="noindex"></head><body></body></html>',
        ),
      );
      expect(findings.some((f) => f.findingType === 'META_ROBOTS_NOINDEX')).toBe(true);
    });

    it('detects missing canonical', () => {
      const findings = analyzer.analyze(createContext('<html><head></head><body></body></html>'));
      expect(findings.some((f) => f.findingType === 'CANONICAL_MISSING')).toBe(true);
    });

    it('detects valid canonical', () => {
      const findings = analyzer.analyze(
        createContext(
          '<html><head><link rel="canonical" href="https://example.test/page"></head><body></body></html>',
        ),
      );
      expect(findings.some((f) => f.findingType === 'CANONICAL_MISSING')).toBe(false);
    });

    it('detects cross-domain canonical', () => {
      const findings = analyzer.analyze(
        createContext(
          '<html><head><link rel="canonical" href="https://other.test/page"></head><body></body></html>',
        ),
      );
      expect(findings.some((f) => f.findingType === 'CANONICAL_CROSS_DOMAIN')).toBe(true);
    });
  });

  describe('StructuredDataAnalyzerV1', () => {
    const analyzer = new StructuredDataAnalyzerV1();

    it('detects missing JSON-LD', () => {
      const findings = analyzer.analyze(createContext('<html><head></head><body></body></html>'));
      expect(findings.some((f) => f.findingType === 'JSONLD_MISSING')).toBe(true);
    });

    it('detects valid JSON-LD', () => {
      const jsonLd = JSON.stringify({
        '@type': 'Organization',
        name: 'Test',
        url: 'https://test.com',
      });
      const findings = analyzer.analyze(
        createContext(
          `<html><head><script type="application/ld+json">${jsonLd}</script></head><body></body></html>`,
        ),
      );
      expect(findings.some((f) => f.findingType === 'JSONLD_VALID')).toBe(true);
      expect(findings.some((f) => f.findingType === 'JSONLD_MISSING')).toBe(false);
    });

    it('detects invalid JSON-LD', () => {
      const findings = analyzer.analyze(
        createContext(
          '<html><head><script type="application/ld+json">{invalid}</script></head><body></body></html>',
        ),
      );
      expect(findings.some((f) => f.findingType === 'JSONLD_PARSE_ERROR')).toBe(true);
    });

    it('detects missing required properties', () => {
      const jsonLd = JSON.stringify({ '@type': 'Organization' });
      const findings = analyzer.analyze(
        createContext(
          `<html><head><script type="application/ld+json">${jsonLd}</script></head><body></body></html>`,
        ),
      );
      expect(findings.some((f) => f.findingType === 'JSONLD_MISSING_PROPERTY')).toBe(true);
    });
  });

  describe('ContentEvidenceAnalyzerV1', () => {
    const analyzer = new ContentEvidenceAnalyzerV1();

    it('detects FAQ structure', () => {
      const findings = analyzer.analyze(
        createContext(
          '<html><body><details><summary>Question?</summary><p>Answer</p></details></body></html>',
        ),
      );
      expect(findings.some((f) => f.findingType === 'FAQ_STRUCTURE_PRESENT')).toBe(true);
    });

    it('detects ordered list (steps)', () => {
      const findings = analyzer.analyze(
        createContext('<html><body><ol><li>Step 1</li><li>Step 2</li></ol></body></html>'),
      );
      expect(findings.some((f) => f.findingType === 'STEPS_STRUCTURE_PRESENT')).toBe(true);
    });

    it('detects tables', () => {
      const findings = analyzer.analyze(
        createContext('<html><body><table><tr><td>Data</td></tr></table></body></html>'),
      );
      expect(findings.some((f) => f.findingType === 'TABLE_STRUCTURE_PRESENT')).toBe(true);
    });

    it('detects thin content', () => {
      const findings = analyzer.analyze(createContext('<html><body><p>Short</p></body></html>'));
      expect(findings.some((f) => f.findingType === 'CONTENT_THIN')).toBe(true);
    });
  });

  describe('AnswerReadinessAnalyzerV1', () => {
    const analyzer = new AnswerReadinessAnalyzerV1();

    it('detects question headings', () => {
      const findings = analyzer.analyze(
        createContext('<html><body><h2>What is this?</h2><p>Explanation</p></body></html>'),
      );
      expect(findings.some((f) => f.findingType === 'QUESTION_HEADINGS_PRESENT')).toBe(true);
    });

    it('detects heading hierarchy skip', () => {
      const findings = analyzer.analyze(
        createContext('<html><body><h1>Title</h1><h4>Skipped H2 and H3</h4></body></html>'),
      );
      expect(findings.some((f) => f.findingType === 'HEADING_HIERARCHY_SKIP')).toBe(true);
    });
  });

  describe('Determinism', () => {
    it('same input produces same findings', () => {
      const registry = createDefaultRegistry();
      const html =
        '<html lang="en"><head><title>Test Page</title></head><body><h1>Hello</h1></body></html>';
      const context = createContext(html);

      const findings1 = registry.analyzeAll(context);
      const findings2 = registry.analyzeAll(context);

      expect(findings1).toEqual(findings2);
    });
  });

  describe('InternalLinkGraphAnalyzerV1', () => {
    const analyzer = new InternalLinkGraphAnalyzerV1();

    it('detects no internal links (orphan page)', () => {
      const findings = analyzer.analyze(
        createContext('<html><body><p>No links here</p></body></html>'),
      );
      expect(findings.some((f) => f.findingType === 'NO_INTERNAL_LINKS')).toBe(true);
    });

    it('detects internal links and reports count', () => {
      const findings = analyzer.analyze(
        createContext(
          '<html><body><a href="https://example.test/about">About</a><a href="https://example.test/contact">Contact</a></body></html>',
        ),
      );
      expect(findings.some((f) => f.findingType === 'INTERNAL_LINKS_COUNT')).toBe(true);
      expect(findings.some((f) => f.findingType === 'NO_INTERNAL_LINKS')).toBe(false);
    });

    it('detects empty anchor text', () => {
      const findings = analyzer.analyze(
        createContext(
          '<html><body><a href="https://example.test/page"><img src="icon.png"></a></body></html>',
        ),
      );
      expect(findings.some((f) => f.findingType === 'EMPTY_ANCHOR_TEXT')).toBe(true);
    });

    it('detects internal nofollow links', () => {
      const findings = analyzer.analyze(
        createContext(
          '<html><body><a href="https://example.test/private" rel="nofollow">Private</a></body></html>',
        ),
      );
      expect(findings.some((f) => f.findingType === 'INTERNAL_NOFOLLOW')).toBe(true);
    });

    it('detects external links without noopener', () => {
      const findings = analyzer.analyze(
        createContext(
          '<html><body><a href="https://external.test/page">External</a></body></html>',
        ),
      );
      expect(findings.some((f) => f.findingType === 'EXTERNAL_LINK_NO_NOOPENER')).toBe(true);
    });

    it('passes external links with noopener', () => {
      const findings = analyzer.analyze(
        createContext(
          '<html><body><a href="https://external.test/page" rel="noopener noreferrer">External</a></body></html>',
        ),
      );
      expect(findings.some((f) => f.findingType === 'EXTERNAL_LINK_NO_NOOPENER')).toBe(false);
    });

    it('skips fragment and javascript links', () => {
      const findings = analyzer.analyze(
        createContext(
          '<html><body><a href="#section">Jump</a><a href="javascript:void(0)">JS</a><a href="mailto:a@b.c">Mail</a></body></html>',
        ),
      );
      expect(findings.some((f) => f.findingType === 'NO_INTERNAL_LINKS')).toBe(true);
    });
  });
});
