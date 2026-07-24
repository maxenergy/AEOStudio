import * as DomainRuntime from '@aeostudio/domain';
import { describe, expect, test } from 'vitest';

type RetainedObjectClass =
  | 'ACTIVE_TENANT_DATA'
  | 'BACKUP_COPY'
  | 'RAW_PROMPT_RESPONSE'
  | 'CRAWL_SNAPSHOT'
  | 'SCREENSHOT'
  | 'APPLICATION_LOG'
  | 'AUDIT_DIGEST';

interface RetainedObject {
  objectKey: string;
  objectVersionId: string;
}

interface LegalHold {
  id: string;
  name: string;
  reason: string;
  createdBy: string;
  visibleToTenant: true;
  target: RetainedObject;
}

interface RetentionDecision {
  decision: 'RETAIN' | 'EXPIRE' | 'LEGAL_HOLD' | 'INVALID_TIMELINE';
  retained: boolean;
  deletionAllowed: boolean;
  policyDays: number;
  expiresAt: string | null;
  legalHold: LegalHold | null;
}

interface SecretLifecycleDecision {
  state: 'REVOKED_PENDING_FORCE_DELETE' | 'FORCE_DELETED' | 'INVALID_TIMELINE';
  readable: false;
  revokedAt: string | null;
  forceDeleteAt: string | null;
}

interface BreakGlassGrant {
  id: string;
  tenantId: string;
  workspaceId: string;
  operatorId: string;
  operatorName: string;
  reason: string;
  auditEventId: string;
  requestedAction: string;
  resourceType: string;
  resourceId: string;
  grantedAt: string;
  expiresAt: string;
  revokedAt?: string;
}

interface BreakGlassDecision {
  decision: 'ALLOW' | 'DENY';
  state: 'ACTIVE' | 'NOT_YET_ACTIVE' | 'EXPIRED' | 'REVOKED' | 'INVALID_GRANT';
  grantId: string | null;
  operatorName: string | null;
  reason: string | null;
  auditEventId: string | null;
}

interface PrivacyLifecyclePolicy {
  evaluateRetention(input: {
    objectClass: RetainedObjectClass;
    object: RetainedObject;
    createdAt: string;
    legalHolds?: readonly LegalHold[];
  }): RetentionDecision;
  evaluateSecretLifecycle(input: { secretId: string; revokedAt: string }): SecretLifecycleDecision;
  evaluateBreakGlassAccess(input: {
    grant: Partial<BreakGlassGrant>;
    workspaceId: string;
    requestedAction: string;
    resourceType: string;
    resourceId: string;
  }): BreakGlassDecision;
}

type CreatePrivacyLifecyclePolicy = (input: { clock: { now(): Date } }) => PrivacyLifecyclePolicy;

const privacyDomain = DomainRuntime as unknown as {
  createPrivacyLifecyclePolicy?: CreatePrivacyLifecyclePolicy;
};
const policyApiMissing = privacyDomain.createPrivacyLifecyclePolicy === undefined;

const DAY_MS = 24 * 60 * 60 * 1_000;

const retentionCases: ReadonlyArray<{
  objectClass: RetainedObjectClass;
  days: number;
}> = [
  { objectClass: 'ACTIVE_TENANT_DATA', days: 30 },
  { objectClass: 'BACKUP_COPY', days: 90 },
  { objectClass: 'RAW_PROMPT_RESPONSE', days: 180 },
  { objectClass: 'CRAWL_SNAPSHOT', days: 180 },
  { objectClass: 'SCREENSHOT', days: 90 },
  { objectClass: 'APPLICATION_LOG', days: 30 },
  { objectClass: 'AUDIT_DIGEST', days: 365 },
];

