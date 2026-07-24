import type { PromptResearchStore } from '@aeostudio/application/prompt-research';
import {
  promptApprovalIssues,
  type PromptApprovalRecord,
  type PromptBundle,
  type ProviderSurfaceRegistryRecord,
} from '@aeostudio/domain/prompt-research';

import {
  FAKE_ARTIFACT_LINEAGE,
  fakeArtifactPromptBundle,
} from '../artifacts/fake-artifact-lineage-fixture.js';

const REGISTRY: ProviderSurfaceRegistryRecord[] = [
  {
    id: '00000000-0000-7000-8000-000000000701',
    providerKey: 'fixture-provider',
    providerName: 'Fixture Provider',
    surfaceKey: 'consumer-answer-sandbox',
    surfaceName: 'Consumer Answer Sandbox',
    surfaceKind: 'CONSUMER_AI_ANSWER',
    acquisitionClass: 'MANUAL_IMPORT',
    acquisitionMethod: 'MANUAL_IMPORT',
    status: 'AVAILABLE',
    unavailableReason: null,
    adapterVersion: 'fixture-v1',
  },
  {
    id: '00000000-0000-7000-8000-000000000702',
    providerKey: 'offline-fixture-provider',
    providerName: 'Offline Fixture Provider',
    surfaceKey: 'regional-answer-fixture',
    surfaceName: 'Regional Answer Fixture',
    surfaceKind: 'CONSUMER_AI_ANSWER',
    acquisitionClass: 'CONSUMER_UI_SAMPLE',
    acquisitionMethod: 'AUTHORIZED_BROWSER_SAMPLE',
    status: 'UNAVAILABLE',
    unavailableReason: 'Fixture unavailable; a later run reports NOT_CHECKED.',
    adapterVersion: 'fixture-v1',
  },
  {
    id: '00000000-0000-7000-8000-000000000703',
    providerKey: 'openai',
    providerName: 'OpenAI',
    surfaceKey: 'chatgpt-search',
    surfaceName: 'ChatGPT Search',
    surfaceKind: 'CONSUMER_AI_ANSWER',
    acquisitionClass: 'MANUAL_IMPORT',
    acquisitionMethod: 'MANUAL_IMPORT',
    status: 'UNAVAILABLE',
    unavailableReason: 'Only reviewed manual import is available in this environment.',
    adapterVersion: 'manual-import-v1',
  },
];

export class InMemoryPromptResearchStore implements PromptResearchStore {
  private readonly bundles = new Map<string, PromptBundle>();
  private readonly revisions = new Map<string, PromptBundle>();

  listRegistry(): ReturnType<PromptResearchStore['listRegistry']> {
    return Promise.resolve(REGISTRY.map((entry) => ({ ...entry })));
  }

  createProposal(input: Parameters<PromptResearchStore['createProposal']>[0]) {
    const registry = this.registry(input.scenario.providerKey, input.scenario.surfaceKey);
    const bundle: PromptBundle = {
      promptSet: {
        id: input.promptSetId,
        tenantId: input.context.tenantId,
        workspaceId: input.context.workspaceId,
        currentRevision: 1,
        createdAt: input.createdAt.toISOString(),
      },
      revision: {
        id: input.revisionId,
        promptSetId: input.promptSetId,
        revision: 1,
        title: input.title,
        subject: input.subject,
        sourceContext: input.sourceContext,
        prompts: input.prompts,
        scopes: input.scopes,
        contentHash: input.promptContentHash,
        status: 'DRAFT',
        createdByUserId: input.context.actorUserId,
        createdAt: input.createdAt.toISOString(),
      },
      scenario: {
        id: input.scenarioId,
        promptRevisionId: input.revisionId,
        version: 1,
        ...input.scenario,
        contentHash: input.scenarioContentHash,
        registryStatus: registry?.status ?? 'UNKNOWN',
        createdAt: input.createdAt.toISOString(),
      },
      approval: null,
      approvalCurrent: false,
      previousApprovalStale: false,
    };
    const key = this.key(input.context.tenantId, input.context.workspaceId, input.promptSetId);
    this.bundles.set(key, bundle);
    this.revisions.set(`${key}:${input.revisionId}`, bundle);
    return Promise.resolve(bundle);
  }

  findCurrent(input: Parameters<PromptResearchStore['findCurrent']>[0]) {
    return Promise.resolve(this.findCurrentNow(input));
  }

  findRevision(input: Parameters<PromptResearchStore['findRevision']>[0]) {
    return Promise.resolve(this.findRevisionNow(input));
  }

  /** Fake-runtime effect fence; reads the live aggregate without yielding. */
  findCurrentNow(input: Parameters<PromptResearchStore['findCurrent']>[0]): PromptBundle | null {
    return (
      this.bundles.get(
        this.key(input.context.tenantId, input.context.workspaceId, input.promptSetId),
      ) ?? null
    );
  }

