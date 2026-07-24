import type { TenantRole } from './roles.js';

export const IDENTITY_ACTIONS = [
  'TENANT_MANAGE',
  'CHANNEL_AUTHORIZATION_MANAGE',
  'WORKSPACE_READ',
  'MEMBERSHIP_INVITE',
  'MEMBERSHIP_ROLE_CHANGE',
  'MEMBERSHIP_REVOKE',
  'CONTENT_EDIT',
  'BRIEF_APPROVE',
  'CLAIM_APPROVE',
  'ARTIFACT_APPROVE',
  'PUBLISH',
  'MEASUREMENT_RUN',
  'MEASUREMENT_IMPORT_APPROVE',
] as const;

export type IdentityAction = (typeof IDENTITY_ACTIONS)[number];

const ALLOWED_ACTIONS: Readonly<Record<TenantRole, ReadonlySet<IdentityAction>>> = {
  OWNER: new Set(IDENTITY_ACTIONS),
  ADMIN: new Set([
    'WORKSPACE_READ',
    'CHANNEL_AUTHORIZATION_MANAGE',
    'CONTENT_EDIT',
    'MEASUREMENT_RUN',
  ]),
  EDITOR: new Set(['WORKSPACE_READ', 'CONTENT_EDIT']),
  REVIEWER: new Set([
    'WORKSPACE_READ',
    'BRIEF_APPROVE',
    'CLAIM_APPROVE',
    'ARTIFACT_APPROVE',
    'MEASUREMENT_IMPORT_APPROVE',
  ]),
  PUBLISHER: new Set(['WORKSPACE_READ', 'PUBLISH']),
  ANALYST: new Set(['WORKSPACE_READ', 'MEASUREMENT_RUN']),
  VIEWER: new Set(['WORKSPACE_READ']),
};

export function roleAllows(role: TenantRole, action: IdentityAction): boolean {
  return ALLOWED_ACTIONS[role].has(action);
}

export function approvalAllowed(input: {
  actorKind: 'USER' | 'AGENT';
  actorId: string;
  creatorActorId: string;
  role: TenantRole;
  action: 'BRIEF_APPROVE' | 'CLAIM_APPROVE' | 'ARTIFACT_APPROVE';
}): boolean {
  return (
    input.actorKind === 'USER' &&
    input.actorId !== input.creatorActorId &&
    roleAllows(input.role, input.action)
  );
}
