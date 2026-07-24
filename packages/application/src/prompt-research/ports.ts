import type { TenantContext } from '../identity-access/index.js';
import type {
  MeasurementScenarioInput,
  PromptApprovalIssue,
  PromptBundle,
  PromptDraftRecord,
  PromptScopeRecord,
  PromptSourceContext,
  ProviderSurfaceRegistryRecord,
} from '@aeostudio/domain/prompt-research';

export interface PromptResearchStore {
  listRegistry(input: { context: TenantContext }): Promise<ProviderSurfaceRegistryRecord[]>;
  listApprovedPromptSets(input: { context: TenantContext }): Promise<
    {
      promptSetId: string;
      revisionId: string;
      revision: number;
      title: string;
      subject: string;
      contentHash: string;
    }[]
  >;
  createProposal(input: {
    context: TenantContext;
    promptSetId: string;
    revisionId: string;
    scenarioId: string;
    title: string;
    subject: string;
    sourceContext: PromptSourceContext;
    prompts: PromptDraftRecord[];
    scopes: PromptScopeRecord[];
    scenario: MeasurementScenarioInput;
    promptContentHash: string;
    scenarioContentHash: string;
    createdAt: Date;
    auditEventId: string;
  }): Promise<PromptBundle | null>;
  findCurrent(input: { context: TenantContext; promptSetId: string }): Promise<PromptBundle | null>;
  findRevision(input: {
    context: TenantContext;
    promptSetId: string;
    revisionId: string;
  }): Promise<PromptBundle | null>;
  createRevision(input: {
    context: TenantContext;
    promptSetId: string;
    expectedRevision: number;
    revisionId: string;
    scenarioId: string;
    prompts: PromptDraftRecord[];
    scopes: PromptScopeRecord[];
    scenario: MeasurementScenarioInput;
    promptContentHash: string;
    scenarioContentHash: string;
    createdAt: Date;
    auditEventId: string;
  }): Promise<PromptBundle | null>;
  approveRevision(input: {
    context: TenantContext;
    promptSetId: string;
    revisionId: string;
    expectedPromptHash: string;
    expectedScenarioHash: string;
    approvalId: string;
    approvedAt: Date;
    auditEventId: string;
  }): Promise<
    | { outcome: 'SUCCEEDED'; bundle: PromptBundle }
    | { outcome: 'NOT_APPROVABLE'; issues: PromptApprovalIssue[] }
    | { outcome: 'HASH_MISMATCH' }
    | { outcome: 'NOT_FOUND' }
  >;
}
