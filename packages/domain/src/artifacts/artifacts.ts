export type ArtifactType = 'DEFINITION_PRODUCT' | 'COMPARISON' | 'TECHNICAL_EVIDENCE';
export type ArtifactStatus = 'PENDING' | 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED' | 'STALE';

export interface ArtifactRecord {
  id: string;
  tenantId: string;
  workspaceId: string;
  briefId: string;
  type: ArtifactType;
  revision: number;
  status: ArtifactStatus;
  locale: string;
  market: string;
  methodPolicyVersion: string;
  jobId: string | null;
  createdByUserId: string;
  createdAt: string;
}

export interface ArtifactEvidenceBinding {
  sourceId: string;
  snapshotId: string;
  sourceHash: string;
}

export interface ArtifactClaimBinding {
  claimId: string;
  claimRevisionId: string;
  claimContentHash: string;
  claimStatement: string;
  evidence: ArtifactEvidenceBinding[];
}

export type ArtifactSourceReferenceKind =
  'PROFILE_REVISION' | 'OFFERING_REVISION' | 'PROMPT_REVISION' | 'SITE_BASELINE';

export interface ArtifactSourceReference {
  kind: ArtifactSourceReferenceKind;
  id: string;
  aggregateId: string;
  revision: number | null;
  contentHash: string | null;
}

export interface ArtifactLineage {
  contentPlanId: string;
  brief: { id: string; contentHash: string };
  prompt: {
    promptSetId: string;
    promptRevisionId: string;
    contentHash: string;
    promptIds: string[];
  };
  sourceReferences: ArtifactSourceReference[];
}

export interface ArtifactWriterContext {
  schemaVersion: '1.0.0';
  type: ArtifactType;
  locale: string;
  market: string;
  methodPolicyVersion: string;
  brief: {
    id: string;
    contentHash: string;
    title: string;
    promptIds: string[];
    sourceArtifactIds: string[];
    lineage: ArtifactLineage;
  };
  claims: {
    claimId: string;
    revisionId: string;
    contentHash: string;
    statement: string;
    conditions: Record<string, unknown>;
    evidence: ArtifactEvidenceBinding[];
  }[];
}

export interface ArtifactPayload {
  title: string;
  summary: string;
  sections: { heading: string; body: string }[];
  claimMap: {
    claimRevisionId: string;
    statement: string;
    evidenceSourceIds: string[];
  }[];
  disclosure: string;
}

export interface ArtifactRevisionRecord {
  id: string;
  artifactId: string;
  revision: number;
  briefId: string;
  type: ArtifactType;
  schemaVersion: '1.0.0';
  contentHash: string;
  status: Exclude<ArtifactStatus, 'PENDING'>;
  locale: string;
  market: string;
  sourceArtifactIds: string[];
  lineage: ArtifactLineage;
  claimBindings: ArtifactClaimBinding[];
  methodPolicyVersion: string;
  createdByActor: { kind: 'USER' | 'AGENT'; id: string };
  createdAt: string;
  payloadObjectRef: string;
}

export interface ArtifactReviewRecord {
  id: string;
  artifactId: string;
  artifactRevisionId: string;
  revision: number;
  contentHash: string;
  decision: 'APPROVE' | 'REJECT';
  reviewerUserId: string;
  note: string;
  createdAt: string;
}

export type ArtifactApprovalState = 'ELIGIBLE' | 'APPROVAL_REQUIRED' | 'APPROVAL_STALE';

export interface ArtifactLedgerBundle {
  artifact: ArtifactRecord;
  revision: ArtifactRevisionRecord | null;
  revisions: ArtifactRevisionRecord[];
  reviews: ArtifactReviewRecord[];
  approvalState: ArtifactApprovalState;
  selectableApprovedRevisions: { revision: number; contentHash: string }[];
}

export interface ArtifactBundle extends ArtifactLedgerBundle {
  payload: ArtifactPayload | null;
  previousPayload: ArtifactPayload | null;
}

// ============================================================================
// C07: Post-generation output validation
// ============================================================================

export type ArtifactOutputValidationCode =
  | 'UNMAPPED_CLAIM'
  | 'EMPTY_CLAIM_MAP'
  | 'FORBIDDEN_GUARANTEE'
  | 'UNSUPPORTED_NUMERIC'
  | 'MISSING_REQUIRED_FIELD'
  | 'MISSING_DISCLOSURE'
  | 'COMPARISON_EVIDENCE_NOT_INDEPENDENT';

