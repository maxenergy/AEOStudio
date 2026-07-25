export interface CompetitorSetContent {
  competitorName: string;
  website: string;
  matchedOfferingIds: string[];
  positioning: string;
  comparisonDimensions: string[];
  evidenceSourceIds: string[];
  allowedComparisons: string[];
  prohibitedComparisons: string[];
}

export interface CompetitorSetRevision extends CompetitorSetContent {
  id: string;
  tenantId: string;
  workspaceId: string;
  revision: number;
  contentHash: string;
}
