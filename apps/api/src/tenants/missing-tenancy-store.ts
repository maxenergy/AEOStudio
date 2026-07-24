import type {
  BootstrapTenantResult,
  MembershipResult,
  TenancyStore,
} from '@aeostudio/application/identity-access';

export class MissingTenancyStore implements TenancyStore {
  bootstrapTenant(): Promise<BootstrapTenantResult> {
    return Promise.reject(new Error('TENANCY_STORE_NOT_CONFIGURED'));
  }

  findWorkspaceForActor(): Promise<null> {
    return Promise.reject(new Error('TENANCY_STORE_NOT_CONFIGURED'));
  }

  listWorkspacesForActor(): Promise<never[]> {
    return Promise.reject(new Error('TENANCY_STORE_NOT_CONFIGURED'));
  }

  resolveTenantContext(): Promise<null> {
    return Promise.reject(new Error('TENANCY_STORE_NOT_CONFIGURED'));
  }

  resolvePrivacyGovernanceContext(): Promise<null> {
    return Promise.reject(new Error('TENANCY_STORE_NOT_CONFIGURED'));
  }

  inviteMembership(): Promise<MembershipResult> {
    return Promise.reject(new Error('TENANCY_STORE_NOT_CONFIGURED'));
  }

  acceptMembership(): Promise<MembershipResult | null> {
    return Promise.reject(new Error('TENANCY_STORE_NOT_CONFIGURED'));
  }

  changeMembershipRole(): Promise<MembershipResult | null> {
    return Promise.reject(new Error('TENANCY_STORE_NOT_CONFIGURED'));
  }

  revokeMembership(): Promise<MembershipResult | null> {
    return Promise.reject(new Error('TENANCY_STORE_NOT_CONFIGURED'));
  }

  appendDeniedAudit(): Promise<void> {
    return Promise.reject(new Error('TENANCY_STORE_NOT_CONFIGURED'));
  }
}
