export interface PromptSourceContext {
  profile: { id: string; revision: number };
  offering: { id: string; revision: number };
  claimRevisionIds: string[];
}

export interface PromptDraftRecord {
  id: string;
  text: string;
  persona: string;
  journeyStage: string;
  queryType: string;
}

export interface PromptScopeRecord {
  market: string;
  locale: string;
  region: string;
}

export type PromptRevisionStatus = 'DRAFT' | 'APPROVED' | 'STALE';

export interface PromptSetRecord {
  id: string;
  tenantId: string;
  workspaceId: string;
  currentRevision: number;
  createdAt: string;
}

export interface PromptRevisionRecord {
  id: string;
  promptSetId: string;
  revision: number;
  title: string;
  subject: string;
  sourceContext: PromptSourceContext;
  prompts: PromptDraftRecord[];
  scopes: PromptScopeRecord[];
  contentHash: string;
  status: PromptRevisionStatus;
  createdByUserId: string;
  createdAt: string;
}

export type RegistryStatus = 'AVAILABLE' | 'UNAVAILABLE';
export type SurfaceKind = 'SEARCH_DATA' | 'CONSUMER_SEARCH' | 'CONSUMER_AI_ANSWER';
export type ProviderSurfaceAcquisitionClass =
  'CONSUMER_UI_SAMPLE' | 'MODEL_API_DIAGNOSTIC' | 'SEARCH_DATA_API' | 'MANUAL_IMPORT';

export interface ProviderSurfaceRegistryRecord {
  id: string;
  providerKey: string;
  providerName: string;
  surfaceKey: string;
  surfaceName: string;
  surfaceKind: SurfaceKind;
  acquisitionClass: ProviderSurfaceAcquisitionClass;
  acquisitionMethod: string;
  status: RegistryStatus;
  unavailableReason: string | null;
  adapterVersion: string;
}

export interface MeasurementScenarioInput {
  providerKey: string;
  surfaceKey: string;
  model: string;
  modelVersion: string;
  account: string;
  acquisitionMethod: string;
  freshSession: boolean;
  searchEnabled: boolean;
  parameters: Record<string, unknown>;
  repetitions: number;
}

export interface MeasurementScenarioRecord extends MeasurementScenarioInput {
  id: string;
  promptRevisionId: string;
  version: number;
  contentHash: string;
  registryStatus: RegistryStatus | 'UNKNOWN';
  createdAt: string;
}

export interface PromptApprovalRecord {
  id: string;
  promptRevisionId: string;
  scenarioId: string;
  promptContentHash: string;
  scenarioContentHash: string;
  approvedByUserId: string;
  approvedAt: string;
}

export interface PromptBundle {
  promptSet: PromptSetRecord;
  revision: PromptRevisionRecord;
  scenario: MeasurementScenarioRecord;
  approval: PromptApprovalRecord | null;
  approvalCurrent: boolean;
  previousApprovalStale: boolean;
}

export type PromptApprovalIssueCode =
  | 'PROMPT_COUNT'
  | 'PROMPT_TEXT'
  | 'PROMPT_TAXONOMY'
  | 'SCOPE_COUNT'
  | 'SCOPE_MARKET'
  | 'SCOPE_LOCALE'
  | 'SCOPE_REGION'
  | 'REPETITIONS'
  | 'SURFACE_NOT_REGISTERED'
  | 'SURFACE_ACQUISITION_METHOD';

export interface PromptApprovalIssue {
  code: PromptApprovalIssueCode;
  path: string;
  message: string;
}

