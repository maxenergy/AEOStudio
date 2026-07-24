export function auditTimelineNavigation(input: {
  tenantId: string;
  workspaceId: string;
  currentCursor: string | undefined;
  nextCursor: string | null | undefined;
}): { latestHref: string | null; nextHref: string | null } {
  const base = new URLSearchParams({ tenant: input.tenantId, workspace: input.workspaceId });
  const latestHref = input.currentCursor === undefined ? null : `/app/privacy?${base.toString()}`;
  if (input.nextCursor === null || input.nextCursor === undefined) {
    return { latestHref, nextHref: null };
  }
  const next = new URLSearchParams(base);
  next.set('auditCursor', input.nextCursor);
  return { latestHref, nextHref: `/app/privacy?${next.toString()}` };
}
