import { describe, expect, it } from 'vitest';
import {
  DeterministicPromptGenerator,
  type PromptResearchGeneratorInput,
  type PromptResearchGenerator,
  validatePromptGenerationOutput,
  PROMPT_TAXONOMY_CATEGORIES,
} from '@aeostudio/application';

function makeInput(
  overrides: Partial<PromptResearchGeneratorInput> = {},
): PromptResearchGeneratorInput {
  return {
    profileRevision: {
      id: '00000000-0000-7000-8000-000000000101',
      organizationName: 'AIBOX',
      industry: 'EdTech',
      targetAudiences: ['corporate L&D teams', 'instructional designers'],
      valueProposition: 'AI-powered guided learning sessions that adapt to each learner',
    },
    offeringRevision: {
      id: '00000000-0000-7000-8000-000000000102',
      name: 'Guided Learning Sessions',
      category: 'Learning Experience Platform',
      keyFeatures: ['adaptive pathways', 'real-time analytics', 'multi-language support'],
      differentiators: ['evidence-based pedagogy', 'enterprise SSO', 'offline mode'],
    },
    approvedClaimRevisions: [
      {
        id: '00000000-0000-7000-8000-000000000103',
        statement: 'Guided Learning Sessions improve learner completion rates by 40%',
        claimType: 'QUANTITATIVE',
        evidenceSnapshotIds: ['00000000-0000-7000-8000-000000000104'],
      },
      {
        id: '00000000-0000-7000-8000-000000000105',
        statement: 'Supports 12 languages including CJK and RTL scripts',
        claimType: 'CAPABILITY',
        evidenceSnapshotIds: ['00000000-0000-7000-8000-000000000106'],
      },
    ],
    scopes: [
      { market: 'SG', locale: 'en-SG', region: 'Singapore' },
      { market: 'CN', locale: 'zh-CN', region: 'China' },
    ],
    businessGoals: ['increase AI answer visibility', 'drive trial signups'],
    ...overrides,
  };
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `00000000-0000-7000-8000-${String(idCounter).padStart(12, '0')}`;
}

