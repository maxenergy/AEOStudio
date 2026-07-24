import { createHash } from 'node:crypto';
import type { PromptScopeRecord } from '@aeostudio/domain/prompt-research';
import { PROMPT_TAXONOMY_CATEGORIES } from '@aeostudio/domain/prompt-research';

export { PROMPT_TAXONOMY_CATEGORIES };
export type { PromptTaxonomyCategory } from '@aeostudio/domain/prompt-research';

// --- Input types ---

export interface PromptGeneratorProfileRevision {
  id: string;
  organizationName: string;
  industry: string;
  targetAudiences: string[];
  valueProposition: string;
}

export interface PromptGeneratorOfferingRevision {
  id: string;
  name: string;
  category: string;
  keyFeatures: string[];
  differentiators: string[];
}

export interface PromptGeneratorClaimRevision {
  id: string;
  statement: string;
  claimType: string;
  evidenceSnapshotIds: string[];
}

export interface PromptResearchGeneratorInput {
  profileRevision: PromptGeneratorProfileRevision;
  offeringRevision: PromptGeneratorOfferingRevision;
  approvedClaimRevisions: PromptGeneratorClaimRevision[];
  scopes: PromptScopeRecord[];
  businessGoals?: string[];
}

// --- Output types ---

export interface GeneratedPromptRecord {
  id: string;
  text: string;
  taxonomyCategory: string;
  persona: string;
  journeyStage: string;
  queryType: string;
  locale: string;
}

export interface PromptGenerationMetadata {
  generatorId: string;
  generatorVersion: string;
  templateHash: string;
  inputRevisionIds: string[];
  generatedAt: Date;
  cost?: { amount: string; currency: string };
  error?: string;
  approvalStatus?: never;
}

export interface PromptResearchGeneratorResult {
  prompts: GeneratedPromptRecord[];
  metadata: PromptGenerationMetadata;
  status: 'DRAFT';
}

// --- Port interface ---

export interface PromptResearchGenerator {
  readonly generatorId: string;
  generate(
    input: PromptResearchGeneratorInput,
    nextId: () => string,
  ): PromptResearchGeneratorResult;
}

// --- Quality control ---

export type PromptQualityIssueCode =
  | 'PROMPT_COUNT'
  | 'DUPLICATE_PROMPTS'
  | 'EMPTY_PROMPT_TEXT'
  | 'FORBIDDEN_GUARANTEE'
  | 'TAXONOMY_COVERAGE';

export interface PromptQualityIssue {
  code: PromptQualityIssueCode;
  path: string;
  message: string;
}

const FORBIDDEN_PATTERNS = [
  /\bguarantee[sd]?\b/i,
  /\b100%\s+(improvement|increase|success)\b/i,
  /\bwill\s+(definitely|certainly|absolutely)\b/i,
  /\bpromise[sd]?\s+(to|that)\b/i,
  /\branked\s*#?\s*1\b/i,
];

export function validatePromptGenerationOutput(input: {
  prompts: GeneratedPromptRecord[];
  scopes: PromptScopeRecord[];
}): PromptQualityIssue[] {
  const issues: PromptQualityIssue[] = [];

  if (input.prompts.length < 20 || input.prompts.length > 50) {
    issues.push({
      code: 'PROMPT_COUNT',
      path: 'prompts',
      message: `Prompt count must be 20-50, got ${input.prompts.length}.`,
    });
  }

  const seenTexts = new Map<string, number>();
  for (let i = 0; i < input.prompts.length; i++) {
    const prompt = input.prompts[i]!;
    if (prompt.text.trim().length === 0) {
      issues.push({
        code: 'EMPTY_PROMPT_TEXT',
        path: `prompts.${i}.text`,
        message: 'Prompt text must not be empty.',
      });
      continue;
    }
    const normalized = prompt.text.trim().toLowerCase();
    const existing = seenTexts.get(normalized);
    if (existing !== undefined) {
      issues.push({
        code: 'DUPLICATE_PROMPTS',
        path: `prompts.${i}.text`,
        message: `Duplicate of prompt at index ${existing}.`,
      });
    } else {
      seenTexts.set(normalized, i);
    }

    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(prompt.text)) {
        issues.push({
          code: 'FORBIDDEN_GUARANTEE',
          path: `prompts.${i}.text`,
          message: 'Prompt contains forbidden guarantee or ranking language.',
        });
        break;
      }
    }
  }

  return issues;
}

