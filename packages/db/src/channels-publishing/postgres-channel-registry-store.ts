import type { ChannelRegistryStore } from '@aeostudio/application/channels-publishing';
import type {
  AdapterTermsStatus,
  ChannelDefinitionStatus,
  ChannelProfileFieldRequirement,
  ChannelRegistryEntry,
} from '@aeostudio/domain/channels-publishing';
import type { Pool } from 'pg';

import { TenantContextRunner } from '../tenant-context/index.js';

interface ChannelRegistryRow {
  channel_id: string;
  channel_key: string;
  display_name: string;
  channel_status: ChannelDefinitionStatus;
  unavailable_reason: string | null;
  package_transformer_key: string;
  package_schema_version: string;
  profile_channel: string | null;
  profile_version: string | null;
  profile_hash: string | null;
  profile_field_requirements: ChannelProfileFieldRequirement[] | null;
  adapter_id: string | null;
  adapter_key: string | null;
  adapter_version: string | null;
  provider_api_version: string | null;
  provider_api_supported_until: Date | string | null;
  enabled: boolean | null;
  disabled_reason: string | null;
  capabilities: string[] | null;
  required_scopes: string[] | null;
  terms_version: string | null;
  terms_status: AdapterTermsStatus | null;
  processing_region: string | null;
  retention_policy: string | null;
  training_policy: string | null;
  subprocessors: Array<Record<string, unknown>> | null;
  rate_policy: Record<string, unknown> | null;
}

export class PostgresChannelRegistryStore implements ChannelRegistryStore {
  private readonly contexts: TenantContextRunner;

  constructor(pool: Pool) {
    this.contexts = new TenantContextRunner(pool);
  }

  listEntries(input: Parameters<ChannelRegistryStore['listEntries']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const result = await client.query<ChannelRegistryRow>(
        `SELECT
           channel.id AS channel_id,
           channel.channel_key,
           channel.display_name,
           channel.status AS channel_status,
           channel.unavailable_reason,
           channel.package_transformer_key,
           channel.package_schema_version,
           profile.channel AS profile_channel,
           profile.profile_version,
           profile.profile_hash,
           profile.field_requirements AS profile_field_requirements,
           adapter.id AS adapter_id,
           adapter.adapter_key,
           adapter.adapter_version,
           adapter.provider_api_version,
           adapter.provider_api_supported_until,
           adapter.enabled,
           adapter.disabled_reason,
           adapter.capabilities,
           adapter.required_scopes,
           adapter.terms_version,
           adapter.terms_status,
           adapter.processing_region,
           adapter.retention_policy,
           adapter.training_policy,
           adapter.subprocessors,
           adapter.rate_policy
         FROM channel_definitions channel
         LEFT JOIN channel_profiles profile
           ON profile.id = channel.current_channel_profile_id
          AND profile.channel_definition_id = channel.id
         LEFT JOIN adapter_versions adapter
           ON adapter.channel_definition_id = channel.id
         ORDER BY channel.channel_key, adapter.adapter_key, adapter.adapter_version`,
      );

      const entries = new Map<string, ChannelRegistryEntry>();
      for (const row of result.rows) {
        let entry = entries.get(row.channel_id);
        if (entry === undefined) {
          entry = {
            id: row.channel_id,
            channelKey: row.channel_key,
            displayName: row.display_name,
            status: row.channel_status,
            unavailableReason: row.unavailable_reason,
            packageTransformerKey: row.package_transformer_key,
            packageSchemaVersion: row.package_schema_version,
            channelProfile:
              row.profile_channel === null ||
              row.profile_version === null ||
              row.profile_hash === null ||
              row.profile_field_requirements === null
                ? null
                : {
                    channel: row.profile_channel,
                    profileVersion: row.profile_version,
                    profileHash: row.profile_hash,
                    fieldRequirements: row.profile_field_requirements,
                  },
            adapterVersions: [],
          };
          entries.set(row.channel_id, entry);
        }
        if (row.adapter_id === null) continue;
        if (
          row.adapter_key === null ||
          row.adapter_version === null ||
          row.enabled === null ||
          row.capabilities === null ||
          row.required_scopes === null ||
          row.terms_version === null ||
          row.terms_status === null ||
          row.processing_region === null ||
          row.retention_policy === null ||
          row.training_policy === null ||
          row.subprocessors === null ||
          row.rate_policy === null
        ) {
          throw new Error('CHANNEL_ADAPTER_REGISTRY_ROW_INCOMPLETE');
        }
        entry.adapterVersions.push({
          id: row.adapter_id,
          adapterKey: row.adapter_key,
          adapterVersion: row.adapter_version,
          ...(row.provider_api_version === null
            ? {}
            : { providerApiVersion: row.provider_api_version }),
          ...(row.provider_api_supported_until === null
            ? {}
            : {
                providerApiSupportedUntil: new Date(row.provider_api_supported_until).toISOString(),
              }),
          enabled: row.enabled,
          disabledReason: row.disabled_reason,
          capabilities: row.capabilities,
          requiredScopes: row.required_scopes,
          termsVersion: row.terms_version,
          termsStatus: row.terms_status,
          processingRegion: row.processing_region,
          retentionPolicy: row.retention_policy,
          trainingPolicy: row.training_policy,
          subprocessors: row.subprocessors,
          ratePolicy: row.rate_policy,
        });
      }
      return [...entries.values()];
    });
  }
}
