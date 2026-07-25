export const CHANNEL_DEFINITION_STATUSES = ['AVAILABLE', 'UNAVAILABLE', 'DEPRECATED'] as const;
export type ChannelDefinitionStatus = (typeof CHANNEL_DEFINITION_STATUSES)[number];

export const ADAPTER_TERMS_STATUSES = ['ALLOWED', 'REVIEW_REQUIRED', 'PROHIBITED'] as const;
export type AdapterTermsStatus = (typeof ADAPTER_TERMS_STATUSES)[number];

export interface ChannelAdapterVersion {
  id: string;
  adapterKey: string;
  adapterVersion: string;
  /** Version of the remote Provider contract, when that Provider is versioned. */
  providerApiVersion?: string;
  /** Exclusive Provider support cutoff for this version, when the Provider publishes one. */
  providerApiSupportedUntil?: string;
  enabled: boolean;
  disabledReason: string | null;
  capabilities: string[];
  requiredScopes: string[];
  termsVersion: string;
  termsStatus: AdapterTermsStatus;
  processingRegion: string;
  retentionPolicy: string;
  trainingPolicy: string;
  subprocessors: Array<Record<string, unknown>>;
  ratePolicy: Record<string, unknown>;
}

export interface ChannelProfileFieldRequirement {
  field: string;
  sourcePointer: string;
  required: boolean;
  minLength: number | null;
  maxLength: number | null;
  format: string;
}

/** Body rendering format the destination platform expects. */
export type ChannelProfileBodyFormat = 'markdown' | 'html' | 'plain';

/** Where the disclosure / call-to-action block is placed in rendered output. */
export type ChannelProfileCtaPosition = 'none' | 'top' | 'bottom';

/**
 * Immutable, versioned destination requirements. `channel` and `format` remain open strings:
 * adding a destination is Registry data, not a business-logic enum or release.
 *
 * The optional platform-template constraints (titleMaxLength, bodyFormat, maxTags, ctaPosition)
 * are additive and default to the historical behaviour when absent, so existing profiles and
 * their profileHash remain valid unchanged.
 */
export interface ChannelProfile {
  channel: string;
  profileVersion: string;
  profileHash: string;
  fieldRequirements: ChannelProfileFieldRequirement[];
  titleMaxLength?: number | null;
  bodyFormat?: ChannelProfileBodyFormat | null;
  maxTags?: number | null;
  ctaPosition?: ChannelProfileCtaPosition | null;
}

export interface ChannelRegistryEntry {
  id: string;
  channelKey: string;
  displayName: string;
  status: ChannelDefinitionStatus;
  unavailableReason: string | null;
  packageTransformerKey: string;
  packageSchemaVersion: string;
  channelProfile?: ChannelProfile | null;
  adapterVersions: ChannelAdapterVersion[];
}
