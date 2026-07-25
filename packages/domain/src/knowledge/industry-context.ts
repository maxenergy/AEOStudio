export interface IndustryContextContent {
  industryLabels: string[];
  subIndustryLabels: string[];
  taxonomyRefs: string[];
  synonyms: string[];
  commonTerms: string[];
  commonQuestions: string[];
  regulations: string[];
  prohibitedClaims: string[];
  seasonality: string[];
  authoritativeSources: string[];
}

export interface IndustryContextRevision extends IndustryContextContent {
  id: string;
  tenantId: string;
  workspaceId: string;
  revision: number;
  contentHash: string;
}
