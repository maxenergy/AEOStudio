/**
 * Versioned Analyzer Registry for Site Diagnostics.
 *
 * Each analyzer is versioned and produces deterministic findings
 * bound to snapshot hash and analyzer version.
 */

import type { BaselineFindingResult, CrawlSnapshotResult } from './site-crawl-handler.js';

export interface AnalyzerContext {
  snapshot: CrawlSnapshotResult;
  html: string;
  status: number;
  finalUrl: string;
}

export interface AnalyzerFinding {
  findingType: string;
  severity: 'INFO' | 'WARNING' | 'ERROR';
  detail: string;
  /** JSON pointer or selector for evidence location. */
  evidencePointer?: string;
  /** Suggested remediation action. */
  suggestion?: string;
}

export interface SiteAnalyzer {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  analyze(context: AnalyzerContext): AnalyzerFinding[];
}

/**
 * Registry of versioned site analyzers.
 * Analyzers are immutable once registered; new versions create new entries.
 */
export class AnalyzerRegistry {
  private readonly analyzers = new Map<string, SiteAnalyzer>();

  register(analyzer: SiteAnalyzer): void {
    const key = `${analyzer.id}@${analyzer.version}`;
    if (this.analyzers.has(key)) {
      throw new Error(`ANALYZER_ALREADY_REGISTERED: ${key}`);
    }
    this.analyzers.set(key, analyzer);
  }

  get(id: string, version: string): SiteAnalyzer | undefined {
    return this.analyzers.get(`${id}@${version}`);
  }

  list(): SiteAnalyzer[] {
    return [...this.analyzers.values()];
  }

  listById(id: string): SiteAnalyzer[] {
    return this.list().filter((analyzer) => analyzer.id === id);
  }

  /**
   * Run all registered analyzers against a context.
   * Returns findings with analyzer version metadata.
   */
  analyzeAll(context: AnalyzerContext): (AnalyzerFinding & { analyzerId: string; analyzerVersion: string })[] {
    const findings: (AnalyzerFinding & { analyzerId: string; analyzerVersion: string })[] = [];
    for (const analyzer of this.analyzers.values()) {
      try {
        const results = analyzer.analyze(context);
        for (const finding of results) {
          findings.push({
            ...finding,
            analyzerId: analyzer.id,
            analyzerVersion: analyzer.version,
          });
        }
      } catch {
        // Analyzer failure should not crash the crawl
        findings.push({
          findingType: 'ANALYZER_ERROR',
          severity: 'WARNING',
          detail: `Analyzer ${analyzer.id}@${analyzer.version} failed`,
          analyzerId: analyzer.id,
          analyzerVersion: analyzer.version,
        });
      }
    }
    return findings;
  }
}

/**
 * Create the default analyzer registry with all v1 analyzers.
 */
export function createDefaultRegistry(): AnalyzerRegistry {
  const registry = new AnalyzerRegistry();
  registry.register(new TechnicalHtmlAnalyzerV1());
  registry.register(new IndexabilityAnalyzerV1());
  registry.register(new StructuredDataAnalyzerV1());
  registry.register(new ContentEvidenceAnalyzerV1());
  registry.register(new AnswerReadinessAnalyzerV1());
  return registry;
}

// ============================================================================
// Technical HTML Analyzer v1
// ============================================================================

export class TechnicalHtmlAnalyzerV1 implements SiteAnalyzer {
  readonly id = 'technical-html';
  readonly version = 'v1';
  readonly description = 'Basic HTML technical checks: title, meta, lang, headings';

