export interface AudiencePersonaContent {
  name: string;
  role: string;
  industry: string;
  region: string;
  goals: string[];
  painPoints: string[];
  questions: string[];
  objections: string[];
  decisionCriteria: string[];
  channels: string[];
  journeyStages: string[];
}

export interface AudiencePersonaRevision extends AudiencePersonaContent {
  id: string;
  tenantId: string;
  workspaceId: string;
  revision: number;
  contentHash: string;
}
