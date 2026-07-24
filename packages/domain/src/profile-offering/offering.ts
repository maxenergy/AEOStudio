import type { CompletenessSummary } from './profile.js';

interface DynamicAttributeBase {
  key: string;
  label: string;
  required: boolean;
}

export type DynamicAttribute =
  | (DynamicAttributeBase & { valueType: 'text'; value: string })
  | (DynamicAttributeBase & { valueType: 'number'; value: number })
  | (DynamicAttributeBase & { valueType: 'boolean'; value: boolean })
  | (DynamicAttributeBase & { valueType: 'url'; value: string })
  | (DynamicAttributeBase & { valueType: 'string_list'; value: string[] });

export interface OfferingSpecification {
  name: string;
  value: string;
  unit?: string | undefined;
}

export interface OfferingContent {
  kind: string;
  name: string;
  locale: string;
  market: string;
  taxonomy: string[];
  principle?: string | undefined;
  specifications: OfferingSpecification[];
  features: string[];
  usage: string[];
  applicationScenarios: string[];
  compatibility: string[];
  evidenceHints: string[];
  attributes: DynamicAttribute[];
}

export interface OfferingRevision extends OfferingContent {
  id: string;
  offeringId: string;
  profileId: string;
  tenantId: string;
  workspaceId: string;
  revision: number;
  contentHash: string;
  completeness: CompletenessSummary;
}

export function offeringCompleteness(content: OfferingContent): CompletenessSummary {
  const checks: [string, boolean][] = [
    ['kind', content.kind.trim().length > 0],
    ['name', content.name.trim().length > 0],
    ['locale', content.locale.length > 0],
    ['market', content.market.length > 0],
    ['taxonomy', content.taxonomy.length > 0],
    ['principle', (content.principle?.trim().length ?? 0) > 0],
    ['specifications', content.specifications.length > 0],
    ['features', content.features.length > 0],
    ['usage', content.usage.length > 0],
    ['applicationScenarios', content.applicationScenarios.length > 0],
    ['compatibility', content.compatibility.length > 0],
    ['evidenceHints', content.evidenceHints.length > 0],
    ...content.attributes
      .filter((attribute) => attribute.required)
      .map((attribute): [string, boolean] => [`attributes.${attribute.key}`, true]),
  ];
  const missingFields = checks.filter(([, complete]) => !complete).map(([field]) => field);
  const completedFields = checks.length - missingFields.length;
  return {
    completedFields,
    totalFields: checks.length,
    percent: Math.round((completedFields / checks.length) * 100),
    missingFields,
  };
}