  /** Fake-runtime effect fence; real aggregate state takes precedence over fixture fallback. */
  findRevisionNow(input: Parameters<PromptResearchStore['findRevision']>[0]): PromptBundle | null {
    const key = this.key(input.context.tenantId, input.context.workspaceId, input.promptSetId);
    const current = this.bundles.get(key);
    const historical = this.revisions.get(`${key}:${input.revisionId}`);
    if (current !== undefined) {
      if (historical === undefined) return null;
      return {
        ...historical,
        promptSet: { ...historical.promptSet, currentRevision: current.promptSet.currentRevision },
      };
    }
    if (
      input.promptSetId === FAKE_ARTIFACT_LINEAGE.promptSetId &&
      input.revisionId === FAKE_ARTIFACT_LINEAGE.promptRevisionId
    ) {
      return fakeArtifactPromptBundle({
        tenantId: input.context.tenantId,
        workspaceId: input.context.workspaceId,
        actorUserId: input.context.actorUserId,
      });
    }
    return null;
  }

  createRevision(input: Parameters<PromptResearchStore['createRevision']>[0]) {
    const key = this.key(input.context.tenantId, input.context.workspaceId, input.promptSetId);
    const current = this.bundles.get(key);
    if (current === undefined || current.revision.revision !== input.expectedRevision) {
      return Promise.resolve(null);
    }
    const revision = input.expectedRevision + 1;
    const registry = this.registry(input.scenario.providerKey, input.scenario.surfaceKey);
    const next: PromptBundle = {
      promptSet: { ...current.promptSet, currentRevision: revision },
      revision: {
        ...current.revision,
        id: input.revisionId,
        revision,
        prompts: input.prompts,
        scopes: input.scopes,
        contentHash: input.promptContentHash,
        status: 'DRAFT',
        createdByUserId: input.context.actorUserId,
        createdAt: input.createdAt.toISOString(),
      },
      scenario: {
        id: input.scenarioId,
        promptRevisionId: input.revisionId,
        version: revision,
        ...input.scenario,
        contentHash: input.scenarioContentHash,
        registryStatus: registry?.status ?? 'UNKNOWN',
        createdAt: input.createdAt.toISOString(),
      },
      approval: null,
      approvalCurrent: false,
      previousApprovalStale: current.approval !== null || current.previousApprovalStale,
    };
    this.bundles.set(key, next);
    this.revisions.set(`${key}:${input.revisionId}`, next);
    return Promise.resolve(next);
  }

  approveRevision(input: Parameters<PromptResearchStore['approveRevision']>[0]) {
    const key = this.key(input.context.tenantId, input.context.workspaceId, input.promptSetId);
    const current = this.bundles.get(key);
    if (current === undefined || current.revision.id !== input.revisionId) {
      return Promise.resolve({ outcome: 'NOT_FOUND' as const });
    }
    if (
      current.revision.contentHash !== input.expectedPromptHash ||
      current.scenario.contentHash !== input.expectedScenarioHash ||
      current.revision.status !== 'DRAFT'
    ) {
      return Promise.resolve({ outcome: 'HASH_MISMATCH' as const });
    }
    const issues = promptApprovalIssues({
      revision: current.revision,
      scenario: current.scenario,
      registry: this.registry(current.scenario.providerKey, current.scenario.surfaceKey),
    });
    if (issues.length > 0) {
      return Promise.resolve({ outcome: 'NOT_APPROVABLE' as const, issues });
    }
    const approval: PromptApprovalRecord = {
      id: input.approvalId,
      promptRevisionId: current.revision.id,
      scenarioId: current.scenario.id,
      promptContentHash: current.revision.contentHash,
      scenarioContentHash: current.scenario.contentHash,
      approvedByUserId: input.context.actorUserId,
      approvedAt: input.approvedAt.toISOString(),
    };
    const bundle: PromptBundle = {
      ...current,
      revision: { ...current.revision, status: 'APPROVED' },
      approval,
      approvalCurrent: true,
    };
    this.bundles.set(key, bundle);
    this.revisions.set(`${key}:${input.revisionId}`, bundle);
    return Promise.resolve({ outcome: 'SUCCEEDED' as const, bundle });
  }

  private registry(providerKey: string, surfaceKey: string) {
    return (
      REGISTRY.find(
        (entry) => entry.providerKey === providerKey && entry.surfaceKey === surfaceKey,
      ) ?? null
    );
  }

  private key(tenantId: string, workspaceId: string, promptSetId: string): string {
    return `${tenantId}:${workspaceId}:${promptSetId}`;
  }
}