const PROMPT_PATTERNS = [
  {
    journeyStage: 'discover',
    queryType: 'definition',
    phrase: 'What is {subject} and who is it for?',
  },
  {
    journeyStage: 'evaluate',
    queryType: 'principle',
    phrase: 'How does {subject} work in practice?',
  },
  {
    journeyStage: 'evaluate',
    queryType: 'comparison',
    phrase: 'How should someone compare {subject} with alternatives?',
  },
  {
    journeyStage: 'adopt',
    queryType: 'how-to',
    phrase: 'How can someone start using {subject}?',
  },
  {
    journeyStage: 'verify',
    queryType: 'evidence',
    phrase: 'What evidence supports the stated outcomes of {subject}?',
  },
] as const;

const DEFAULT_PERSONAS = [
  'prospective evaluator',
  'hands-on practitioner',
  'organizational decision maker',
  'existing user',
] as const;

export function generateDeterministicPromptSkeleton(
  subject: string,
  nextId: () => string,
): PromptDraftRecord[] {
  return DEFAULT_PERSONAS.flatMap((persona) =>
    PROMPT_PATTERNS.map((pattern) => ({
      id: nextId(),
      text: `${pattern.phrase.replace('{subject}', subject)} Context: ${persona}.`,
      persona,
      journeyStage: pattern.journeyStage,
      queryType: pattern.queryType,
    })),
  );
}

export function promptApprovalIssues(input: {
  revision: Pick<PromptRevisionRecord, 'prompts' | 'scopes'>;
  scenario: MeasurementScenarioRecord;
  registry: ProviderSurfaceRegistryRecord | null;
}): PromptApprovalIssue[] {
  const issues: PromptApprovalIssue[] = [];
  if (input.revision.prompts.length < 20 || input.revision.prompts.length > 50) {
    issues.push({
      code: 'PROMPT_COUNT',
      path: 'prompts',
      message: 'An approved Prompt Set requires 20 to 50 prompts.',
    });
  }
  input.revision.prompts.forEach((prompt, index) => {
    if (prompt.text.trim().length === 0) {
      issues.push({
        code: 'PROMPT_TEXT',
        path: `prompts.${index}.text`,
        message: 'Prompt text is required.',
      });
    }
    if (
      prompt.persona.trim().length === 0 ||
      prompt.journeyStage.trim().length === 0 ||
      prompt.queryType.trim().length === 0
    ) {
      issues.push({
        code: 'PROMPT_TAXONOMY',
        path: `prompts.${index}`,
        message: 'Persona, journey stage and query type are required.',
      });
    }
  });
  if (input.revision.scopes.length < 1 || input.revision.scopes.length > 3) {
    issues.push({
      code: 'SCOPE_COUNT',
      path: 'scopes',
      message: 'An approved Prompt Set requires one to three scopes.',
    });
  }
  input.revision.scopes.forEach((scope, index) => {
    if (scope.market.trim().length === 0) {
      issues.push({
        code: 'SCOPE_MARKET',
        path: `scopes.${index}.market`,
        message: 'Market is required.',
      });
    }
    if (scope.locale.trim().length === 0) {
      issues.push({
        code: 'SCOPE_LOCALE',
        path: `scopes.${index}.locale`,
        message: 'Locale is required.',
      });
    }
    if (scope.region.trim().length === 0) {
      issues.push({
        code: 'SCOPE_REGION',
        path: `scopes.${index}.region`,
        message: 'Region is required.',
      });
    }
  });
  if (input.scenario.repetitions < 3) {
    issues.push({
      code: 'REPETITIONS',
      path: 'scenario.repetitions',
      message: 'Each Prompt and Surface requires at least three repetitions.',
    });
  }
  if (input.registry === null) {
    issues.push({
      code: 'SURFACE_NOT_REGISTERED',
      path: 'scenario.surfaceKey',
      message: 'The Provider and consumer Surface pair is not registered.',
    });
  } else if (input.registry.acquisitionMethod !== input.scenario.acquisitionMethod) {
    issues.push({
      code: 'SURFACE_ACQUISITION_METHOD',
      path: 'scenario.acquisitionMethod',
      message: 'The acquisition method does not match the registered Surface method.',
    });
  }
  return issues;
}
