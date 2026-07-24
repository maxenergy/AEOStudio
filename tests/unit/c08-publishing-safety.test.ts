import { describe, expect, it } from 'vitest';
import {
  validateRollbackEligibility,
  validatePublicationCurrentness,
  validateCredentialSafety,
  type RollbackEligibilityInput,
  type PublicationCurrentnessInput,
  type CredentialSafetyInput,
} from '@aeostudio/domain/channels-publishing';

describe('C08: Publishing Production Safety', () => {
  describe('Rollback eligibility', () => {
    function makeRollbackInput(
      overrides: Partial<RollbackEligibilityInput> = {},
    ): RollbackEligibilityInput {
      return {
        publicationStatus: 'REMOTE_APPLIED',
        adapterCapabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK'],
        remoteRef: 'https://github.com/org/repo/pull/123',
        rollbackHandle: {
          operation: 'CLOSE_PULL_REQUEST',
          repository: 'org/repo',
          pullRequestNumber: 123,
        },
        actorRole: 'OWNER',
        ...overrides,
      };
    }

    it('accepts rollback for eligible publication', () => {
      const result = validateRollbackEligibility(makeRollbackInput());
      expect(result.eligible).toBe(true);
      expect(result.reasons).toEqual([]);
    });

    it('rejects rollback when adapter lacks ROLLBACK capability', () => {
      const result = validateRollbackEligibility(
        makeRollbackInput({ adapterCapabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE'] }),
      );
      expect(result.eligible).toBe(false);
      expect(result.reasons.some((r) => r.code === 'ROLLBACK_CAPABILITY_MISSING')).toBe(true);
    });

    it('rejects rollback when publication is not in rollback-eligible status', () => {
      const result = validateRollbackEligibility(
        makeRollbackInput({ publicationStatus: 'REQUESTED' }),
      );
      expect(result.eligible).toBe(false);
      expect(result.reasons.some((r) => r.code === 'STATUS_NOT_ROLLBACK_ELIGIBLE')).toBe(true);
    });

    it('rejects rollback when remoteRef is missing', () => {
      const result = validateRollbackEligibility(makeRollbackInput({ remoteRef: null }));
      expect(result.eligible).toBe(false);
      expect(result.reasons.some((r) => r.code === 'REMOTE_REF_MISSING')).toBe(true);
    });

    it('rejects rollback when rollbackHandle is missing', () => {
      const result = validateRollbackEligibility(makeRollbackInput({ rollbackHandle: null }));
      expect(result.eligible).toBe(false);
      expect(result.reasons.some((r) => r.code === 'ROLLBACK_HANDLE_MISSING')).toBe(true);
    });

    it('rejects rollback when actor lacks permission', () => {
      const result = validateRollbackEligibility(makeRollbackInput({ actorRole: 'VIEWER' }));
      expect(result.eligible).toBe(false);
      expect(result.reasons.some((r) => r.code === 'INSUFFICIENT_PERMISSION')).toBe(true);
    });
  });

  describe('Publication currentness fence', () => {
    function makeCurrentnessInput(
      overrides: Partial<PublicationCurrentnessInput> = {},
    ): PublicationCurrentnessInput {
      return {
        artifactRevisionId: '00000000-0000-7000-8000-000000000001',
        artifactContentHash: 'sha256:abc123',
        currentApprovedRevisionId: '00000000-0000-7000-8000-000000000001',
        currentApprovedContentHash: 'sha256:abc123',
        authorizationStatus: 'ACTIVE',
        authorizationValidUntil: '2027-01-01T00:00:00.000Z',
        claimRevisionIds: ['00000000-0000-7000-8000-000000000005'],
        currentApprovedClaimRevisionIds: ['00000000-0000-7000-8000-000000000005'],
        now: new Date('2026-07-25T00:00:00.000Z'),
        ...overrides,
      };
    }

    it('passes currentness check when all references are current', () => {
      const result = validatePublicationCurrentness(makeCurrentnessInput());
      expect(result.current).toBe(true);
      expect(result.fencedReasons).toEqual([]);
    });

    it('fences when artifact revision is stale', () => {
      const result = validatePublicationCurrentness(
        makeCurrentnessInput({
          artifactRevisionId: '00000000-0000-7000-8000-000000000099',
        }),
      );
      expect(result.current).toBe(false);
      expect(result.fencedReasons.some((r) => r.code === 'ARTIFACT_REVISION_STALE')).toBe(true);
    });

    it('fences when artifact content hash changed', () => {
      const result = validatePublicationCurrentness(
        makeCurrentnessInput({
          artifactContentHash: 'sha256:changed',
        }),
      );
      expect(result.current).toBe(false);
      expect(result.fencedReasons.some((r) => r.code === 'ARTIFACT_CONTENT_CHANGED')).toBe(true);
    });

    it('fences when authorization is revoked', () => {
      const result = validatePublicationCurrentness(
        makeCurrentnessInput({ authorizationStatus: 'REVOKED' }),
      );
      expect(result.current).toBe(false);
      expect(result.fencedReasons.some((r) => r.code === 'AUTHORIZATION_REVOKED')).toBe(true);
    });

    it('fences when authorization validation is expired', () => {
      const result = validatePublicationCurrentness(
        makeCurrentnessInput({
          authorizationValidUntil: '2026-01-01T00:00:00.000Z',
          now: new Date('2026-07-25T00:00:00.000Z'),
        }),
      );
      expect(result.current).toBe(false);
      expect(result.fencedReasons.some((r) => r.code === 'AUTHORIZATION_VALIDATION_EXPIRED')).toBe(
        true,
      );
    });

    it('fences when claim revision is no longer approved', () => {
      const result = validatePublicationCurrentness(
        makeCurrentnessInput({
          claimRevisionIds: ['00000000-0000-7000-8000-000000000099'],
          currentApprovedClaimRevisionIds: ['00000000-0000-7000-8000-000000000005'],
        }),
      );
      expect(result.current).toBe(false);
      expect(result.fencedReasons.some((r) => r.code === 'CLAIM_REVISION_STALE')).toBe(true);
    });
  });

  describe('Credential safety', () => {
    function makeCredentialInput(
      overrides: Partial<CredentialSafetyInput> = {},
    ): CredentialSafetyInput {
      return {
        secretValue: 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        responseFields: {
          id: '00000000-0000-7000-8000-000000000001',
          status: 'PUBLISHED',
          remoteRef: 'https://github.com/org/repo/pull/123',
        },
        logMessages: ['Publication succeeded', 'Remote ref: https://github.com/org/repo/pull/123'],
        auditEventPayload: { action: 'PUBLICATION_APPLIED', resourceId: 'pub-123' },
        ...overrides,
      };
    }

    it('passes when credential does not appear in any output', () => {
      const result = validateCredentialSafety(makeCredentialInput());
      expect(result.safe).toBe(true);
      expect(result.leaks).toEqual([]);
    });

    it('detects credential leak in response fields', () => {
      const result = validateCredentialSafety(
        makeCredentialInput({
          responseFields: {
            id: '00000000-0000-7000-8000-000000000001',
            token: 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
          },
        }),
      );
      expect(result.safe).toBe(false);
      expect(result.leaks.some((l) => l.location === 'responseFields')).toBe(true);
    });

    it('detects credential leak in log messages', () => {
      const result = validateCredentialSafety(
        makeCredentialInput({
          logMessages: ['Using token ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx for auth'],
        }),
      );
      expect(result.safe).toBe(false);
      expect(result.leaks.some((l) => l.location === 'logMessages')).toBe(true);
    });

    it('detects credential leak in audit event payload', () => {
      const result = validateCredentialSafety(
        makeCredentialInput({
          auditEventPayload: {
            action: 'PUBLICATION_APPLIED',
            secret: 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
          },
        }),
      );
      expect(result.safe).toBe(false);
      expect(result.leaks.some((l) => l.location === 'auditEventPayload')).toBe(true);
    });

    it('detects partial credential match', () => {
      const result = validateCredentialSafety(
        makeCredentialInput({
          logMessages: ['Token prefix: ghp_xxxxxxxxxxxx'],
        }),
      );
      expect(result.safe).toBe(false);
    });
  });

  describe('Determinism', () => {
    it('same rollback input produces same result', () => {
      const input: RollbackEligibilityInput = {
        publicationStatus: 'REMOTE_APPLIED',
        adapterCapabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK'],
        remoteRef: 'https://github.com/org/repo/pull/123',
        rollbackHandle: { operation: 'CLOSE_PULL_REQUEST' },
        actorRole: 'OWNER',
      };
      const result1 = validateRollbackEligibility(input);
      const result2 = validateRollbackEligibility(input);
      expect(result1).toEqual(result2);
    });

    it('same currentness input produces same result', () => {
      const input: PublicationCurrentnessInput = {
        artifactRevisionId: '00000000-0000-7000-8000-000000000001',
        artifactContentHash: 'sha256:abc123',
        currentApprovedRevisionId: '00000000-0000-7000-8000-000000000001',
        currentApprovedContentHash: 'sha256:abc123',
        authorizationStatus: 'ACTIVE',
        authorizationValidUntil: '2027-01-01T00:00:00.000Z',
        claimRevisionIds: [],
        currentApprovedClaimRevisionIds: [],
        now: new Date('2026-07-25T00:00:00.000Z'),
      };
      const result1 = validatePublicationCurrentness(input);
      const result2 = validatePublicationCurrentness(input);
      expect(result1).toEqual(result2);
    });
  });
});