  analyze(context: AnalyzerContext): AnalyzerFinding[] {
    const findings: AnalyzerFinding[] = [];
    const { html, status } = context;

    // HTTP status check
    if (status >= 400) {
      findings.push({
        findingType: 'HTTP_ERROR_STATUS',
        severity: 'ERROR',
        detail: `HTTP ${status} response`,
        suggestion: 'Fix server error or remove broken URL from sitemap',
      });
    } else if (status >= 300) {
      findings.push({
        findingType: 'HTTP_REDIRECT_STATUS',
        severity: 'WARNING',
        detail: `HTTP ${status} redirect`,
        suggestion: 'Update links to point directly to final URL',
      });
    }

    // Title check
    const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    if (titleMatch === null || titleMatch[1]?.trim().length === 0) {
      findings.push({
        findingType: 'TITLE_MISSING',
        severity: 'WARNING',
        detail: 'Page has no title or empty title',
        evidencePointer: '/html/head/title',
        suggestion: 'Add a unique, descriptive title (50-60 characters)',
      });
    } else {
      const titleLength = (titleMatch[1] ?? '').trim().length;
      if (titleLength > 60) {
        findings.push({
          findingType: 'TITLE_TOO_LONG',
          severity: 'INFO',
          detail: `Title is ${titleLength} characters (recommended: 50-60)`,
          evidencePointer: '/html/head/title',
        });
      } else if (titleLength < 30) {
        findings.push({
          findingType: 'TITLE_TOO_SHORT',
          severity: 'INFO',
          detail: `Title is ${titleLength} characters (recommended: 50-60)`,
          evidencePointer: '/html/head/title',
        });
      }
    }

    // Meta description check
    const metaDescMatch = /<meta\b[^>]*\bname=["']description["'][^>]*\bcontent=["']([\s\S]*?)["']/i.exec(html)
      ?? /<meta\b[^>]*\bcontent=["']([\s\S]*?)["'][^>]*\bname=["']description["']/i.exec(html);
    if (metaDescMatch === null || metaDescMatch[1]?.trim().length === 0) {
      findings.push({
        findingType: 'META_DESCRIPTION_MISSING',
        severity: 'WARNING',
        detail: 'Page has no meta description',
        evidencePointer: '/html/head/meta[@name="description"]',
        suggestion: 'Add a compelling meta description (150-160 characters)',
      });
    }

    // HTML lang attribute
    const htmlTagMatch = /<html\b[^>]*>/i.exec(html);
    if (htmlTagMatch !== null && !/\blang=["'][^"']+["']/i.test(htmlTagMatch[0])) {
      findings.push({
        findingType: 'HTML_LANG_MISSING',
        severity: 'WARNING',
        detail: 'HTML element has no lang attribute',
        evidencePointer: '/html[@lang]',
        suggestion: 'Add lang attribute for accessibility and SEO',
      });
    }

    // H1 check
    const h1Matches = html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi);
    if (h1Matches === null || h1Matches.length === 0) {
      findings.push({
        findingType: 'H1_MISSING',
        severity: 'WARNING',
        detail: 'Page has no H1 heading',
        evidencePointer: '/html/body//h1',
        suggestion: 'Add exactly one H1 heading per page',
      });
    } else if (h1Matches.length > 1) {
      findings.push({
        findingType: 'H1_MULTIPLE',
        severity: 'INFO',
        detail: `Page has ${h1Matches.length} H1 headings (recommended: 1)`,
        evidencePointer: '/html/body//h1',
      });
    }

    return findings;
  }
}

// ============================================================================
// Indexability Analyzer v1
// ============================================================================

export class IndexabilityAnalyzerV1 implements SiteAnalyzer {
  readonly id = 'indexability';
  readonly version = 'v1';
  readonly description = 'Indexability checks: robots meta, canonical, hreflang';

