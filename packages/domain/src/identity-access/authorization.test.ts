import { describe, expect, test } from 'vitest';

import { approvalAllowed, roleAllows } from './authorization.js';

describe('fixed Tenant role policy', () => {
  test('each role is limited to its explicit action set', () => {
    expect(roleAllows('OWNER', 'MEMBERSHIP_INVITE')).toBe(true);
    expect(roleAllows('OWNER', 'MEMBERSHIP_ROLE_CHANGE')).toBe(true);
    expect(roleAllows('OWNER', 'MEMBERSHIP_REVOKE')).toBe(true);
    expect(roleAllows('ADMIN', 'CONTENT_EDIT')).toBe(true);
    expect(roleAllows('ADMIN', 'CHANNEL_AUTHORIZATION_MANAGE')).toBe(true);
    expect(roleAllows('ADMIN', 'MEMBERSHIP_INVITE')).toBe(false);
    expect(roleAllows('EDITOR', 'CONTENT_EDIT')).toBe(true);
    expect(roleAllows('EDITOR', 'CHANNEL_AUTHORIZATION_MANAGE')).toBe(false);
    expect(roleAllows('EDITOR', 'CLAIM_APPROVE')).toBe(false);
    expect(roleAllows('REVIEWER', 'CLAIM_APPROVE')).toBe(true);
    expect(roleAllows('REVIEWER', 'MEASUREMENT_IMPORT_APPROVE')).toBe(true);
    expect(roleAllows('REVIEWER', 'BRIEF_APPROVE')).toBe(true);
    expect(roleAllows('REVIEWER', 'PUBLISH')).toBe(false);
    expect(roleAllows('REVIEWER', 'CHANNEL_AUTHORIZATION_MANAGE')).toBe(false);
    expect(roleAllows('PUBLISHER', 'PUBLISH')).toBe(true);
    expect(roleAllows('PUBLISHER', 'CHANNEL_AUTHORIZATION_MANAGE')).toBe(false);
    expect(roleAllows('PUBLISHER', 'ARTIFACT_APPROVE')).toBe(false);
    expect(roleAllows('ANALYST', 'MEASUREMENT_RUN')).toBe(true);
    expect(roleAllows('ANALYST', 'MEASUREMENT_IMPORT_APPROVE')).toBe(false);
    expect(roleAllows('ANALYST', 'CONTENT_EDIT')).toBe(false);
    expect(roleAllows('VIEWER', 'WORKSPACE_READ')).toBe(true);
    expect(roleAllows('VIEWER', 'CONTENT_EDIT')).toBe(false);
  });

  test('Agent and same-actor approval are denied independently of UI controls', () => {
    expect(
      approvalAllowed({
        actorKind: 'AGENT',
        actorId: 'reviewer-user',
        creatorActorId: 'editor-user',
        role: 'REVIEWER',
        action: 'CLAIM_APPROVE',
      }),
    ).toBe(false);
    expect(
      approvalAllowed({
        actorKind: 'USER',
        actorId: 'same-user',
        creatorActorId: 'same-user',
        role: 'REVIEWER',
        action: 'ARTIFACT_APPROVE',
      }),
    ).toBe(false);
    expect(
      approvalAllowed({
        actorKind: 'USER',
        actorId: 'reviewer-user',
        creatorActorId: 'editor-user',
        role: 'REVIEWER',
        action: 'CLAIM_APPROVE',
      }),
    ).toBe(true);
  });
});