describe('Task 17 retention and privileged-access clock properties', () => {
  test('exports the public privacy lifecycle policy tracer', () => {
    expect(
      privacyDomain.createPrivacyLifecyclePolicy,
      'expected object expired at retention boundary; public createPrivacyLifecyclePolicy API unavailable',
    ).toBeTypeOf('function');
  });

  test.skipIf(policyApiMissing)(
    'retains every object immediately before its policy boundary and expires it exactly at the boundary',
    () => {
      const anchors = [
        '2024-02-29T12:34:56.789Z',
        '2026-07-22T00:00:00.000Z',
        '2030-12-31T23:59:59.999Z',
      ];

      for (const [caseIndex, retentionCase] of retentionCases.entries()) {
        for (const [anchorIndex, createdAt] of anchors.entries()) {
          const boundaryMs = Date.parse(createdAt) + retentionCase.days * DAY_MS;
          const clock = new FakeClock(new Date(boundaryMs - 1));
          const policy = createPolicy(clock);
          const input = {
            objectClass: retentionCase.objectClass,
            object: object(caseIndex * 10 + anchorIndex),
            createdAt,
          } as const;

          expect(
            policy.evaluateRetention(input),
            `${retentionCase.objectClass} must remain retained immediately before its boundary`,
          ).toMatchObject({
            decision: 'RETAIN',
            retained: true,
            deletionAllowed: false,
            policyDays: retentionCase.days,
            expiresAt: new Date(boundaryMs).toISOString(),
            legalHold: null,
          });

          clock.set(new Date(boundaryMs));
          expect(
            policy.evaluateRetention(input),
            `expected object expired at retention boundary for ${retentionCase.objectClass}`,
          ).toMatchObject({
            decision: 'EXPIRE',
            retained: false,
            deletionAllowed: true,
            policyDays: retentionCase.days,
            expiresAt: new Date(boundaryMs).toISOString(),
            legalHold: null,
          });
        }
      }
    },
  );

  test.skipIf(policyApiMissing)(
    'applies a named tenant-visible legal hold only to the exact object version it targets',
    () => {
      const createdAt = '2026-01-01T00:00:00.000Z';
      const clock = new FakeClock(new Date('2027-01-02T00:00:00.000Z'));
      const policy = createPolicy(clock);
      const heldObject = object(101);
      const siblingVersion = { ...heldObject, objectVersionId: id(102) };
      const hold: LegalHold = {
        id: id(103),
        name: 'Regulator preservation request 2026-07',
        reason: 'Preserve the exact submitted evidence version while the request is reviewed.',
        createdBy: id(104),
        visibleToTenant: true,
        target: heldObject,
      };

      expect(
        policy.evaluateRetention({
          objectClass: 'RAW_PROMPT_RESPONSE',
          object: heldObject,
          createdAt,
          legalHolds: [hold],
        }),
      ).toMatchObject({
        decision: 'LEGAL_HOLD',
        retained: true,
        deletionAllowed: false,
        policyDays: 180,
        legalHold: hold,
      });

      for (const input of [
        {
          objectClass: 'RAW_PROMPT_RESPONSE' as const,
          object: siblingVersion,
          createdAt,
          legalHolds: [hold],
        },
        {
          objectClass: 'APPLICATION_LOG' as const,
          object: object(105),
          createdAt,
          legalHolds: [hold],
        },
      ]) {
        expect(
          policy.evaluateRetention(input),
          'a legal hold must not expand to sibling versions or unrelated data',
        ).toMatchObject({
          decision: 'EXPIRE',
          retained: false,
          deletionAllowed: true,
          legalHold: null,
        });
      }
    },
  );

  test.skipIf(policyApiMissing)(
    'revokes a secret immediately and marks it force-deleted and unreadable at the 24-hour boundary',
    () => {
      const revokedAt = '2026-07-22T01:02:03.456Z';
      const forceDeleteAtMs = Date.parse(revokedAt) + DAY_MS;
      const clock = new FakeClock(new Date(revokedAt));
      const policy = createPolicy(clock);
      const input = { secretId: id(201), revokedAt };

      expect(policy.evaluateSecretLifecycle(input)).toEqual({
        state: 'REVOKED_PENDING_FORCE_DELETE',
        readable: false,
        revokedAt,
        forceDeleteAt: new Date(forceDeleteAtMs).toISOString(),
      });

      clock.set(new Date(forceDeleteAtMs - 1));
      expect(policy.evaluateSecretLifecycle(input)).toMatchObject({
        state: 'REVOKED_PENDING_FORCE_DELETE',
        readable: false,
      });

      clock.set(new Date(forceDeleteAtMs));
      expect(policy.evaluateSecretLifecycle(input)).toEqual({
        state: 'FORCE_DELETED',
        readable: false,
        revokedAt,
        forceDeleteAt: new Date(forceDeleteAtMs).toISOString(),
      });
    },
  );

  test.skipIf(policyApiMissing)(
    'allows a named audited break-glass grant immediately and denies it exactly at expiry',
    () => {
      const grantedAt = '2026-07-22T10:00:00.000Z';
      const expiresAt = '2026-07-22T10:15:00.000Z';
      const clock = new FakeClock(new Date(grantedAt));
      const policy = createPolicy(clock);
      const grant: BreakGlassGrant = {
        id: id(301),
        tenantId: id(302),
        workspaceId: id(305),
        operatorId: id(303),
        operatorName: 'Named Platform Operator',
        reason: 'Investigate the tenant-approved incident ticket INC-1701.',
        auditEventId: id(304),
        requestedAction: 'READ_SENSITIVE_EVIDENCE',
        resourceType: 'AUDIT_EVIDENCE',
        resourceId: id(306),
        grantedAt,
        expiresAt,
      };

      const access = {
        grant,
        workspaceId: grant.workspaceId,
        requestedAction: grant.requestedAction,
        resourceType: grant.resourceType,
        resourceId: grant.resourceId,
      };
      expect(policy.evaluateBreakGlassAccess(access)).toEqual({
        decision: 'ALLOW',
        state: 'ACTIVE',
        grantId: grant.id,
        operatorName: grant.operatorName,
        reason: grant.reason,
        auditEventId: grant.auditEventId,
      });

      clock.set(new Date(Date.parse(expiresAt) - 1));
      expect(policy.evaluateBreakGlassAccess(access)).toMatchObject({
        decision: 'ALLOW',
        state: 'ACTIVE',
      });

      clock.set(new Date(expiresAt));
      expect(policy.evaluateBreakGlassAccess(access)).toMatchObject({
        decision: 'DENY',
        state: 'EXPIRED',
        grantId: grant.id,
        operatorName: grant.operatorName,
        reason: grant.reason,
        auditEventId: grant.auditEventId,
      });
      expect(policy.evaluateBreakGlassAccess({ ...access, resourceId: id(399) })).toMatchObject({
        decision: 'DENY',
        state: 'INVALID_GRANT',
      });
    },
  );

  test.skipIf(policyApiMissing)(
    'denies revoked, unnamed, unexplained, unaudited, not-yet-active and invalid-order break-glass grants',
    () => {
      const grantedAt = '2026-07-22T10:00:00.000Z';
      const expiresAt = '2026-07-22T10:15:00.000Z';
      const clock = new FakeClock(new Date('2026-07-22T10:05:00.000Z'));
      const policy = createPolicy(clock);
      const valid: BreakGlassGrant = {
        id: id(401),
        tenantId: id(402),
        workspaceId: id(405),
        operatorId: id(403),
        operatorName: 'Named Platform Operator',
        reason: 'Investigate tenant-approved incident INC-1702.',
        auditEventId: id(404),
        requestedAction: 'READ_SENSITIVE_EVIDENCE',
        resourceType: 'AUDIT_EVIDENCE',
        resourceId: id(406),
        grantedAt,
        expiresAt,
      };
      const access = {
        workspaceId: valid.workspaceId,
        requestedAction: valid.requestedAction,
        resourceType: valid.resourceType,
        resourceId: valid.resourceId,
      };

      const invalidGrants: Array<Partial<BreakGlassGrant>> = [
        { ...valid, operatorName: '' },
        { ...valid, reason: '   ' },
        { ...valid, auditEventId: '' },
        { ...valid, expiresAt: grantedAt },
        { ...valid, expiresAt: 'not-a-date' },
      ];
      for (const grant of invalidGrants) {
        expect(policy.evaluateBreakGlassAccess({ grant, ...access })).toMatchObject({
          decision: 'DENY',
          state: 'INVALID_GRANT',
        });
      }

      expect(
        policy.evaluateBreakGlassAccess({
          grant: { ...valid, revokedAt: '2026-07-22T10:04:00.000Z' },
          ...access,
        }),
      ).toMatchObject({ decision: 'DENY', state: 'REVOKED' });

      clock.set(new Date('2026-07-22T09:59:59.999Z'));
      expect(policy.evaluateBreakGlassAccess({ grant: valid, ...access })).toMatchObject({
        decision: 'DENY',
        state: 'NOT_YET_ACTIVE',
      });
    },
  );

  test.skipIf(policyApiMissing)(
    'fails closed for invalid clocks and negative lifecycle ordering',
    () => {
      const invalidClock = new FakeClock(new Date(Number.NaN));
      const invalidClockPolicy = createPolicy(invalidClock);

      expect(
        invalidClockPolicy.evaluateRetention({
          objectClass: 'APPLICATION_LOG',
          object: object(501),
          createdAt: '2026-07-22T00:00:00.000Z',
        }),
      ).toMatchObject({
        decision: 'INVALID_TIMELINE',
        retained: true,
        deletionAllowed: false,
      });
      expect(
        invalidClockPolicy.evaluateSecretLifecycle({
          secretId: id(502),
          revokedAt: '2026-07-22T00:00:00.000Z',
        }),
      ).toMatchObject({
        state: 'INVALID_TIMELINE',
        readable: false,
      });
      expect(
        invalidClockPolicy.evaluateBreakGlassAccess({
          grant: {
            id: id(503),
            tenantId: id(504),
            workspaceId: id(507),
            operatorId: id(505),
            operatorName: 'Named Operator',
            reason: 'Tenant-approved incident.',
            auditEventId: id(506),
            requestedAction: 'READ_SENSITIVE_EVIDENCE',
            resourceType: 'AUDIT_EVIDENCE',
            resourceId: id(508),
            grantedAt: '2026-07-22T00:00:00.000Z',
            expiresAt: '2026-07-22T00:15:00.000Z',
          },
          workspaceId: id(507),
          requestedAction: 'READ_SENSITIVE_EVIDENCE',
          resourceType: 'AUDIT_EVIDENCE',
          resourceId: id(508),
        }),
      ).toMatchObject({ decision: 'DENY', state: 'INVALID_GRANT' });

      const clock = new FakeClock(new Date('2026-07-22T00:00:00.000Z'));
      const policy = createPolicy(clock);
      expect(
        policy.evaluateRetention({
          objectClass: 'APPLICATION_LOG',
          object: object(507),
          createdAt: '2026-07-22T00:00:00.001Z',
        }),
      ).toMatchObject({
        decision: 'INVALID_TIMELINE',
        retained: true,
        deletionAllowed: false,
      });
      expect(
        policy.evaluateSecretLifecycle({
          secretId: id(508),
          revokedAt: '2026-07-22T00:00:00.001Z',
        }),
      ).toMatchObject({
        state: 'INVALID_TIMELINE',
        readable: false,
      });
    },
  );
});

class FakeClock {
  public constructor(private current: Date) {}

  public now(): Date {
    return new Date(this.current.getTime());
  }

  public set(value: Date): void {
    this.current = value;
  }
}

function createPolicy(clock: FakeClock): PrivacyLifecyclePolicy {
  const createPrivacyLifecyclePolicy = privacyDomain.createPrivacyLifecyclePolicy;
  if (createPrivacyLifecyclePolicy === undefined) {
    throw new Error('PRIVACY_LIFECYCLE_POLICY_API_UNAVAILABLE');
  }
  return createPrivacyLifecyclePolicy({ clock });
}

function object(suffix: number): RetainedObject {
  return {
    objectKey: `tenants/fixture/evidence/object-${suffix}.json`,
    objectVersionId: id(suffix),
  };
}

function id(suffix: number): string {
  return `00000000-0000-7000-8000-${String(suffix).padStart(12, '0')}`;
}