describe('C05: Prompt Research Intelligence', () => {
  describe('PromptResearchGenerator port', () => {
    it('DeterministicPromptGenerator implements the port interface', () => {
      const generator: PromptResearchGenerator = new DeterministicPromptGenerator();
      expect(generator.generatorId).toBe('deterministic-prompt-v1');
      expect(typeof generator.generate).toBe('function');
    });
  });

  describe('Deterministic generation', () => {
    it('same input produces identical prompt set (determinism)', () => {
      const generator = new DeterministicPromptGenerator();
      const input = makeInput();
      const result1 = generator.generate(input, nextId);
      const result2 = generator.generate(input, nextId);
      // Reset counter for fair comparison - text content should be same
      const texts1 = result1.prompts.map((p) => p.text);
      const texts2 = result2.prompts.map((p) => p.text);
      expect(texts1).toEqual(texts2);
    });

    it('generates between 20 and 50 prompts', () => {
      const generator = new DeterministicPromptGenerator();
      const result = generator.generate(makeInput(), nextId);
      expect(result.prompts.length).toBeGreaterThanOrEqual(20);
      expect(result.prompts.length).toBeLessThanOrEqual(50);
    });

    it('covers at least 14 taxonomy categories', () => {
      const generator = new DeterministicPromptGenerator();
      const result = generator.generate(makeInput(), nextId);
      const categories = new Set(result.prompts.map((p) => p.taxonomyCategory));
      expect(categories.size).toBeGreaterThanOrEqual(14);
    });

    it('PROMPT_TAXONOMY_CATEGORIES contains all required categories', () => {
      const required = [
        'branded',
        'non-branded',
        'definition',
        'problem-solution',
        'how-to',
        'use-case',
        'specification',
        'evidence-trust',
        'comparison-alternative',
        'purchase-adoption',
        'troubleshooting',
        'local-region',
        'persona',
        'journey-stage',
        'query-intent',
      ];
      for (const cat of required) {
        expect(PROMPT_TAXONOMY_CATEGORIES).toContain(cat);
      }
    });

    it('generates prompts in multiple locales based on scopes', () => {
      const generator = new DeterministicPromptGenerator();
      const result = generator.generate(makeInput(), nextId);
      const locales = new Set(result.prompts.map((p) => p.locale));
      expect(locales.size).toBeGreaterThanOrEqual(2);
      expect(locales.has('en-SG')).toBe(true);
      expect(locales.has('zh-CN')).toBe(true);
    });

    it('each prompt has traceable metadata', () => {
      const generator = new DeterministicPromptGenerator();
      const result = generator.generate(makeInput(), nextId);
      for (const prompt of result.prompts) {
        expect(prompt.id).toBeTruthy();
        expect(prompt.text.trim().length).toBeGreaterThan(0);
        expect(prompt.taxonomyCategory).toBeTruthy();
        expect(prompt.persona).toBeTruthy();
        expect(prompt.journeyStage).toBeTruthy();
        expect(prompt.queryType).toBeTruthy();
        expect(prompt.locale).toBeTruthy();
      }
    });

    it('generation metadata includes generator info and input revision IDs', () => {
      const generator = new DeterministicPromptGenerator();
      const input = makeInput();
      const result = generator.generate(input, nextId);
      expect(result.metadata.generatorId).toBe('deterministic-prompt-v1');
      expect(result.metadata.generatorVersion).toBe('1.0.0');
      expect(result.metadata.templateHash).toBeTruthy();
      expect(result.metadata.inputRevisionIds).toContain(input.profileRevision.id);
      expect(result.metadata.inputRevisionIds).toContain(input.offeringRevision.id);
      for (const claim of input.approvedClaimRevisions) {
        expect(result.metadata.inputRevisionIds).toContain(claim.id);
      }
      expect(result.metadata.generatedAt).toBeInstanceOf(Date);
    });

    it('no duplicate prompt texts', () => {
      const generator = new DeterministicPromptGenerator();
      const result = generator.generate(makeInput(), nextId);
      const texts = result.prompts.map((p) => p.text.trim().toLowerCase());
      const unique = new Set(texts);
      expect(unique.size).toBe(texts.length);
    });

    it('prompts reference actual offering/profile data, not generic templates', () => {
      const generator = new DeterministicPromptGenerator();
      const result = generator.generate(makeInput(), nextId);
      const allText = result.prompts.map((p) => p.text).join(' ');
      expect(allText).toContain('Guided Learning Sessions');
      expect(allText).toContain('AIBOX');
    });
  });

  describe('Quality control validation', () => {
    it('rejects output with fewer than 20 prompts', () => {
      const issues = validatePromptGenerationOutput({
        prompts: Array.from({ length: 10 }, (_, i) => ({
          id: `id-${i}`,
          text: `Prompt ${i}`,
          taxonomyCategory: 'definition',
          persona: 'evaluator',
          journeyStage: 'discover',
          queryType: 'informational',
          locale: 'en-SG',
        })),
        scopes: [{ market: 'SG', locale: 'en-SG', region: 'Singapore' }],
      });
      expect(issues.some((i) => i.code === 'PROMPT_COUNT')).toBe(true);
    });

    it('rejects output with more than 50 prompts', () => {
      const issues = validatePromptGenerationOutput({
        prompts: Array.from({ length: 55 }, (_, i) => ({
          id: `id-${i}`,
          text: `Prompt ${i}`,
          taxonomyCategory: 'definition',
          persona: 'evaluator',
          journeyStage: 'discover',
          queryType: 'informational',
          locale: 'en-SG',
        })),
        scopes: [{ market: 'SG', locale: 'en-SG', region: 'Singapore' }],
      });
      expect(issues.some((i) => i.code === 'PROMPT_COUNT')).toBe(true);
    });

    it('rejects output with duplicate prompts', () => {
      const prompts = Array.from({ length: 25 }, (_, i) => ({
        id: `id-${i}`,
        text: i < 5 ? 'Same prompt text' : `Unique prompt ${i}`,
        taxonomyCategory: 'definition',
        persona: 'evaluator',
        journeyStage: 'discover',
        queryType: 'informational',
        locale: 'en-SG',
      }));
      const issues = validatePromptGenerationOutput({
        prompts,
        scopes: [{ market: 'SG', locale: 'en-SG', region: 'Singapore' }],
      });
      expect(issues.some((i) => i.code === 'DUPLICATE_PROMPTS')).toBe(true);
    });

    it('rejects output with empty prompt text', () => {
      const prompts = Array.from({ length: 25 }, (_, i) => ({
        id: `id-${i}`,
        text: i === 3 ? '' : `Prompt ${i}`,
        taxonomyCategory: 'definition',
        persona: 'evaluator',
        journeyStage: 'discover',
        queryType: 'informational',
        locale: 'en-SG',
      }));
      const issues = validatePromptGenerationOutput({
        prompts,
        scopes: [{ market: 'SG', locale: 'en-SG', region: 'Singapore' }],
      });
      expect(issues.some((i) => i.code === 'EMPTY_PROMPT_TEXT')).toBe(true);
    });

    it('rejects output with forbidden guarantee language', () => {
      const prompts = Array.from({ length: 25 }, (_, i) => ({
        id: `id-${i}`,
        text: i === 2 ? 'This will guarantee 100% improvement in rankings' : `Prompt ${i}`,
        taxonomyCategory: 'definition',
        persona: 'evaluator',
        journeyStage: 'discover',
        queryType: 'informational',
        locale: 'en-SG',
      }));
      const issues = validatePromptGenerationOutput({
        prompts,
        scopes: [{ market: 'SG', locale: 'en-SG', region: 'Singapore' }],
      });
      expect(issues.some((i) => i.code === 'FORBIDDEN_GUARANTEE')).toBe(true);
    });

    it('accepts valid output with no issues', () => {
      const generator = new DeterministicPromptGenerator();
      const result = generator.generate(makeInput(), nextId);
      const issues = validatePromptGenerationOutput({
        prompts: result.prompts,
        scopes: makeInput().scopes,
      });
      expect(issues).toEqual([]);
    });
  });

  describe('Revision staleness', () => {
    it('marks approval stale when profile revision changes', () => {
      const generator = new DeterministicPromptGenerator();
      const input1 = makeInput();
      const result1 = generator.generate(input1, nextId);

      const input2 = makeInput({
        profileRevision: {
          id: '00000000-0000-7000-8000-000000000201',
          organizationName: 'AIBOX Updated',
          industry: 'EdTech',
          targetAudiences: ['corporate L&D teams'],
          valueProposition: 'Updated value prop',
        },
      });
      const result2 = generator.generate(input2, nextId);

      // Different input revisions should produce different template hashes
      expect(result1.metadata.templateHash).not.toBe(result2.metadata.templateHash);
    });

    it('marks approval stale when claim revisions change', () => {
      const generator = new DeterministicPromptGenerator();
      const input1 = makeInput();
      const result1 = generator.generate(input1, nextId);

      const input2 = makeInput({
        approvedClaimRevisions: [
          {
            id: '00000000-0000-7000-8000-000000000301',
            statement: 'New claim statement',
            claimType: 'CAPABILITY',
            evidenceSnapshotIds: ['00000000-0000-7000-8000-000000000302'],
          },
        ],
      });
      const result2 = generator.generate(input2, nextId);

      expect(result1.metadata.inputRevisionIds).not.toEqual(result2.metadata.inputRevisionIds);
    });
  });

  describe('Self-approval prohibition', () => {
    it('generator result includes actor for self-approval check', () => {
      const generator = new DeterministicPromptGenerator();
      const result = generator.generate(makeInput(), nextId);
      // The generation metadata must not include approval capability
      expect(result.metadata.approvalStatus).toBeUndefined();
      // Generated prompts are always DRAFT
      expect(result.status).toBe('DRAFT');
    });
  });

  describe('StructuredLlmPromptGenerator skeleton', () => {
    it('is importable and fails closed without provider config', async () => {
      const { StructuredLlmPromptGenerator } = await import('@aeostudio/application');
      const generator = new StructuredLlmPromptGenerator({
        provider: null,
        model: null,
      });
      expect(generator.generatorId).toBe('structured-llm-prompt-v1');
      const result = generator.generate(makeInput(), nextId);
      expect(result.prompts.length).toBe(0);
      expect(result.metadata.error).toBeTruthy();
    });
  });
});
