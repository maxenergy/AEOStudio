import type {
  ChannelAdapterVersion,
  ChannelAuthorizationEligibility,
  ChannelPackageRecord,
  PublicationEligibilityReason,
} from '@aeostudio/domain/channels-publishing';
import { roleAllows } from '@aeostudio/domain/identity-access';

import type { TenantContext, TenancyStore } from '../identity-access/index.js';
import type { ChannelPackageService } from './channel-package-service.js';
import type {
  ChannelAuthorizationStore,
  ChannelRegistryStore,
  RuntimeChannelAdapterRegistry,
} from './ports.js';
import {
  providerApiVersionIsExpired,
  resolvePublicationAdapterGovernance,
  validatePublicationAdapterRuntime,
} from './publication-execution.js';

export type RequestPublicationOutcome =
  | {
      outcome: 'EXPORT_ONLY';
      packageId: string;
      packageChecksum: string;
      reasons: PublicationEligibilityReason[];
    }
  | {
      outcome: 'READY';
      packageId: string;
      packageChecksum: string;
      context: TenantContext;
      channelPackage: ChannelPackageRecord;
      adapter: ChannelAdapterVersion;
      authorization: ChannelAuthorizationEligibility;
      requiredScopes: string[];
    }
  | {
      outcome:
        | 'NOT_FOUND'
        | 'FORBIDDEN'
        | 'PACKAGE_CHECKSUM_MISMATCH'
        | 'PACKAGE_INTEGRITY_INVALID'
        | 'APPROVAL_REQUIRED'
        | 'APPROVAL_STALE';
    };

export interface CheckPublicationEligibilityInput {
  actorSubject: string;
  /** Raw, authenticated __Host-aeo_session value for DB-bound object-read authority. */
  sessionToken: string;
  tenantId: string;
  workspaceId: string;
  channelPackageId: string;
  adapterVersionId?: string;
  target: string;
  expectedPackageChecksum: string;
}

export class PublicationEligibilityService {
  constructor(
    private readonly packages: ChannelPackageService,
    private readonly registry: ChannelRegistryStore,
    private readonly authorizations: ChannelAuthorizationStore,
    private readonly runtimeAdapters: RuntimeChannelAdapterRegistry,
    private readonly tenancy: Pick<TenancyStore, 'resolveTenantContext'>,
    private readonly clock: { now(): Date },
  ) {}

  request(
    input: CheckPublicationEligibilityInput & { idempotencyKey: string },
  ): Promise<RequestPublicationOutcome> {
    return this.evaluate(input);
  }

  check(input: CheckPublicationEligibilityInput): Promise<RequestPublicationOutcome> {
    return this.evaluate(input);
  }