  analyze(context: AnalyzerContext): AnalyzerFinding[] {
    const findings: AnalyzerFinding[] = [];
    const { html } = context;

    // Meta robots check
    const metaRobotsMatch = /<meta\b[^>]*\bname=["']robots["'][^>]*\bcontent=["']([\s\S]*?)["']/i.exec(html)
      ?? /<meta\b[^>]*\bcontent=["']([\s\S]*?)["'][^>]*\bname=["']robots["']/i.exec(html);
    if (metaRobotsMatch !== null) {
      const content = metaRobotsMatch[1]?.toLowerCase() ?? '';
      if (content.includes('noindex')) {
        findings.push({
          findingType: 'META_ROBOTS_NOINDEX',
          severity: 'WARNING',
          detail: 'Page has meta robots noindex directive',
          evidencePointer: '/html/head/meta[@name="robots"]',
          suggestion: 'Remove noindex if page should be indexed',
        });
      }
      if (content.includes('nofollow')) {
        findings.push({
          findingType: 'META_ROBOTS_NOFOLLOW',
          severity: 'INFO',
          detail: 'Page has meta robots nofollow directive',
          evidencePointer: '/html/head/meta[@name="robots"]',
        });
      }
    }

    // Canonical check
    const canonicalMatch = /<link\b[^>]*\brel=["'][^"']*canonical[^"']*["'][^>]*\bhref=["']([\s\S]*?)["']/i.exec(html)
      ?? /<link\b[^>]*\bhref=["']([\s\S]*?)["'][^>]*\brel=["'][^"']*canonical[^"']*["']/i.exec(html);
    if (canonicalMatch === null) {
      findings.push({
        findingType: 'CANONICAL_MISSING',
        severity: 'WARNING',
        detail: 'Page has no canonical link',
        evidencePointer: '/html/head/link[@rel="canonical"]',
        suggestion: 'Add self-referencing canonical URL',
      });
    } else {
      const canonicalUrl = canonicalMatch[1]?.trim() ?? '';
      try {
        const canonical = new URL(canonicalUrl);
        const current = new URL(context.finalUrl);
        if (canonical.hostname !== current.hostname) {
          findings.push({
            findingType: 'CANONICAL_CROSS_DOMAIN',
            severity: 'WARNING',
            detail: `Canonical points to different domain: ${canonical.hostname}`,
            evidencePointer: '/html/head/link[@rel="canonical"]',
            suggestion: 'Verify cross-domain canonical is intentional',
          });
        }
      } catch {
        findings.push({
          findingType: 'CANONICAL_INVALID_URL',
          severity: 'ERROR',
          detail: `Invalid canonical URL: ${canonicalUrl}`,
          evidencePointer: '/html/head/link[@rel="canonical"]',
        });
      }
    }

    // Hreflang check
    const hreflangMatches = html.match(/<link\b[^>]*\bhreflang=["'][^"']+["'][^>]*>/gi);
    if (hreflangMatches !== null && hreflangMatches.length > 0) {
      const hasXDefault = hreflangMatches.some((tag) => /hreflang=["']x-default["']/i.test(tag));
      if (!hasXDefault) {
        findings.push({
          findingType: 'HREFLANG_NO_XDEFAULT',
          severity: 'INFO',
          detail: 'Hreflang annotations present but no x-default',
          suggestion: 'Add x-default hreflang for unspecified locales',
        });
      }
    }

    return findings;
  }
}

// ============================================================================
// Structured Data Analyzer v1
// ============================================================================

export class StructuredDataAnalyzerV1 implements SiteAnalyzer {
  readonly id = 'structured-data';
  readonly version = 'v1';
  readonly description = 'JSON-LD structured data validation';

  analyze(context: AnalyzerContext): AnalyzerFinding[] {
    const findings: AnalyzerFinding[] = [];
    const { html } = context;

    // Find all JSON-LD scripts
    const jsonLdPattern = /<script\b[^>]*\btype=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match: RegExpExecArray | null;
    let jsonLdCount = 0;

    while ((match = jsonLdPattern.exec(html)) !== null) {
      jsonLdCount += 1;
      const jsonContent = match[1]?.trim() ?? '';
      const scriptIndex = jsonLdCount;

      try {
        const parsed = JSON.parse(jsonContent) as unknown;
        const types = this.extractTypes(parsed);

        if (types.length === 0) {
          findings.push({
            findingType: 'JSONLD_NO_TYPE',
            severity: 'WARNING',
            detail: `JSON-LD script #${scriptIndex} has no @type`,
            evidencePointer: `/html/head/script[@type="application/ld+json"][${scriptIndex}]`,
            suggestion: 'Add @type to structured data',
          });
        } else {
          findings.push({
            findingType: 'JSONLD_VALID',
            severity: 'INFO',
            detail: `JSON-LD script #${scriptIndex}: ${types.join(', ')}`,
            evidencePointer: `/html/head/script[@type="application/ld+json"][${scriptIndex}]`,
          });

          // Check for required properties based on type
          for (const type of types) {
            const missingProps = this.checkRequiredProperties(parsed, type);
            for (const prop of missingProps) {
              findings.push({
                findingType: 'JSONLD_MISSING_PROPERTY',
                severity: 'WARNING',
                detail: `${type} missing recommended property: ${prop}`,
                evidencePointer: `/html/head/script[@type="application/ld+json"][${scriptIndex}]`,
                suggestion: `Add ${prop} to ${type} structured data`,
              });
            }
          }
        }
      } catch {
        findings.push({
          findingType: 'JSONLD_PARSE_ERROR',
          severity: 'ERROR',
          detail: `JSON-LD script #${scriptIndex} is not valid JSON`,
          evidencePointer: `/html/head/script[@type="application/ld+json"][${scriptIndex}]`,
          suggestion: 'Fix JSON syntax errors',
        });
      }
    }

    if (jsonLdCount === 0) {
      findings.push({
        findingType: 'JSONLD_MISSING',
        severity: 'WARNING',
        detail: 'Page has no JSON-LD structured data',
        suggestion: 'Add relevant Schema.org structured data',
      });
    }

    return findings;
  }

  private extractTypes(data: unknown): string[] {
    if (data === null || typeof data !== 'object') return [];
    if (Array.isArray(data)) {
      return data.flatMap((item) => this.extractTypes(item));
    }
    const record = data as Record<string, unknown>;
    const type = record['@type'];
    if (typeof type === 'string') return [type];
    if (Array.isArray(type)) return type.filter((t): t is string => typeof t === 'string');
    // Check @graph
    if (Array.isArray(record['@graph'])) {
      return (record['@graph'] as unknown[]).flatMap((item) => this.extractTypes(item));
    }
    return [];
  }

  private checkRequiredProperties(data: unknown, type: string): string[] {
    const missing: string[] = [];
    const record = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
    if (record === null || typeof record !== 'object') return missing;

    const requiredByType: Record<string, string[]> = {
      Organization: ['name', 'url'],
      Product: ['name'],
      Service: ['name'],
      Article: ['headline'],
      FAQPage: ['mainEntity'],
      BreadcrumbList: ['itemListElement'],
    };

    const required = requiredByType[type] ?? [];
    for (const prop of required) {
      if (!(prop in record)) {
        missing.push(prop);
      }
    }
    return missing;
  }
}

// ============================================================================
// Content Evidence Analyzer v1
// ============================================================================

export class ContentEvidenceAnalyzerV1 implements SiteAnalyzer {
  readonly id = 'content-evidence';
  readonly version = 'v1';
  readonly description = 'Content structure and evidence readiness checks';

  analyze(context: AnalyzerContext): AnalyzerFinding[] {
    const findings: AnalyzerFinding[] = [];
    const { html } = context;

    // Check for FAQ structure
    const hasFaq = /<details\b[^>]*>[\s\S]*?<summary\b/i.test(html)
      || /<(?:dl|div)\b[^>]*\bclass=["'][^"']*faq[^"']*["']/i.test(html);
    if (hasFaq) {
      findings.push({
        findingType: 'FAQ_STRUCTURE_PRESENT',
        severity: 'INFO',
        detail: 'Page contains FAQ-like structure',
      });
    }

    // Check for lists/steps
    const hasSteps = /<ol\b[^>]*>[\s\S]*?<li\b/i.test(html);
    if (hasSteps) {
      findings.push({
        findingType: 'STEPS_STRUCTURE_PRESENT',
        severity: 'INFO',
        detail: 'Page contains ordered list (potential steps)',
      });
    }

    // Check for definition lists
    const hasDefinitions = /<dl\b[^>]*>[\s\S]*?<dt\b/i.test(html);
    if (hasDefinitions) {
      findings.push({
        findingType: 'DEFINITION_STRUCTURE_PRESENT',
        severity: 'INFO',
        detail: 'Page contains definition list',
      });
    }

    // Check for tables (specifications/comparisons)
    const hasTables = /<table\b[^>]*>[\s\S]*?<tr\b/i.test(html);
    if (hasTables) {
      findings.push({
        findingType: 'TABLE_STRUCTURE_PRESENT',
        severity: 'INFO',
        detail: 'Page contains table (potential specifications/comparison)',
      });
    }

    // Check for citations/references
    const hasCitations = /<cite\b/i.test(html)
      || /<(?:a|span)\b[^>]*\bclass=["'][^"']*(?:citation|reference|source)[^"']*["']/i.test(html);
    if (hasCitations) {
      findings.push({
        findingType: 'CITATION_STRUCTURE_PRESENT',
        severity: 'INFO',
        detail: 'Page contains citation/reference elements',
      });
    }

    // Check for author/date metadata
    const hasAuthor = /<[^>]*\b(?:author|byline)[^>]*>/i.test(html)
      || /<(?:time|span)\b[^>]*\bdatetime=["']/i.test(html);
    if (hasAuthor) {
      findings.push({
        findingType: 'AUTHOR_DATE_PRESENT',
        severity: 'INFO',
        detail: 'Page contains author/date metadata',
      });
    }

    // Content length estimation (strip HTML tags)
    const textContent = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const wordCount = textContent.split(/\s+/).length;
    if (wordCount < 300) {
      findings.push({
        findingType: 'CONTENT_THIN',
        severity: 'WARNING',
        detail: `Page has approximately ${wordCount} words (thin content)`,
        suggestion: 'Add more comprehensive content for better answer readiness',
      });
    }

    return findings;
  }
}

// ============================================================================
// Answer Readiness Analyzer v1
// ============================================================================

export class AnswerReadinessAnalyzerV1 implements SiteAnalyzer {
  readonly id = 'answer-readiness';
  readonly version = 'v1';
  readonly description = 'Answer engine optimization readiness checks';

  analyze(context: AnalyzerContext): AnalyzerFinding[] {
    const findings: AnalyzerFinding[] = [];
    const { html } = context;

    // Check for clear heading hierarchy
    const headings = [...html.matchAll(/<h([1-6])\b[^>]*>/gi)].map((m) => Number(m[1]));
    if (headings.length > 0) {
      let hasSkip = false;
      for (let i = 1; i < headings.length; i += 1) {
        const current = headings[i] ?? 1;
        const previous = headings[i - 1] ?? 1;
        if (current > previous + 1) {
          hasSkip = true;
          break;
        }
      }
      if (hasSkip) {
        findings.push({
          findingType: 'HEADING_HIERARCHY_SKIP',
          severity: 'INFO',
          detail: 'Heading levels skip (e.g., H2 to H4)',
          suggestion: 'Maintain proper heading hierarchy for accessibility',
        });
      }
    }

    // Check for question-like headings (good for answer engines)
    const questionHeadings = html.match(/<h[1-6]\b[^>]*>[^<]*\?[^<]*<\/h[1-6]>/gi);
    if (questionHeadings !== null && questionHeadings.length > 0) {
      findings.push({
        findingType: 'QUESTION_HEADINGS_PRESENT',
        severity: 'INFO',
        detail: `Page has ${questionHeadings.length} question-format heading(s)`,
      });
    }

    // Check for concise answer paragraphs (short paragraphs after headings)
    const hasConciseAnswers = /<h[1-6]\b[^>]*>[^<]*<\/h[1-6]>\s*<p\b[^>]*>[^<]{50,300}<\/p>/i.test(html);
    if (hasConciseAnswers) {
      findings.push({
        findingType: 'CONCISE_ANSWER_PRESENT',
        severity: 'INFO',
        detail: 'Page has concise answer paragraphs suitable for featured snippets',
      });
    }

    // Check for schema.org speakable or similar
    const hasSpeakable = /speakable/i.test(html);
    if (hasSpeakable) {
      findings.push({
        findingType: 'SPEAKABLE_PRESENT',
        severity: 'INFO',
        detail: 'Page references speakable specification',
      });
    }

    return findings;
  }
}