// --- Deterministic Generator ---

interface TaxonomyTemplate {
  category: string;
  journeyStage: string;
  queryType: string;
  templateEn: string;
  templateZh: string;
}

const TAXONOMY_TEMPLATES: TaxonomyTemplate[] = [
  {
    category: 'branded',
    journeyStage: 'discover',
    queryType: 'informational',
    templateEn: 'What is {offering} by {org} and how does it work?',
    templateZh: '{org} 的 {offering} 是什么？它是如何工作的？',
  },
  {
    category: 'non-branded',
    journeyStage: 'discover',
    queryType: 'informational',
    templateEn: 'What are the best {category} solutions for {audience}?',
    templateZh: '适合{audience}的最佳{category}解决方案有哪些？',
  },
  {
    category: 'definition',
    journeyStage: 'discover',
    queryType: 'definitional',
    templateEn: 'What does {offering} mean in the context of {industry}?',
    templateZh: '在{industry}领域中，{offering}意味着什么？',
  },
  {
    category: 'problem-solution',
    journeyStage: 'evaluate',
    queryType: 'investigational',
    templateEn: 'How does {offering} solve the challenge of {feature} for {audience}?',
    templateZh: '{offering} 如何为{audience}解决{feature}方面的挑战？',
  },
  {
    category: 'how-to',
    journeyStage: 'adopt',
    queryType: 'instructional',
    templateEn: 'How do I get started with {offering} for {audience}?',
    templateZh: '如何开始使用 {offering} 来服务{audience}？',
  },
  {
    category: 'use-case',
    journeyStage: 'evaluate',
    queryType: 'investigational',
    templateEn: 'What are practical use cases of {offering} in {industry}?',
    templateZh: '{offering} 在{industry}中有哪些实际应用场景？',
  },
  {
    category: 'specification',
    journeyStage: 'evaluate',
    queryType: 'informational',
    templateEn: 'What are the technical specifications and requirements of {offering}?',
    templateZh: '{offering} 的技术规格和要求是什么？',
  },
  {
    category: 'evidence-trust',
    journeyStage: 'verify',
    queryType: 'verification',
    templateEn: 'What evidence supports the effectiveness of {offering}?',
    templateZh: '有什么证据支持 {offering} 的有效性？',
  },
  {
    category: 'comparison-alternative',
    journeyStage: 'evaluate',
    queryType: 'comparison',
    templateEn: 'How does {offering} compare to alternative {category} tools?',
    templateZh: '{offering} 与其他{category}工具相比如何？',
  },
  {
    category: 'purchase-adoption',
    journeyStage: 'adopt',
    queryType: 'transactional',
    templateEn: 'What is the pricing and deployment model for {offering}?',
    templateZh: '{offering} 的定价和部署模式是什么？',
  },
  {
    category: 'troubleshooting',
    journeyStage: 'retain',
    queryType: 'instructional',
    templateEn: 'How do I troubleshoot common issues with {offering}?',
    templateZh: '如何排查 {offering} 的常见问题？',
  },
  {
    category: 'local-region',
    journeyStage: 'discover',
    queryType: 'informational',
    templateEn: 'Is {offering} available in {region} and does it support {locale}?',
    templateZh: '{offering} 在{region}是否可用？是否支持{locale}语言？',
  },
  {
    category: 'persona',
    journeyStage: 'evaluate',
    queryType: 'investigational',
    templateEn: 'How would a {audience} benefit from adopting {offering}?',
    templateZh: '作为{audience}，采用 {offering} 能带来哪些好处？',
  },
  {
    category: 'journey-stage',
    journeyStage: 'retain',
    queryType: 'informational',
    templateEn: 'What advanced features does {offering} offer for existing users?',
    templateZh: '{offering} 为现有用户提供了哪些高级功能？',
  },
  {
    category: 'query-intent',
    journeyStage: 'discover',
    queryType: 'navigational',
    templateEn: 'Where can I find official documentation and resources for {offering}?',
    templateZh: '在哪里可以找到 {offering} 的官方文档和资源？',
  },
];