  private async evaluate(
    input: CheckPublicationEligibilityInput,
  ): Promise<RequestPublicationOutcome> {
    const context = await this.tenancy.resolveTenantContext({
      actorSubject: input.actorSubject,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
    });
    if (context === null) return { outcome: 'NOT_FOUND' };
    if (!roleAllows(context.role, 'PUBLISH')) return { outcome: 'FORBIDDEN' };

    // The publication boundary re-hashes the package and revalidates its exact Artifact approval
    // and current lineage; a build-time approval is never treated as a permanent publish grant.
    const verified = await this.packages.verifyForPublication({
      actorSubject: input.actorSubject,
      sessionToken: input.sessionToken,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      packageId: input.channelPackageId,
    });
    if (verified.outcome === 'NOT_FOUND') return { outcome: 'NOT_FOUND' };
    if (verified.outcome === 'FORBIDDEN') return { outcome: 'FORBIDDEN' };
    if (verified.outcome === 'PAYLOAD_INTEGRITY_INVALID') {
      return { outcome: 'PACKAGE_INTEGRITY_INVALID' };
    }
    if (verified.outcome === 'APPROVAL_REQUIRED') return { outcome: 'APPROVAL_REQUIRED' };
    if (verified.outcome === 'APPROVAL_STALE') return { outcome: 'APPROVAL_STALE' };
    if (verified.outcome !== 'SUCCEEDED') {
      throw new Error('UNHANDLED_CHANNEL_PACKAGE_VERIFICATION_OUTCOME');
    }
    if (verified.package.packageChecksum !== input.expectedPackageChecksum) {
      return { outcome: 'PACKAGE_CHECKSUM_MISMATCH' };
    }

    const channel = (await this.registry.listEntries({ context })).find(
      (entry) =>
        entry.id === verified.package.channel.definitionId &&
        entry.channelKey === verified.package.channel.channelKey,
    );
    if (channel === undefined) return { outcome: 'NOT_FOUND' };
    const adapter = channel.adapterVersions.find((entry) => entry.id === input.adapterVersionId);
    if (adapter === undefined) {
      return {
        outcome: 'EXPORT_ONLY',
        packageId: input.channelPackageId,
        packageChecksum: verified.package.packageChecksum,
        reasons: [
          {
            code: 'ADAPTER_NOT_FOUND',
            detail:
              channel.adapterVersions.length === 0
                ? 'This Channel has no publishing Adapter; use the reviewed export package.'
                : 'Select an available Adapter version or use the reviewed export package.',
          },
        ],
      };
    }

    const reasons: PublicationEligibilityReason[] = [];
    if (channel.status !== 'AVAILABLE') {
      reasons.push({
        code: 'CHANNEL_UNAVAILABLE',
        detail: channel.unavailableReason ?? 'This Channel is unavailable.',
      });
    }
    if (!adapter.enabled) {
      reasons.push({
        code: 'ADAPTER_DISABLED',
        detail: adapter.disabledReason ?? 'This Adapter version is disabled.',
      });
    }
    if (providerApiVersionIsExpired(adapter.providerApiSupportedUntil, this.clock.now())) {
      reasons.push({
        code: 'ADAPTER_PROVIDER_API_VERSION_EXPIRED',
        detail: `Provider API version ${adapter.providerApiVersion ?? 'unknown'} support ended at ${adapter.providerApiSupportedUntil}.`,
      });
    }
    if (!adapter.capabilities.includes('PUBLISH')) {
      reasons.push({
        code: 'PUBLISH_CAPABILITY_MISSING',
        detail: 'This Adapter version does not declare the publish capability.',
      });
    }
    if (!adapter.capabilities.includes('RECONCILE')) {
      reasons.push({
        code: 'RECONCILE_CAPABILITY_MISSING',
        detail: 'This Adapter version cannot reconcile an uncertain publish outcome.',
      });
    }
    if (adapter.termsStatus !== 'ALLOWED') {
      reasons.push({
        code: 'TERMS_NOT_APPROVED',
        detail: `Adapter terms status is ${adapter.termsStatus}.`,
      });
    }
    const runtimeAdapter = this.runtimeAdapters.resolve(adapter.adapterKey, adapter.adapterVersion);
    let authorizationTarget = input.target;
    let requiredScopes = [...adapter.requiredScopes];
    if (runtimeAdapter === null) {
      reasons.push({
        code: 'ADAPTER_RUNTIME_UNAVAILABLE',
        detail: 'No executable implementation is deployed for this Adapter version.',
      });
    } else if (validatePublicationAdapterRuntime(runtimeAdapter, adapter) !== null) {
      reasons.push({
        code: 'ADAPTER_RUNTIME_METADATA_MISMATCH',
        detail: 'The deployed Adapter does not match current Registry governance metadata.',
      });
    } else {
      const governance = resolvePublicationAdapterGovernance(
        runtimeAdapter,
        adapter.requiredScopes,
        {
          target: input.target,
          channelPackage: verified.package,
        },
      );
      if (governance === null) {
        reasons.push({
          code: 'ADAPTER_RUNTIME_METADATA_MISMATCH',
          detail: 'The deployed Adapter rejected this target or returned invalid scope policy.',
        });
      } else {
        authorizationTarget = governance.authorizationTarget;
        requiredScopes = governance.requiredScopes;
      }
    }

    const authorization = await this.authorizations.findForTarget({
      context,
      adapterVersionId: adapter.id,
      target: authorizationTarget,
    });
    if (authorization === null) {
      reasons.push({
        code: 'AUTHORIZATION_MISSING',
        detail: 'No approved Channel authorization is available for this target.',
      });
    } else {
      if (authorization.status === 'REVOKED') {
        reasons.push({
          code: 'AUTHORIZATION_REVOKED',
          detail: 'The Channel authorization has been revoked.',
        });
      }
      if (
        authorization.expiresAt !== null &&
        new Date(authorization.expiresAt).getTime() <= this.clock.now().getTime()
      ) {
        reasons.push({
          code: 'AUTHORIZATION_EXPIRED',
          detail: 'The Channel authorization has expired.',
        });
      }
      if (
        authorization.validationStatus === undefined ||
        authorization.validationStatus === 'PENDING_VALIDATION'
      ) {
        reasons.push({
          code: 'AUTHORIZATION_VALIDATION_PENDING',
          detail: 'The Channel authorization is awaiting provider validation.',
        });
      } else if (
        authorization.validationStatus === 'INVALID' ||
        authorization.validationSnapshot === null ||
        authorization.validationSnapshot === undefined
      ) {
        reasons.push({
          code: 'AUTHORIZATION_VALIDATION_INVALID',
          detail: `Provider validation rejected this authorization${
            authorization.validationFailureCode === null ||
            authorization.validationFailureCode === undefined
              ? ''
              : ` (${authorization.validationFailureCode})`
          }.`,
        });
      } else {
        const snapshot = authorization.validationSnapshot;
        if (new Date(snapshot.validUntil).getTime() <= this.clock.now().getTime()) {
          reasons.push({
            code: 'AUTHORIZATION_VALIDATION_STALE',
            detail: 'The provider validation snapshot is no longer fresh.',
          });
        }
        if (snapshot.actualTarget !== authorizationTarget) {
          reasons.push({
            code: 'AUTHORIZATION_VALIDATED_TARGET_MISMATCH',
            detail: 'The provider-validated target does not cover this publication target.',
          });
        }
        if (snapshot.acceptedTermsVersion !== adapter.termsVersion) {
          reasons.push({
            code: 'AUTHORIZATION_VALIDATED_TERMS_MISMATCH',
            detail: 'The provider validation snapshot is bound to a different terms version.',
          });
        }
        const providerMissingScopes = requiredScopes.filter(
          (scope) => !snapshot.actualScopes.includes(scope),
        );
        if (providerMissingScopes.length > 0) {
          reasons.push({
            code: 'AUTHORIZATION_VALIDATED_SCOPE_INSUFFICIENT',
            detail: `Provider validation did not prove ${providerMissingScopes.join(', ')}.`,
          });
        }
      }
      if (authorization.acceptedTermsVersion !== adapter.termsVersion) {
        reasons.push({
          code: 'TERMS_NOT_APPROVED',
          detail: 'The accepted terms version does not match this Adapter version.',
        });
      }
      const missingScopes = requiredScopes.filter(
        (scope) => !authorization.grantedScopes.includes(scope),
      );
      if (missingScopes.length > 0) {
        reasons.push({
          code: 'AUTHORIZATION_SCOPE_INSUFFICIENT',
          detail: `The Channel authorization lacks ${missingScopes.join(', ')}.`,
        });
      }
    }

    return reasons.length === 0
      ? {
          outcome: 'READY',
          packageId: input.channelPackageId,
          packageChecksum: verified.package.packageChecksum,
          context,
          channelPackage: verified.package,
          adapter,
          authorization: authorization!,
          requiredScopes,
        }
      : {
          outcome: 'EXPORT_ONLY',
          packageId: input.channelPackageId,
          packageChecksum: verified.package.packageChecksum,
          reasons,
        };
  }
}