export interface ArtifactOutputValidationIssue {
  code: ArtifactOutputValidationCode;
  path: string;
  message: string;
}

export interface ArtifactOutputValidationInput {
  payload: ArtifactPayload;
  approvedClaimRevisionIds: string[];
  approvedEvidenceSnapshotIds: string[];
  artifactType: ArtifactType;
  comparisonEvidenceIndependent?: boolean;
}

const ARTIFACT_FORBIDDEN_PATTERNS = [
  /\bguarantee[sd]?\b/i,
  /\brank(?:ed|ing)?\s*#?\s*1\b/i,
  /\bwill\s+(?:definitely|certainly|absolutely)\b/i,
  /\bpromise[sd]?\s+(?:to|that)\b/i,
  /\b\d+%\s+(?:increase|improvement|growth)\s+in\s+(?:traffic|revenue|conversion|sales)\b/i,
];

const NUMERIC_PATTERN_SOURCE = '\\d+(?:\\.\\d+)?%';

function extractNumerics(text: string): string[] {
  const pattern = new RegExp(NUMERIC_PATTERN_SOURCE, 'g');
  return text.match(pattern) ?? [];
}

export function validateArtifactOutput(
  input: ArtifactOutputValidationInput,
): ArtifactOutputValidationIssue[] {
  const issues: ArtifactOutputValidationIssue[] = [];
  const { payload } = input;

  // Structural validation
  if (payload.title.trim().length === 0) {
    issues.push({ code: 'MISSING_REQUIRED_FIELD', path: 'title', message: 'Title is required.' });
  }
  if (payload.summary.trim().length === 0) {
    issues.push({
      code: 'MISSING_REQUIRED_FIELD',
      path: 'summary',
      message: 'Summary is required.',
    });
  }
  if (payload.sections.length === 0) {
    issues.push({
      code: 'MISSING_REQUIRED_FIELD',
      path: 'sections',
      message: 'At least one section is required.',
    });
  }
  if (payload.disclosure.trim().length === 0) {
    issues.push({
      code: 'MISSING_DISCLOSURE',
      path: 'disclosure',
      message: 'Disclosure statement is required.',
    });
  }

  // Claim map validation
  if (payload.claimMap.length === 0) {
    issues.push({
      code: 'EMPTY_CLAIM_MAP',
      path: 'claimMap',
      message: 'Artifact must reference at least one approved Claim.',
    });
  }
  const approvedClaims = new Set(input.approvedClaimRevisionIds);
  for (let i = 0; i < payload.claimMap.length; i++) {
    const binding = payload.claimMap[i]!;
    if (!approvedClaims.has(binding.claimRevisionId)) {
      issues.push({
        code: 'UNMAPPED_CLAIM',
        path: `claimMap.${i}.claimRevisionId`,
        message: `Claim revision ${binding.claimRevisionId} is not in the approved set.`,
      });
    }
  }

  // Forbidden guarantee language
  const allText = [
    payload.title,
    payload.summary,
    ...payload.sections.map((s) => `${s.heading} ${s.body}`),
  ].join(' ');
  for (const pattern of ARTIFACT_FORBIDDEN_PATTERNS) {
    if (pattern.test(allText)) {
      issues.push({
        code: 'FORBIDDEN_GUARANTEE',
        path: 'content',
        message: 'Content contains forbidden guarantee, ranking, or promise language.',
      });
      break;
    }
  }

  // Unsupported numeric claims (hallucination detection)
  const claimStatements = payload.claimMap.map((c) => c.statement).join(' ');
  const contentNumerics = extractNumerics(allText);
  for (const numeric of contentNumerics) {
    if (!claimStatements.includes(numeric)) {
      issues.push({
        code: 'UNSUPPORTED_NUMERIC',
        path: 'content',
        message: `Numeric value "${numeric}" in content is not supported by any approved Claim.`,
      });
      break;
    }
  }

  // Comparison balance
  if (input.artifactType === 'COMPARISON' && input.comparisonEvidenceIndependent === false) {
    issues.push({
      code: 'COMPARISON_EVIDENCE_NOT_INDEPENDENT',
      path: 'comparison',
      message: 'Comparison artifacts require independently sourced evidence.',
    });
  }

  return issues;
}
