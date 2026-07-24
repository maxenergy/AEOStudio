export const TENANT_ROLES = [
  'OWNER',
  'ADMIN',
  'EDITOR',
  'REVIEWER',
  'PUBLISHER',
  'ANALYST',
  'VIEWER',
] as const;

export type TenantRole = (typeof TENANT_ROLES)[number];

export const MEMBERSHIP_STATUSES = ['PENDING', 'ACTIVE', 'REVOKED'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];