const PERSONAS = [
  'prospective evaluator',
  'hands-on practitioner',
  'organizational decision maker',
] as const;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function computeTemplateHash(input: PromptResearchGeneratorInput): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        profile: input.profileRevision,
        offering: input.offeringRevision,
        claims: input.approvedClaimRevisions,
        scopes: input.scopes,
        goals: input.businessGoals ?? [],
      }),
      'utf8',
    )
    .digest('hex');
}

function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`);
}

export class DeterministicPromptGenerator implements PromptResearchGenerator {
  readonly generatorId = 'deterministic-prompt-v1';

  generate(
    input: PromptResearchGeneratorInput,
    nextId: () => string,
  ): PromptResearchGeneratorResult {
    const prompts: GeneratedPromptRecord[] = [];
    const { profileRevision: profile, offeringRevision: offering } = input;

    const vars: Record<string, string> = {
      org: profile.organizationName,
      offering: offering.name,
      category: offering.category,
      industry: profile.industry,
      audience: profile.targetAudiences[0] ?? 'teams',
      feature: offering.keyFeatures[0] ?? 'core functionality',
      region: '',
      locale: '',
    };

    for (const scope of input.scopes) {
      const isZh = scope.locale.startsWith('zh');
      vars.region = scope.region;
      vars.locale = scope.locale;

      for (const tmpl of TAXONOMY_TEMPLATES) {
        const template = isZh ? tmpl.templateZh : tmpl.templateEn;
        const text = fillTemplate(template, vars);
        const persona = PERSONAS[prompts.length % PERSONAS.length] ?? 'prospective evaluator';
        prompts.push({
          id: nextId(),
          text,
          taxonomyCategory: tmpl.category,
          persona,
          journeyStage: tmpl.journeyStage,
          queryType: tmpl.queryType,
          locale: scope.locale,
        });
      }
    }

    // Trim to max 50 if needed (15 templates × 2 scopes = 30, within bounds)
    const trimmed = prompts.slice(0, 50);

    const inputRevisionIds = [
      input.profileRevision.id,
      input.offeringRevision.id,
      ...input.approvedClaimRevisions.map((c) => c.id),
    ];

    return {
      prompts: trimmed,
      metadata: {
        generatorId: this.generatorId,
        generatorVersion: '1.0.0',
        templateHash: computeTemplateHash(input),
        inputRevisionIds,
        generatedAt: new Date(),
      },
      status: 'DRAFT',
    };
  }
}

// --- Structured LLM Generator (skeleton, fail-closed) ---

export interface StructuredLlmPromptGeneratorConfig {
  provider: string | null;
  model: string | null;
  modelVersion?: string;
  apiKey?: string;
}

export class StructuredLlmPromptGenerator implements PromptResearchGenerator {
  readonly generatorId = 'structured-llm-prompt-v1';
  private readonly config: StructuredLlmPromptGeneratorConfig;

  constructor(config: StructuredLlmPromptGeneratorConfig) {
    this.config = config;
  }

  generate(
    input: PromptResearchGeneratorInput,
    _nextId: () => string, // eslint-disable-line @typescript-eslint/no-unused-vars
  ): PromptResearchGeneratorResult {
    if (!this.config.provider || !this.config.model) {
      return {
        prompts: [],
        metadata: {
          generatorId: this.generatorId,
          generatorVersion: '1.0.0',
          templateHash: computeTemplateHash(input),
          inputRevisionIds: [
            input.profileRevision.id,
            input.offeringRevision.id,
            ...input.approvedClaimRevisions.map((c) => c.id),
          ],
          generatedAt: new Date(),
          error: 'LLM provider not configured. Set provider and model to enable generation.',
        },
        status: 'DRAFT',
      };
    }

    // Production implementation would call the configured LLM provider here.
    // Output must pass Zod schema validation before being returned.
    // For now, fail closed.
    return {
      prompts: [],
      metadata: {
        generatorId: this.generatorId,
        generatorVersion: '1.0.0',
        templateHash: computeTemplateHash(input),
        inputRevisionIds: [
          input.profileRevision.id,
          input.offeringRevision.id,
          ...input.approvedClaimRevisions.map((c) => c.id),
        ],
        generatedAt: new Date(),
        error: 'Structured LLM generation not yet implemented. Use DeterministicPromptGenerator.',
      },
      status: 'DRAFT',
    };
  }
}
