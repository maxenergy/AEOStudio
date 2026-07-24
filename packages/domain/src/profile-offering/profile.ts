export interface DigitalAssetInput {
  label: string;
  url: string;
}

export interface TargetMarketInput {
  locale: string;
  market: string;
}

export interface ProfileContent {
  displayName: string;
  description?: string | undefined;
  digitalAssets: DigitalAssetInput[];
  targetMarkets: TargetMarketInput[];
}

export interface CompletenessSummary {
  completedFields: number;
  totalFields: number;
  percent: number;
  missingFields: string[];
}

export interface ProfileRevision extends ProfileContent {
  id: string;
  profileId: string;
  tenantId: string;
  workspaceId: string;
  revision: number;
  contentHash: string;
  completeness: CompletenessSummary;
}

export function profileCompleteness(content: ProfileContent): CompletenessSummary {
  const checks = [
    ['displayName', content.displayName.trim().length > 0],
    ['description', (content.description?.trim().length ?? 0) > 0],
    ['digitalAssets', content.digitalAssets.length > 0],
    ['targetMarkets', content.targetMarkets.length > 0],
  ] as const;
  const missingFields = checks.filter(([, complete]) => !complete).map(([field]) => field);
  const completedFields = checks.length - missingFields.length;
  return {
    completedFields,
    totalFields: checks.length,
    percent: Math.round((completedFields / checks.length) * 100),
    missingFields,
  };
}
