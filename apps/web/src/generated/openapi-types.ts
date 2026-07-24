/* AUTO-GENERATED from packages/contracts/generated/openapi-3.1.json. */
/* DO NOT EDIT. Run `pnpm contracts:generate` instead. */

export interface paths {
  '/__test/oidc/authorize': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** authorize */
    get: operations['FakeOidc_authorize'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/auth/callback': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** callback */
    get: operations['Auth_callback'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/auth/login': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** login */
    get: operations['Auth_login'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/auth/logout': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** logout */
    post: operations['Auth_logout'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/auth/session': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** getSession */
    get: operations['Auth_getSession'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/privacy/deletion-receipts/current': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** current */
    get: operations['DeletionReceipt_current'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/runtime/build-identity': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** get */
    get: operations['RuntimeBuildIdentity_get'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** listWorkspaces */
    get: operations['Tenancy_listWorkspaces'];
    put?: never;
    /** createTenant */
    post: operations['Tenancy_createTenant'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** getWorkspace */
    get: operations['Tenancy_getWorkspace'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/artifacts': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** start */
    post: operations['Artifacts_start'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/artifacts/{artifactId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** get */
    get: operations['Artifacts_get'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/artifacts/{artifactId}/revisions': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** createRevision */
    post: operations['Artifacts_createRevision'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/artifacts/{artifactId}/revisions/{revision}/review': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** reviewRevision */
    post: operations['Artifacts_reviewRevision'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/artifacts/{artifactId}/revisions/{revision}/submit': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** submitRevision */
    post: operations['Artifacts_submitRevision'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/budget': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    /** setBudget */
    put: operations['Jobs_setBudget'];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/budget/alerts': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** listBudgetAlerts */
    get: operations['Jobs_listBudgetAlerts'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/budget/providers/{providerKey}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    /** setProviderBudget */
    put: operations['Jobs_setProviderBudget'];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/budget/tenant': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    /** setTenantBudget */
    put: operations['Jobs_setTenantBudget'];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/channel-authorizations': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** list */
    get: operations['ChannelAuthorizations_list'];
    put?: never;
    /** create */
    post: operations['ChannelAuthorizations_create'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/channel-authorizations/{authorizationId}/revoke': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** revoke */
    post: operations['ChannelAuthorizations_revoke'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/channel-packages': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** build */
    post: operations['ChannelPackages_build'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/channel-packages/{packageId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** getPreview */
    get: operations['ChannelPackages_getPreview'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/channel-packages/{packageId}/export': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** export */
    get: operations['ChannelPackages_export'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/channels': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** list */
    get: operations['Channels_list'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/claims': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** createClaim */
    post: operations['Claims_createClaim'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/claims/{claimId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** getClaim */
    get: operations['Claims_getClaim'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/claims/{claimId}/revisions/{revisionId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** getClaimRevision */
    get: operations['Claims_getClaimRevision'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/claims/{claimId}/revisions/{revisionId}/evidence': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** getEvidenceDrillDown */
    get: operations['Claims_getEvidenceDrillDown'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/claims/{claimId}/revisions/{revisionId}/reviews': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** reviewClaim */
    post: operations['Claims_reviewClaim'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/claims/{claimId}/revisions/{revisionId}/submit': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** submitClaim */
    post: operations['Claims_submitClaim'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/claims/approved': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** listApprovedClaims */
    get: operations['Claims_listApprovedClaims'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/content-plans': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** start */
    post: operations['ContentPlans_start'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/content-plans/{planId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** get */
    get: operations['ContentPlans_get'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/content-plans/{planId}/briefs/{briefId}/review': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** reviewBrief */
    post: operations['ContentPlans_reviewBrief'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/content-plans/briefs/approved': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** listApprovedBriefs */
    get: operations['ContentPlans_listApprovedBriefs'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/evidence-sources': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** createSource */
    post: operations['Claims_createSource'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/evidence-sources/{sourceId}/snapshots': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** createSnapshot */
    post: operations['Claims_createSnapshot'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/experiments': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** create */
    post: operations['Experiments_create'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/experiments/{experimentId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** get */
    get: operations['Experiments_get'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/experiments/options': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** listOptions */
    get: operations['Experiments_listOptions'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/invitations': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** inviteMembership */
    post: operations['Tenancy_inviteMembership'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/jobs': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** submitJob */
    post: operations['Jobs_submitJob'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/jobs/{jobId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** getJob */
    get: operations['Jobs_getJob'];
    put?: never;
    post?: never;
    /** cancelJob */
    delete: operations['Jobs_cancelJob'];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/measurement-manual-imports': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** submitManualImport */
    post: operations['Measurement_submitManualImport'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/measurement-manual-imports/{manualImportId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** getManualImport */
    get: operations['Measurement_getManualImport'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/measurement-manual-imports/{manualImportId}/review': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** reviewManualImport */
    post: operations['Measurement_reviewManualImport'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/measurement-provider-policies/{providerKey}/{surfaceKey}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** getProviderPolicyState */
    get: operations['Measurement_getProviderPolicyState'];
    /** setProviderPolicy */
    put: operations['Measurement_setProviderPolicy'];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/measurement-registry': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** registry */
    get: operations['Prompts_registry'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/measurement-runs': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** start */
    post: operations['Measurement_start'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/measurement-runs/{measurementRunId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** getRun */
    get: operations['Measurement_getRun'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/measurement-runs/{measurementRunId}/dashboard': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** dashboard */
    get: operations['Measurement_dashboard'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/measurement-runs/{measurementRunId}/prompt-runs': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** listPromptRuns */
    get: operations['Measurement_listPromptRuns'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/measurement-runs/{measurementRunId}/prompt-runs/{promptRunId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** getPromptRun */
    get: operations['Measurement_getPromptRun'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/memberships/{membershipId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    /** revokeMembership */
    delete: operations['Tenancy_revokeMembership'];
    options?: never;
    head?: never;
    /** changeMembershipRole */
    patch: operations['Tenancy_changeMembershipRole'];
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/memberships/{membershipId}/accept': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** acceptMembership */
    post: operations['Tenancy_acceptMembership'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/offerings': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** listOfferings */
    get: operations['ProfileOffering_listOfferings'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/offerings/{offeringId}/revisions': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** createOfferingRevision */
    post: operations['ProfileOffering_createOfferingRevision'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/offerings/{offeringId}/revisions/{revision}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** getOfferingRevision */
    get: operations['ProfileOffering_getOfferingRevision'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/privacy/audit-digests': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** sealAuditDigest */
    post: operations['Privacy_sealAuditDigest'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/privacy/audit-events': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** auditEvents */
    get: operations['Privacy_auditEvents'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/privacy/audit-integrity': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** auditIntegrity */
    get: operations['Privacy_auditIntegrity'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/privacy/deletions/tenant': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** deleteTenant */
    post: operations['Privacy_deleteTenant'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/privacy/deletions/workspace': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** deleteWorkspace */
    post: operations['Privacy_deleteWorkspace'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/privacy/exports': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** exportTenant */
    post: operations['Privacy_exportTenant'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/privacy/exports/{exportId}/download': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** downloadExport */
    get: operations['Privacy_downloadExport'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/privacy/legal-holds': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** legalHolds */
    get: operations['Privacy_legalHolds'];
    put?: never;
    /** createLegalHold */
    post: operations['Privacy_createLegalHold'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/privacy/legal-holds/{holdId}/release': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** releaseLegalHold */
    post: operations['Privacy_releaseLegalHold'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/privacy/overview': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** overview */
    get: operations['Privacy_overview'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/profiles': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** listProfiles */
    get: operations['ProfileOffering_listProfiles'];
    put?: never;
    /** createProfile */
    post: operations['ProfileOffering_createProfile'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/profiles/{profileId}/offerings': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** createOffering */
    post: operations['ProfileOffering_createOffering'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/profiles/{profileId}/revisions': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** createProfileRevision */
    post: operations['ProfileOffering_createProfileRevision'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/profiles/{profileId}/revisions/{revision}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** getProfileRevision */
    get: operations['ProfileOffering_getProfileRevision'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/prompt-sets/{promptSetId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** current */
    get: operations['Prompts_current'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/prompt-sets/{promptSetId}/revisions': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** revise */
    post: operations['Prompts_revise'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/prompt-sets/{promptSetId}/revisions/{revisionId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** revision */
    get: operations['Prompts_revision'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/prompt-sets/{promptSetId}/revisions/{revisionId}/approve': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** approve */
    post: operations['Prompts_approve'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/prompt-sets/approved': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** listApproved */
    get: operations['Prompts_listApproved'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/prompt-sets/proposals': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** propose */
    post: operations['Prompts_propose'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/publications': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** requestPublication */
    post: operations['Publications_requestPublication'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/publications/{publicationId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** getPublication */
    get: operations['Publications_getPublication'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/publications/{publicationId}/remote-status/refresh': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** refreshRemoteStatus */
    post: operations['Publications_refreshRemoteStatus'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/publications/eligibility': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** checkEligibility */
    post: operations['Publications_checkEligibility'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/signed-webhook-endpoint-verifications': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** list */
    get: operations['SignedWebhookEndpointVerifications_list'];
    put?: never;
    /** create */
    post: operations['SignedWebhookEndpointVerifications_create'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/signed-webhook-endpoint-verifications/{verificationId}/revoke': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** revoke */
    post: operations['SignedWebhookEndpointVerifications_revoke'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/signed-webhook-endpoint-verifications/{verificationId}/verify': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** verify */
    post: operations['SignedWebhookEndpointVerifications_verify'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/sites': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** registerSite */
    post: operations['Sites_registerSite'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/sites/{siteId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** getSite */
    get: operations['Sites_getSite'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/sites/{siteId}/baseline': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** getBaseline */
    get: operations['Sites_getBaseline'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/sites/{siteId}/crawls': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** startCrawl */
    post: operations['Sites_startCrawl'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/sites/{siteId}/verifications': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** createVerification */
    post: operations['Sites_createVerification'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/sites/{siteId}/verifications/{verificationId}/complete': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** completeVerification */
    post: operations['Sites_completeVerification'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/tenants/{tenantId}/workspaces/{workspaceId}/sites/baselines': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** listBaselines */
    get: operations['Sites_listBaselines'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/health': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** health */
    get: operations['Health_health'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/ready': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** ready */
    get: operations['Health_ready'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
}
export type webhooks = Record<string, never>;
export interface components {
  schemas: {
    ApprovedBriefListEnvelopeSchema: {
      data: {
        briefs: {
          assetKind: string;
          briefId: components['schemas']['schema1'];
          contentHash: components['schemas']['schema2'];
          planId: components['schemas']['schema1'];
          status: string;
          title: string;
        }[];
      };
      meta: components['schemas']['schema3'];
    };
    ApprovedClaimListEnvelopeSchema: {
      data: {
        claims: {
          /** Format: uuid */
          claimId: string;
          contentHash: string;
          revision: number;
          /** Format: uuid */
          revisionId: string;
          statement: string;
        }[];
      };
      meta: {
        requestId: string;
        /** @constant */
        schemaVersion: '1.0.0';
      };
    };
    ApprovedPromptSetListEnvelopeSchema: {
      data: {
        promptSets: {
          contentHash: components['schemas']['schema0'];
          promptSetId: components['schemas']['schema4'];
          revision: number;
          revisionId: components['schemas']['schema4'];
          subject: string;
          title: string;
        }[];
      };
      meta: components['schemas']['schema5'];
    };
    ApprovePromptRevisionRequestSchema: {
      expectedPromptHash: components['schemas']['schema0'];
      expectedScenarioHash: components['schemas']['schema0'];
    };
    ArtifactBundleEnvelopeSchema: {
      data: {
        /** @enum {string} */
        approvalState: 'ELIGIBLE' | 'APPROVAL_REQUIRED' | 'APPROVAL_STALE';
        artifact: components['schemas']['ArtifactSchema'];
        payload: components['schemas']['ArtifactPayloadSchema'] | null;
        previousPayload: components['schemas']['ArtifactPayloadSchema'] | null;
        reviews: components['schemas']['ArtifactReviewSchema'][];
        revision: components['schemas']['ArtifactRevisionSchema'] | null;
        revisions: components['schemas']['ArtifactRevisionSchema'][];
        selectableApprovedRevisions: {
          contentHash: string;
          revision: number;
        }[];
      };
      meta: components['schemas']['schema10'];
    };
    ArtifactPayloadSchema: {
      claimMap: {
        claimRevisionId: components['schemas']['schema6'];
        evidenceSourceIds: components['schemas']['schema6'][];
        statement: string;
      }[];
      disclosure: string;
      sections: {
        body: string;
        heading: string;
      }[];
      summary: string;
      title: string;
    };
    ArtifactReviewSchema: {
      artifactId: components['schemas']['schema6'];
      artifactRevisionId: components['schemas']['schema6'];
      contentHash: string;
      /** Format: date-time */
      createdAt: string;
      /** @enum {string} */
      decision: 'APPROVE' | 'REJECT';
      id: components['schemas']['schema6'];
      note: string;
      reviewerUserId: components['schemas']['schema6'];
      revision: number;
    };
    ArtifactRevisionSchema: {
      artifactId: components['schemas']['schema6'];
      briefId: components['schemas']['schema6'];
      claimBindings: components['schemas']['schema8'][];
      contentHash: string;
      /** Format: date-time */
      createdAt: string;
      createdByActor: {
        id: components['schemas']['schema6'];
        /** @enum {string} */
        kind: 'USER' | 'AGENT';
      };
      id: components['schemas']['schema6'];
      lineage: {
        brief: {
          contentHash: string;
          id: components['schemas']['schema6'];
        };
        contentPlanId: components['schemas']['schema6'];
        prompt: {
          contentHash: string;
          promptIds: components['schemas']['schema6'][];
          promptRevisionId: components['schemas']['schema6'];
          promptSetId: components['schemas']['schema6'];
        };
        sourceReferences: components['schemas']['schema7'][];
      };
      locale: string;
      market: string;
      methodPolicyVersion: string;
      payloadObjectRef: string;
      revision: number;
      /** @constant */
      schemaVersion: '1.0.0';
      sourceArtifactIds: components['schemas']['schema6'][];
      /** @enum {string} */
      status: 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED' | 'STALE';
      /** @enum {string} */
      type: 'DEFINITION_PRODUCT' | 'COMPARISON' | 'TECHNICAL_EVIDENCE';
    };
    ArtifactSchema: {
      briefId: components['schemas']['schema6'];
      /** Format: date-time */
      createdAt: string;
      createdByUserId: components['schemas']['schema6'];
      id: components['schemas']['schema6'];
      jobId: components['schemas']['schema6'] | null;
      locale: string;
      market: string;
      methodPolicyVersion: string;
      revision: number;
      /** @enum {string} */
      status: 'PENDING' | 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED' | 'STALE';
      tenantId: components['schemas']['schema6'];
      /** @enum {string} */
      type: 'DEFINITION_PRODUCT' | 'COMPARISON' | 'TECHNICAL_EVIDENCE';
      workspaceId: components['schemas']['schema6'];
    };
    /** @enum {string} */
    AuditActorKindSchema: 'USER' | 'AGENT' | 'SYSTEM' | 'SUPPORT' | 'PLATFORM_OPERATOR';
    AuditDigestEnvelopeSchema: {
      data: {
        digest: components['schemas']['AuditDigestSchema'];
      };
      meta: components['schemas']['schema15'];
    };
    AuditDigestSchema: {
      digestHash: components['schemas']['schema13'];
      eventCount: number;
      headHash: components['schemas']['schema13'] | null;
      id: components['schemas']['schema11'];
      lastSequence: number;
      lockedUntil: components['schemas']['schema12'];
      objectKey: components['schemas']['schema14'];
      objectRef: string;
      objectVersionId: string;
      /** @constant */
      schemaVersion: 'audit-digest.v1';
      sealedAt: components['schemas']['schema12'];
      tenantId: components['schemas']['schema11'];
      timeRange: components['schemas']['PrivacyTimeRangeSchema'];
    };
    AuditIntegrityEnvelopeSchema: {
      data: {
        verification: components['schemas']['AuditIntegrityResultSchema'];
      };
      meta: components['schemas']['schema15'];
    };
    AuditIntegrityResultSchema: {
      eventCount: components['schemas']['schema18'];
      outcome: components['schemas']['schema16'];
      reason: components['schemas']['schema19'];
      valid: components['schemas']['schema17'];
    };
    AuditIntegrityVerificationSchema: {
      eventCount: number;
      headHash: components['schemas']['schema13'] | null;
      lastSequence: number;
      reason: string | null;
      valid: boolean;
    };
    AuditTimelineEnvelopeSchema: {
      data: {
        timeline: components['schemas']['AuditTimelineSchema'];
      };
      meta: components['schemas']['schema15'];
    };
    AuditTimelineEventSchema: {
      action: string;
      actorId: string;
      actorKind: components['schemas']['AuditActorKindSchema'];
      eventHash: components['schemas']['schema13'];
      id: components['schemas']['schema11'];
      metadata: {
        [key: string]: unknown;
      };
      occurredAt: components['schemas']['schema12'];
      outcome: string;
      previousHash: components['schemas']['schema13'] | null;
      resourceId: string | null;
      resourceType: string;
      sequence: number;
      tenantId: components['schemas']['schema11'];
      workspaceId: components['schemas']['schema11'] | null;
    };
    AuditTimelineSchema: {
      events: components['schemas']['AuditTimelineEventSchema'][];
      nextCursor: string | null;
    };
    BaselineFindingSchema: {
      detail: string;
      findingType: string;
      /** Format: uuid */
      id: string;
      /** @enum {string} */
      severity: 'INFO' | 'WARNING' | 'ERROR';
      /** Format: uuid */
      snapshotId: string;
    };
    BreakGlassDecisionSchema: {
      auditEventId: components['schemas']['schema11'] | null;
      /** @enum {string} */
      decision: 'ALLOW' | 'DENY';
      grantId: components['schemas']['schema11'] | null;
      operatorName: string | null;
      reason: components['schemas']['schema20'] | null;
      /** @enum {string} */
      state: 'ACTIVE' | 'NOT_YET_ACTIVE' | 'EXPIRED' | 'REVOKED' | 'INVALID_GRANT';
    };
    BreakGlassGrantSchema: {
      auditEventId: components['schemas']['schema11'];
      expiresAt: components['schemas']['schema12'];
      grantedAt: components['schemas']['schema12'];
      id: components['schemas']['schema11'];
      operatorId: components['schemas']['schema11'];
      operatorName: components['schemas']['schema21'];
      reason: components['schemas']['schema20'];
      requestedAction: components['schemas']['schema22'];
      resourceId: components['schemas']['schema24'];
      resourceType: components['schemas']['schema23'];
      revokedAt: components['schemas']['schema25'];
      tenantId: components['schemas']['schema11'];
      workspaceId: components['schemas']['schema11'];
    };
    BriefReviewEnvelopeSchema: {
      data: {
        brief: components['schemas']['BriefSchema'];
        review: components['schemas']['BriefReviewSchema'];
      };
      meta: components['schemas']['schema3'];
    };
    BriefReviewSchema: {
      briefId: components['schemas']['schema1'];
      contentHash: components['schemas']['schema2'];
      /** @enum {string} */
      decision: 'APPROVE' | 'REJECT';
      id: components['schemas']['schema1'];
      note: string;
      /** Format: date-time */
      reviewedAt: string;
      reviewedByUserId: components['schemas']['schema1'];
    };
    BriefSchema: {
      /** @enum {string} */
      assetKind: 'DEFINITION_PRODUCT' | 'COMPARISON' | 'TECHNICAL_EVIDENCE';
      claimRevisionIds: components['schemas']['schema1'][];
      contentHash: components['schemas']['schema2'];
      contentPlanId: components['schemas']['schema1'];
      /** Format: date-time */
      createdAt: string;
      createdByUserId: components['schemas']['schema1'];
      /** @constant */
      evidenceReady: true;
      id: components['schemas']['schema1'];
      /** @enum {string} */
      key: 'DEFINITION_PRODUCT' | 'COMPARISON' | 'TECHNICAL_EVIDENCE';
      opportunityId: components['schemas']['schema1'];
      promptIds: components['schemas']['schema1'][];
      /** @constant */
      publishReady: false;
      sourceArtifactIds: components['schemas']['schema1'][];
      /** @enum {string} */
      status: 'REVIEW_REQUIRED' | 'APPROVED' | 'REJECTED';
      title: string;
    };
    BudgetAlertSchema: {
      /** @constant */
      audience: 'TENANT_OWNER';
      /** @enum {string} */
      budgetScope: 'TENANT' | 'PROVIDER';
      /** Format: date-time */
      createdAt: string;
      /** Format: uuid */
      id: string;
      /** Format: uuid */
      jobId: string;
      /** Format: uuid */
      policyId: string;
      providerKey: components['schemas']['ProviderKeySchema'] | null;
      /** Format: uuid */
      recipientUserId: string;
      /** Format: uuid */
      sourceWorkspaceId: string;
      /** Format: uuid */
      tenantId: string;
      thresholdPercent: number;
    };
    BudgetAlertsEnvelopeSchema: {
      data: {
        alerts: components['schemas']['BudgetAlertSchema'][];
      };
      meta: {
        requestId: string;
        /** @constant */
        schemaVersion: '1.0.0';
      };
    };
    BuildChannelPackageRequestSchema: {
      artifactId: components['schemas']['schema26'];
      artifactRevisionId: components['schemas']['schema26'];
      channelKey: string;
      expectedContentHash: components['schemas']['schema27'];
      revision: number;
    };
    ChangeMembershipRoleRequestSchema: {
      role: components['schemas']['TenantRoleSchema'];
    };
    ChannelAdapterVersionSchema: {
      adapterKey: string;
      adapterVersion: string;
      capabilities: components['schemas']['schema29'][];
      disabledReason: string | null;
      enabled: boolean;
      id: components['schemas']['schema28'];
      processingRegion: string;
      /** Format: date-time */
      providerApiSupportedUntil?: string;
      providerApiVersion?: string;
      ratePolicy: components['schemas']['schema31'];
      requiredScopes: components['schemas']['schema30'][];
      retentionPolicy: string;
      subprocessors: components['schemas']['schema31'][];
      /** @enum {string} */
      termsStatus: 'ALLOWED' | 'REVIEW_REQUIRED' | 'PROHIBITED';
      termsVersion: string;
      trainingPolicy: string;
    };
    ChannelAuthorizationEnvelopeSchema: {
      data: {
        authorization: components['schemas']['ChannelAuthorizationMetadataSchema'];
      };
      meta: components['schemas']['schema34'];
    };
    ChannelAuthorizationListEnvelopeSchema: {
      data: {
        authorizations: components['schemas']['ChannelAuthorizationMetadataSchema'][];
      };
      meta: components['schemas']['schema34'];
    };
    ChannelAuthorizationMetadataSchema: {
      acceptedTermsVersion: string;
      /** Format: uuid */
      adapterVersionId: string;
      /** Format: date-time */
      createdAt: string;
      expiresAt: string | null;
      grantedScopes: string[];
      /** Format: uuid */
      id: string;
      /** @constant */
      secretConfigured: true;
      /** @enum {string} */
      status: 'ACTIVE' | 'REVOKED';
      target: string;
      /** Format: date-time */
      updatedAt: string;
      validationFailureCode: string | null;
      validationSnapshot: {
        acceptedTermsVersion: string;
        actualScopes: components['schemas']['schema32'];
        actualTarget: string;
        /** Format: date-time */
        validatedAt: string;
        /** Format: date-time */
        validUntil: string;
      } | null;
      /** @enum {string} */
      validationStatus: 'PENDING_VALIDATION' | 'VERIFIED' | 'INVALID';
    };
    ChannelAuthorizationPathParamsSchema: {
      /** Format: uuid */
      authorizationId: string;
    };
    ChannelPackageArtifactSchema: {
      artifactId: components['schemas']['schema26'];
      artifactRevisionId: components['schemas']['schema26'];
      contentHash: components['schemas']['schema27'];
      locale: string;
      market: string;
      methodPolicyVersion: string;
      revision: number;
      /** @enum {string} */
      type: 'DEFINITION_PRODUCT' | 'COMPARISON' | 'TECHNICAL_EVIDENCE';
    };
    ChannelPackageClaimSourceMapEntrySchema: {
      claimContentHash: components['schemas']['schema27'];
      claimId: components['schemas']['schema26'];
      claimRevisionId: components['schemas']['schema26'];
      evidence: {
        snapshotId: components['schemas']['schema26'];
        sourceHash: components['schemas']['schema27'];
        sourceId: components['schemas']['schema26'];
      }[];
    };
    ChannelPackageDocumentSchema: {
      artifact: components['schemas']['ChannelPackageArtifactSchema'];
      channel: {
        channelKey: string;
        definitionId: components['schemas']['schema26'];
      };
      id: components['schemas']['schema26'];
      manifest: components['schemas']['ChannelPackageManifestSchema'];
      packageChecksum: components['schemas']['schema27'];
      packageRevision: number;
      preview: {
        html: string;
        jsonLd: {
          [key: string]: unknown;
        };
        markdown: string;
      };
      transformer: {
        key: string;
        version: string;
      };
    };
    ChannelPackageEnvelopeSchema: {
      data: {
        package: components['schemas']['ChannelPackageDocumentSchema'];
      };
      meta: {
        requestId: string;
        /** @constant */
        schemaVersion: '1.0.0';
      };
    };
    ChannelPackageExportSchema: {
      artifact: components['schemas']['ChannelPackageArtifactSchema'];
      channel: {
        channelKey: string;
        definitionId: components['schemas']['schema26'];
      };
      files: {
        'content.html': string;
        'content.md': string;
        'structured-data.json': string;
      } & {
        [key: string]: string;
      };
      id: components['schemas']['schema26'];
      manifest: components['schemas']['ChannelPackageManifestSchema'];
      packageChecksum: components['schemas']['schema27'];
      packageRevision: number;
      transformer: {
        key: string;
        version: string;
      };
    };
    ChannelPackageFileSchema: {
      byteLength: number;
      mediaType: string;
      path: string;
      sha256: components['schemas']['schema27'];
    };
    ChannelPackageManifestSchema: {
      assetRefs: string[];
      channelProfile?: components['schemas']['ChannelProfileSchema'];
      claimSourceMap: components['schemas']['ChannelPackageClaimSourceMapEntrySchema'][];
      files: components['schemas']['ChannelPackageFileSchema'][];
      schemaVersion: string;
    };
    ChannelProfileFieldRequirementSchema: {
      field: components['schemas']['schema39'];
      format: components['schemas']['schema44'];
      maxLength: components['schemas']['schema43'];
      minLength: components['schemas']['schema42'];
      required: components['schemas']['schema41'];
      sourcePointer: components['schemas']['schema40'];
    };
    ChannelProfileSchema: {
      channel: components['schemas']['schema35'];
      fieldRequirements: components['schemas']['schema38'];
      profileHash: components['schemas']['schema37'];
      profileVersion: components['schemas']['schema36'];
    };
    ChannelRegistryEntrySchema: {
      adapterVersions: components['schemas']['ChannelAdapterVersionSchema'][];
      channelKey: string;
      channelProfile?: components['schemas']['ChannelProfileSchema'] | null;
      displayName: string;
      id: components['schemas']['schema28'];
      packageSchemaVersion: string;
      packageTransformerKey: string;
      /** @enum {string} */
      status: 'AVAILABLE' | 'UNAVAILABLE' | 'DEPRECATED';
      unavailableReason: string | null;
    };
    ChannelRegistryEnvelopeSchema: {
      data: {
        entries: components['schemas']['ChannelRegistryEntrySchema'][];
      };
      meta: {
        requestId: string;
        /** @constant */
        schemaVersion: '1.0.0';
      };
    };
    CheckPublicationEligibilitySchema: {
      adapterVersionId?: components['schemas']['schema45'];
      channelPackageId: components['schemas']['schema45'];
      expectedPackageChecksum: components['schemas']['schema46'];
      target: string;
    };
    ClaimCurrentStateEnvelopeSchema: {
      data: {
        claim: components['schemas']['ClaimSchema'];
        currentUsable: boolean;
        reviewRequired: boolean;
        revision: components['schemas']['ClaimRevisionSchema'];
        staleReasons: ('SOURCE_CHANGED' | 'EXPIRED' | 'NOT_APPROVED')[];
      };
      meta: {
        requestId: string;
        /** @constant */
        schemaVersion: '1.0.0';
      };
    };
    ClaimEnvelopeSchema: {
      data: {
        claim: components['schemas']['ClaimSchema'];
        revision: components['schemas']['ClaimRevisionSchema'];
      };
      meta: {
        requestId: string;
        /** @constant */
        schemaVersion: '1.0.0';
      };
    };
    ClaimEvidenceDrillDownEnvelopeSchema: {
      data: {
        evidence: components['schemas']['ClaimEvidenceDrillDownSchema'][];
      };
      meta: {
        requestId: string;
        /** @constant */
        schemaVersion: '1.0.0';
      };
    };
    ClaimEvidenceDrillDownSchema: {
      link: components['schemas']['ClaimEvidenceLinkSchema'];
      snapshot: components['schemas']['EvidenceSnapshotSchema'];
      source: components['schemas']['EvidenceSourceSchema'];
    };
    ClaimEvidenceInputSchema: {
      /** Format: uuid */
      snapshotId: string;
      snippet: string | null;
    };
    ClaimEvidenceLinkSchema: {
      /** Format: uuid */
      id: string;
      /** Format: uuid */
      snapshotId: string;
      snippet: string | null;
      sourceHash: string | null;
    };
    ClaimReviewEnvelopeSchema: {
      data: {
        claim: components['schemas']['ClaimSchema'];
        review: components['schemas']['ClaimReviewSchema'];
        revision: components['schemas']['ClaimRevisionSchema'];
      };
      meta: {
        requestId: string;
        /** @constant */
        schemaVersion: '1.0.0';
      };
    };
    ClaimReviewSchema: {
      /** Format: uuid */
      claimRevisionId: string;
      contentHash: string;
      /** @enum {string} */
      decision: 'APPROVE' | 'REJECT';
      /** Format: uuid */
      id: string;
      note: string;
      /** Format: date-time */
      reviewedAt: string;
      /** Format: uuid */
      reviewerUserId: string;
    };
    ClaimRevisionSchema: {
      /** Format: uuid */
      claimId: string;
      conditions: components['schemas']['schema47'][];
      contentHash: string;
      /** Format: date-time */
      createdAt: string;
      /** Format: uuid */
      createdByUserId: string;
      evidence: components['schemas']['ClaimEvidenceLinkSchema'][];
      expiresAt: string | null;
      /** Format: uuid */
      id: string;
      numericValue: number | null;
      revision: number;
      scope: string | null;
      statement: string;
      /** @enum {string} */
      status: 'NEEDS_EVIDENCE' | 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED' | 'STALE';
      /** Format: uuid */
      tenantId: string;
      unit: string | null;
      /** Format: uuid */
      workspaceId: string;
    };
    ClaimSchema: {
      /** Format: date-time */
      createdAt: string;
      currentRevision: number;
      /** Format: uuid */
      id: string;
      /** Format: uuid */
      tenantId: string;
      /** Format: uuid */
      workspaceId: string;
    };
    CompletenessSummarySchema: {
      completedFields: number;
      missingFields: string[];
      percent: number;
      totalFields: number;
    };
    CompleteSiteVerificationRequestSchema: Record<string, never>;
    ContentPlanBundleEnvelopeSchema: {
      data: components['schemas']['ContentPlanBundleSchema'];
      meta: components['schemas']['schema3'];
    };
    ContentPlanBundleSchema: {
      briefReviews: components['schemas']['BriefReviewSchema'][];
      briefs: components['schemas']['BriefSchema'][];
      evidenceTasks: components['schemas']['EvidenceTaskSchema'][];
      opportunities: components['schemas']['OpportunitySchema'][];
      plan: components['schemas']['ContentPlanSchema'];
    };
    ContentPlanInputSnapshotSchema: {
      availableClaimRevisionIds: components['schemas']['schema1'][];
      availableSourceArtifactIds: components['schemas']['schema1'][];
      baselineId: components['schemas']['schema1'];
      comparisonClaimRevisionIds: components['schemas']['schema1'][];
      comparisonEvidenceIndependent: boolean;
      comparisonEvidenceSnapshotIds: components['schemas']['schema1'][];
      methodPolicyVersion: string;
      offering: components['schemas']['schema48'];
      offeringRevisionId: components['schemas']['schema1'];
      primaryClaimRevisionIds: components['schemas']['schema1'][];
      primaryEvidenceSnapshotIds: components['schemas']['schema1'][];
      profile: components['schemas']['schema48'];
      profileRevisionId: components['schemas']['schema1'];
      promptIds: components['schemas']['schema1'][];
      promptRevisionId: components['schemas']['schema1'];
      promptSetId: components['schemas']['schema1'];
    };
    ContentPlanSchema: {
      completedAt: string | null;
      contentHash: components['schemas']['schema2'] | null;
      /** Format: date-time */
      createdAt: string;
      createdByUserId: components['schemas']['schema1'];
      id: components['schemas']['schema1'];
      inputSnapshot: components['schemas']['ContentPlanInputSnapshotSchema'];
      jobId: components['schemas']['schema1'] | null;
      methodPolicyVersion: string;
      /** @enum {string} */
      status: 'PENDING' | 'READY' | 'INVALID';
      tenantId: components['schemas']['schema1'];
      workspaceId: components['schemas']['schema1'];
    };
    CrawlSnapshotSchema: {
      /** Format: date-time */
      capturedAt: string;
      checksum: string;
      contentType: string;
      /** Format: uuid */
      id: string;
      objectRef: string;
      sizeBytes: number;
      /** Format: uri */
      url: string;
    };
    CreateArtifactRevisionEnvelopeSchema: {
      data: {
        artifact: components['schemas']['ArtifactSchema'];
        revision: components['schemas']['ArtifactRevisionSchema'];
      };
      meta: components['schemas']['schema10'];
    };
    CreateArtifactRevisionRequestSchema: {
      expectedRevision: number;
      payload: components['schemas']['ArtifactPayloadSchema'];
    };
    CreateChannelAuthorizationRequestSchema: {
      acceptedTermsVersion: string;
      /** Format: uuid */
      adapterVersionId: string;
      expiresAt?: string | null;
      grantedScopes: components['schemas']['schema32'];
      secretArn: string;
      target: string;
    };
    CreateClaimRequestSchema: {
      conditions: components['schemas']['schema49'][];
      evidence: components['schemas']['ClaimEvidenceInputSchema'][];
      expiresAt: string | null;
      numericValue: number | null;
      scope: string | null;
      statement: string;
      unit: string | null;
    };
    CreatedSignedWebhookEndpointVerificationEnvelopeSchema: {
      data: {
        verification: {
          algorithm: components['schemas']['SignedWebhookSigningAlgorithmSchema'];
          challengeExpiresAt: components['schemas']['schema68'];
          channelDefinitionId: components['schemas']['schema64'];
          createdAt: components['schemas']['schema67'];
          endpointUrl: components['schemas']['SignedWebhookUrlSchema'];
          id: components['schemas']['schema64'];
          keyId: components['schemas']['SignedWebhookKeyIdSchema'];
          proofs: components['schemas']['schema71'];
          receiptUrl: components['schemas']['SignedWebhookUrlSchema'];
          revokedAt: components['schemas']['schema70'];
          status: components['schemas']['schema66'];
          verificationReference: components['schemas']['schema65'];
          verifiedAt: components['schemas']['schema69'];
        };
      };
      meta: components['schemas']['schema73'];
    };
    CreateEvidenceSnapshotRequestSchema: {
      contentBase64: string;
      contentType: string;
    };
    CreateEvidenceSourceRequestSchema: {
      license: string;
      /** @enum {string} */
      publicity: 'PRIVATE' | 'PUBLIC' | 'RESTRICTED';
      /** @enum {string} */
      sourceType: 'UPLOAD' | 'CRAWL' | 'PUBLIC';
      title: string;
      uri: string | null;
    };
    CreateExperimentRequestSchema: {
      baselineRunId: components['schemas']['schema50'];
      idempotencyKey: components['schemas']['schema53'];
      intervention: components['schemas']['ExperimentInterventionRequestSchema'];
      remeasurementRunId: components['schemas']['schema51'];
    };
    CreateLegalHoldRequestSchema: {
      name: string;
      objectKey: components['schemas']['schema14'];
      objectVersionId: string;
      reason: components['schemas']['schema20'];
    };
    CreatePromptRevisionRequestSchema: {
      expectedRevision: number;
      prompts: components['schemas']['PromptDraftSchema'][];
      scenario: components['schemas']['MeasurementScenarioInputSchema'];
      scopes: components['schemas']['PromptScopeSchema'][];
    };
    CreateSignedWebhookEndpointVerificationRequestSchema: {
      algorithm: components['schemas']['SignedWebhookSigningAlgorithmSchema'];
      channelDefinitionId: components['schemas']['schema64'];
      endpointUrl: components['schemas']['SignedWebhookUrlSchema'];
      keyId: components['schemas']['SignedWebhookKeyIdSchema'];
      receiptUrl: components['schemas']['SignedWebhookUrlSchema'];
      verificationReference: components['schemas']['schema65'];
    };
    CreateSiteRequestSchema: {
      /** Format: uri */
      origin: string;
      /** Format: uuid */
      profileId: string;
    };
    CreateSiteVerificationRequestSchema: {
      /** @enum {string} */
      method: 'DNS' | 'FILE' | 'OAUTH' | 'ADMIN';
    };
    CreateTenantEnvelopeSchema: {
      data: {
        membership: {
          /** Format: uuid */
          id: string;
          role: components['schemas']['TenantRoleSchema'];
          /** @enum {string} */
          status: 'PENDING' | 'ACTIVE' | 'REVOKED';
          /** Format: uuid */
          tenantId: string;
          /** Format: uuid */
          userId: string;
          /** Format: uuid */
          workspaceId: string;
        };
        tenant: {
          /** Format: uuid */
          id: string;
          name: string;
        };
        workspace: {
          /** Format: uuid */
          id: string;
          name: string;
          /** Format: uuid */
          tenantId: string;
        };
      };
      meta: {
        requestId: string;
        /** @constant */
        schemaVersion: '1.0.0';
      };
    };
    CreateTenantRequestSchema: {
      tenantName: string;
      workspaceName: string;
    };
    DashboardCohortSchema: {
      /** @enum {string} */
      acquisitionClass:
        'CONSUMER_UI_SAMPLE' | 'MODEL_API_DIAGNOSTIC' | 'SEARCH_DATA_API' | 'MANUAL_IMPORT';
      acquisitionMethod: string;
      adapterKey: string;
      adapterVersion: string;
      model: string;
      modelVersion: string;
      providerKey: string;
      /** Format: uuid */
      scenarioId: string;
      scenarioVersion: number;
      scopeKey: string;
      surfaceKey: string;
    };
    DashboardMetricSchema: {
      cohort: components['schemas']['DashboardCohortSchema'];
      contentHash: string;
      eligibleDenominator: number;
      excludedCounts: components['schemas']['ExcludedCountsSchema'];
      /** Format: uuid */
      id: string;
      methodVersion: string;
      /** @enum {string} */
      metricKey: 'MENTION_RATE' | 'CITATION_RATE' | 'ACCURACY_RATE' | 'COVERAGE_RATE';
      numerator: number;
      promptRunIds: string[];
      sourceHash: string;
      value: number | null;
    };
    /** @enum {string} */
    DeletionLifecycleStateSchema:
      'FROZEN' | 'ACTIVE_DATA_DELETED' | 'BACKUP_DELETED' | 'TOMBSTONED' | 'BLOCKED_BY_LEGAL_HOLD';
    /** @enum {string} */
    DeletionScopeSchema: 'TENANT' | 'WORKSPACE';
    DynamicAttributeSchema:
      | {
          key: components['schemas']['schema74'];
          label: components['schemas']['schema75'];
          required: components['schemas']['schema76'];
          value: string;
          /** @constant */
          valueType: 'text';
        }
      | {
          key: components['schemas']['schema74'];
          label: components['schemas']['schema75'];
          required: components['schemas']['schema76'];
          value: number;
          /** @constant */
          valueType: 'number';
        }
      | {
          key: components['schemas']['schema74'];
          label: components['schemas']['schema75'];
          required: components['schemas']['schema76'];
          value: boolean;
          /** @constant */
          valueType: 'boolean';
        }
      | {
          key: components['schemas']['schema74'];
          label: components['schemas']['schema75'];
          required: components['schemas']['schema76'];
          /** Format: uri */
          value: string;
          /** @constant */
          valueType: 'url';
        }
      | {
          key: components['schemas']['schema74'];
          label: components['schemas']['schema75'];
          required: components['schemas']['schema76'];
          value: components['schemas']['schema77'][];
          /** @constant */
          valueType: 'string_list';
        };
    EvidenceSnapshotEnvelopeSchema: {
      data: {
        snapshot: components['schemas']['EvidenceSnapshotSchema'];
        source: components['schemas']['EvidenceSourceSchema'];
      };
      meta: {
        requestId: string;
        /** @constant */
        schemaVersion: '1.0.0';
      };
    };
    EvidenceSnapshotSchema: {
      /** Format: date-time */
      capturedAt: string;
      contentHash: string;
      contentType: string;
      /** Format: uuid */
      id: string;
      objectRef: string;
      objectVersionId: string;
      sizeBytes: number;
      /** Format: uuid */
      sourceId: string;
      /** Format: uuid */
      tenantId: string;
      /** Format: uuid */
      workspaceId: string;
    };
    EvidenceSourceEnvelopeSchema: {
      data: {
        source: components['schemas']['EvidenceSourceSchema'];
      };
      meta: {
        requestId: string;
        /** @constant */
        schemaVersion: '1.0.0';
      };
    };
    EvidenceSourceSchema: {
      /** Format: date-time */
      createdAt: string;
      currentSnapshotId: string | null;
      /** Format: uuid */
      id: string;
      license: string;
      /** @enum {string} */
      publicity: 'PRIVATE' | 'PUBLIC' | 'RESTRICTED';
      /** @enum {string} */
      sourceType: 'UPLOAD' | 'CRAWL' | 'PUBLIC';
      /** Format: uuid */
      tenantId: string;
      title: string;
      uri: string | null;
      /** Format: uuid */
      workspaceId: string;
    };
    EvidenceTaskSchema: {
      /** @enum {string} */
      assetKind: 'DEFINITION_PRODUCT' | 'COMPARISON' | 'TECHNICAL_EVIDENCE';
      contentPlanId: components['schemas']['schema1'];
      detail: string;
      id: components['schemas']['schema1'];
      /** @enum {string} */
      key: 'DEFINITION_PRODUCT' | 'COMPARISON' | 'TECHNICAL_EVIDENCE';
      opportunityId: components['schemas']['schema1'];
      /** @enum {string} */
      reasonCode: 'PRIMARY_CLAIM_EVIDENCE_REQUIRED' | 'INDEPENDENT_COMPARISON_EVIDENCE_REQUIRED';
    };
    ExcludedCountsSchema: {
      ERROR: number;
      INCONCLUSIVE: number;
      NOT_APPLICABLE: number;
      NOT_CHECKED: number;
    };
    ExperimentCompatibleCombinationSchema: {
      /** Format: uuid */
      baselineRunId: string;
      intervention: components['schemas']['ExperimentInterventionOptionSchema'];
      /** Format: uuid */
      remeasurementRunId: string;
    };
    ExperimentEnvelopeSchema: {
      data: {
        experiment: components['schemas']['ExperimentSchema'];
      };
      meta: components['schemas']['schema101'];
    };
    ExperimentInterventionOptionSchema:
      | {
          artifactContentHash: components['schemas']['schema52'];
          /** Format: uuid */
          artifactId: string;
          /** Format: uuid */
          artifactReviewId: string;
          /** Format: uuid */
          artifactRevisionId: string;
          /** Format: uuid */
          channelPackageId: string;
          /** @constant */
          kind: 'PUBLISHED_PUBLICATION';
          /** Format: date-time */
          observedAt: string;
          /** Format: uuid */
          publicationAttemptId: string;
          /** Format: uuid */
          publicationRecordId: string;
        }
      | {
          artifactContentHash: components['schemas']['schema52'];
          /** Format: uuid */
          artifactId: string;
          /** Format: uuid */
          artifactReviewId: string;
          /** Format: uuid */
          artifactRevisionId: string;
          /** @constant */
          kind: 'APPROVED_ARTIFACT';
          /** Format: date-time */
          observedAt: string;
        };
    ExperimentInterventionRequestSchema:
      | {
          artifactContentHash: components['schemas']['schema52'];
          /** Format: uuid */
          artifactId: string;
          /** Format: uuid */
          artifactReviewId: string;
          /** Format: uuid */
          artifactRevisionId: string;
          /** Format: uuid */
          channelPackageId: string;
          /** @constant */
          kind: 'PUBLISHED_PUBLICATION';
          /** Format: date-time */
          observedAt: string;
          /** Format: uuid */
          publicationAttemptId: string;
          /** Format: uuid */
          publicationRecordId: string;
        }
      | {
          artifactContentHash: components['schemas']['schema52'];
          /** Format: uuid */
          artifactId: string;
          /** Format: uuid */
          artifactReviewId: string;
          /** Format: uuid */
          artifactRevisionId: string;
          /** @constant */
          kind: 'APPROVED_ARTIFACT';
          /** Format: date-time */
          observedAt: string;
        };
    ExperimentInterventionSchema:
      | {
          /** @constant */
          applicationState: 'PUBLISHED';
          artifactContentHash: components['schemas']['schema52'];
          /** Format: uuid */
          artifactId: string;
          /** Format: uuid */
          artifactReviewId: string;
          /** Format: uuid */
          artifactRevisionId: string;
          /** Format: uuid */
          channelPackageId: string;
          href: string;
          /** @constant */
          kind: 'PUBLISHED_PUBLICATION';
          /** Format: date-time */
          observedAt: string;
          /** Format: uuid */
          publicationAttemptId: string;
          /** Format: uuid */
          publicationRecordId: string;
        }
      | {
          /** @constant */
          applicationDisclosure: 'Approval is a recorded review event, not proof of external application or causation.';
          /** @constant */
          applicationState: 'APPROVED_NOT_PUBLISHED';
          artifactContentHash: components['schemas']['schema52'];
          /** Format: uuid */
          artifactId: string;
          /** Format: uuid */
          artifactReviewId: string;
          /** Format: uuid */
          artifactRevisionId: string;
          href: string;
          /** @constant */
          kind: 'APPROVED_ARTIFACT';
          /** Format: date-time */
          observedAt: string;
        };
    ExperimentMeasurementContextSchema: {
      model: string;
      modelVersion: string;
      providerKey: string;
      /** Format: uuid */
      scenarioId: string;
      scenarioVersion: number;
      surfaceKey: string;
      readonly timeline: {
        baseline: components['schemas']['schema85'];
        remeasurement: components['schemas']['schema85'];
      };
    };
    ExperimentMetricComparisonSchema: {
      baseline: components['schemas']['ExperimentSnapshotSummarySchema'];
      caveat: string;
      compatibilityHash: components['schemas']['schema52'];
      compatibilityKey: string;
      costBreakdown: {
        baseline: components['schemas']['MonetaryCostSchema'][];
        remeasurement: components['schemas']['MonetaryCostSchema'][];
      };
      delta: {
        eligibleDenominator: number;
        numerator: number;
        value: number | null;
      };
      /** @enum {string} */
      metricKey: 'MENTION_RATE' | 'CITATION_RATE' | 'ACCURACY_RATE' | 'COVERAGE_RATE';
      noGuarantee: string;
      observedAssociation: string;
      remeasurement: components['schemas']['ExperimentSnapshotSummarySchema'];
      scopeKey: string;
    };
    ExperimentOptionsEnvelopeSchema: {
      data: {
        options: {
          baselineRuns: components['schemas']['ExperimentRunOptionSchema'][];
          compatibleCombinations: components['schemas']['ExperimentCompatibleCombinationSchema'][];
          interventions: components['schemas']['ExperimentInterventionOptionSchema'][];
          remeasurementRuns: components['schemas']['ExperimentRunOptionSchema'][];
        };
      };
      meta: components['schemas']['schema101'];
    };
    ExperimentRunOptionSchema: {
      /** Format: date-time */
      completedAt: string;
      /** Format: uuid */
      id: string;
      /** @enum {string} */
      kind: 'BASELINE' | 'REMEASUREMENT';
      model: string;
      modelVersion: string;
      providerKey: string;
      /** Format: uuid */
      scenarioId: string;
      scenarioVersion: number;
      surfaceKey: string;
    };
    ExperimentSchema: {
      baselineRunId: components['schemas']['schema82'];
      caveat: components['schemas']['schema96'];
      comparisons: components['schemas']['schema90'];
      costBreakdown: components['schemas']['schema94'];
      createdAt: components['schemas']['schema100'];
      createdByUserId: components['schemas']['schema99'];
      drillDown: components['schemas']['schema98'];
      excludedCounts: components['schemas']['schema93'];
      id: components['schemas']['schema78'];
      intervention: components['schemas']['ExperimentInterventionSchema'];
      measurementContext: components['schemas']['ExperimentMeasurementContextSchema'];
      noGuarantee: components['schemas']['schema97'];
      observedAssociation: components['schemas']['schema95'];
      remeasurementRunId: components['schemas']['schema83'];
      sample: components['schemas']['schema92'];
      scenarioVersion: components['schemas']['schema84'];
      schemaVersion: components['schemas']['schema81'];
      tenantId: components['schemas']['schema79'];
      workspaceId: components['schemas']['schema80'];
    };
    ExperimentSnapshotSummarySchema: {
      contentHash: components['schemas']['schema52'];
      eligibleDenominator: number;
      excludedCounts: components['schemas']['schema91'];
      numerator: number;
      sampleSize: number;
      /** Format: uuid */
      snapshotId: string;
      value: number | null;
    };
    ExportOnlyPublicationProblemSchema: {
      /** @constant */
      code: 'EXPORT_ONLY';
      detail: string;
      eligibility: {
        /** @constant */
        mode: 'EXPORT_ONLY';
        packageChecksum: components['schemas']['schema46'];
        packageId: components['schemas']['schema45'];
        reasons: components['schemas']['PublicationEligibilityReasonSchema'][];
      };
      export: {
        href: string;
        packageChecksum: components['schemas']['schema46'];
      };
      requestId: string;
      /** @constant */
      retryable: false;
      /** @constant */
      status: 409;
      title: string;
      /** Format: uri */
      type: string;
    };
    ExportTenantRequestSchema: {
      from: components['schemas']['schema12'];
      to: components['schemas']['schema12'];
    } & components['schemas']['PrivacyTimeRangeSchema'];
    GitPullRequestTargetV1Schema: {
      baseBranch: string;
      installationId: string;
      pathPrefix: string;
      /** @constant */
      provider: 'GITHUB';
      repository: string;
      /** @constant */
      schemaVersion: 'git-pr-target.v1';
    };
    GrantBreakGlassRequestSchema: {
      expiresAt: components['schemas']['schema12'];
      reason: components['schemas']['schema20'];
      requestedAction: components['schemas']['schema22'];
      resourceId: components['schemas']['schema24'];
      resourceType: components['schemas']['schema23'];
    };
    HealthEnvelopeSchema: {
      data: {
        /** @enum {string} */
        status: 'alive' | 'ready';
      };
      meta: {
        requestId: string;
        /** @constant */
        schemaVersion: '1.0.0';
      };
    };
    IncompatibleExperimentSchema: {
      baselineCompatibilityKeys: string[];
      caveat: string;
      /** @enum {string} */
      decision: 'REBASELINE' | 'STRATIFY';
      differingFields: components['schemas']['schema102'][];
      /** @constant */
      outcome: 'INCOMPATIBLE_SCENARIO';
      remeasurementCompatibilityKeys: string[];
    };
    InviteMembershipRequestSchema: {
      /** Format: email */
      email: string;
      role: components['schemas']['TenantRoleSchema'];
    };
    JobEnvelopeSchema: {
      data: {
        job: components['schemas']['JobSchema'];
      };
      meta: {
        requestId: string;
        /** @constant */
        schemaVersion: '1.0.0';
      };
    };
    JobSchema: {
      /** Format: uuid */
      aggregateId: string;
      attempt: number;
      budgetWarning: boolean;
      errorCode: string | null;
      estimatedUnits: number;
      heartbeatAt: string | null;
      /** Format: uuid */
      id: string;
      /** @enum {string} */
      jobType:
        | 'PROFILE_READINESS'
        | 'SITE_CRAWL'
        | 'CONTENT_PLAN'
        | 'ARTIFACT_GENERATION'
        | 'PUBLICATION'
        | 'MEASUREMENT';
      maxAttempts: number;
      progress: number;
      providerKey: components['schemas']['ProviderKeySchema'] | null;
      result: {
        [key: string]: unknown;
      } | null;
      status: components['schemas']['JobStatusSchema'];
      /** Format: uuid */
      tenantId: string;
      /** Format: uuid */
      workspaceId: string;
    };
    /** @enum {string} */
    JobStatusSchema:
      | 'BUDGET_BLOCKED'
      | 'QUEUED'
      | 'RUNNING'
      | 'RETRY_WAIT'
      | 'SUCCEEDED'
      | 'FAILED_TERMINAL'
      | 'CANCELLED';
    LegalHoldEnvelopeSchema: {
      data: {
        hold: components['schemas']['TenantVisibleLegalHoldSchema'];
      };
      meta: components['schemas']['schema15'];
    };
    LegalHoldListEnvelopeSchema: {
      data: {
        holds: components['schemas']['TenantVisibleLegalHoldSchema'][];
      };
      meta: components['schemas']['schema15'];
    };
    LegalHoldTargetSchema: {
      objectKey: components['schemas']['schema14'];
      objectVersionId: string;
    };
    LocaleSchema: string;
    ManualMeasurementImportDetailEnvelopeSchema: {
      data: {
        manualImport: components['schemas']['ManualMeasurementImportSchema'];
        slots: components['schemas']['ManualMeasurementImportSlotManifestSchema'][];
      };
      meta: components['schemas']['schema115'];
    };
    ManualMeasurementImportEntrySchema: {
      /** Format: date-time */
      observedAt: string;
      /** Format: uuid */
      promptId: string;
      repetition: number;
      result: {
        cost: components['schemas']['MonetaryCostSchema'];
        observation: components['schemas']['MeasurementObservationSchema'];
        rawEvidence: components['schemas']['schema109'];
        status: components['schemas']['PromptRunStatusSchema'];
      };
      scope: components['schemas']['MeasurementScopeSchema'];
    };
    ManualMeasurementImportEnvelopeSchema: {
      data: {
        manualImport: components['schemas']['ManualMeasurementImportSchema'];
      };
      meta: components['schemas']['schema115'];
    };
    ManualMeasurementImportSchema: {
      /** @constant */
      acquisitionClass: 'MANUAL_IMPORT';
      /** @constant */
      acquisitionMethod: 'MANUAL_IMPORT';
      adapterVersion: string;
      contentHash: string;
      costCurrency: string;
      expectedSlotCount: number;
      /** Format: uuid */
      id: string;
      promptContentHash: string;
      /** Format: uuid */
      promptRevisionId: string;
      /** Format: uuid */
      promptSetId: string;
      providedSlotCount: number;
      providerKey: string;
      reviewedAt: string | null;
      reviewedByUserId: string | null;
      reviewNote: string | null;
      scenarioContentHash: string;
      /** Format: uuid */
      scenarioId: string;
      /** @constant */
      schemaVersion: 'measurement-manual-import.v1';
      /** @enum {string} */
      status: 'SUBMITTED' | 'APPROVED' | 'REJECTED';
      /** Format: date-time */
      submittedAt: string;
      /** Format: uuid */
      submittedByUserId: string;
      surfaceKey: string;
      /** Format: uuid */
      tenantId: string;
      /** Format: uuid */
      workspaceId: string;
    };
    ManualMeasurementImportSlotManifestSchema: {
      contentHash: components['schemas']['schema114'];
      observedAt: components['schemas']['schema107'];
      prompt: components['schemas']['schema103'];
      provided: components['schemas']['schema106'];
      rawEvidenceContentHash: components['schemas']['schema113'];
      repetition: components['schemas']['schema105'];
      result: components['schemas']['schema108'];
      scope: components['schemas']['MeasurementScopeSchema'];
      scopeKey: components['schemas']['schema104'];
    };
    MarketSchema: string;
    /** @enum {string} */
    MeasurementAcquisitionClassSchema:
      'CONSUMER_UI_SAMPLE' | 'MODEL_API_DIAGNOSTIC' | 'SEARCH_DATA_API' | 'MANUAL_IMPORT';
    MeasurementDashboardEnvelopeSchema: {
      data: {
        cost: components['schemas']['schema124'];
        costBreakdown: components['schemas']['schema123'];
        resultCounts: components['schemas']['MeasurementResultCountsSchema'];
        sections: components['schemas']['schema119'];
        snapshot: components['schemas']['schema118'];
      };
      meta: components['schemas']['schema115'];
    };
    MeasurementObservationSchema: {
      accuracy: ('MATCH' | 'MISMATCH' | 'NOT_APPLICABLE') | null;
      citation: boolean | null;
      coverage: boolean | null;
      mention: boolean | null;
    };
    MeasurementPromptRunListEnvelopeSchema: {
      data: {
        promptRuns: components['schemas']['PromptRunSchema'][];
      };
      meta: {
        limit: number;
        nextOffset: number | null;
        offset: number;
        requestId: components['schemas']['schema116'];
        schemaVersion: components['schemas']['schema117'];
        total: number;
      };
    };
    MeasurementPromptRunListQuerySchema: {
      /** @enum {string} */
      dimension?:
        'MENTION_RATE' | 'CITATION_RATE' | 'ACCURACY_RATE' | 'COVERAGE_RATE' | 'COST' | 'ERROR';
      /** @default 100 */
      limit: number;
      /** @default 0 */
      offset: number;
      scopeKey?: string;
    };
    /** @enum {string} */
    MeasurementProviderPolicyEligibilityReasonSchema:
      | 'POLICY_MISSING'
      | 'ADAPTER_UNAVAILABLE'
      | 'ADAPTER_VERSION_MISMATCH'
      | 'TERMS_VERSION_MISMATCH'
      | 'TERMS_NOT_APPROVED'
      | 'AUTHORIZATION_NOT_APPROVED'
      | 'CROSS_BORDER_NOT_APPROVED';
    MeasurementProviderPolicyEnvelopeSchema: {
      data: {
        policy: components['schemas']['MeasurementProviderPolicySchema'];
      };
      meta: components['schemas']['schema115'];
    };
    MeasurementProviderPolicyRequestSchema: {
      adapterVersion: string;
      authorizationApproved: boolean;
      crossBorderApproved: boolean;
      policyVersion: string;
      purpose: string;
      termsApproved: boolean;
      termsVersion: string;
    };
    MeasurementProviderPolicySchema: {
      adapterVersion: string;
      /** Format: date-time */
      approvedAt: string;
      /** Format: uuid */
      approvedByUserId: string;
      authorizationApproved: boolean;
      crossBorderApproved: boolean;
      /** Format: uuid */
      id: string;
      policyVersion: string;
      providerKey: string;
      purpose: string;
      surfaceKey: string;
      /** Format: uuid */
      tenantId: string;
      termsApproved: boolean;
      termsVersion: string;
      /** Format: uuid */
      workspaceId: string;
    };
    MeasurementProviderPolicyStateEnvelopeSchema: {
      data: {
        state: components['schemas']['MeasurementProviderPolicyStateSchema'];
      };
      meta: components['schemas']['schema115'];
    };
    MeasurementProviderPolicyStateSchema: {
      eligible: boolean;
      policy: components['schemas']['MeasurementProviderPolicySchema'] | null;
      providerKey: string;
      reasons: components['schemas']['MeasurementProviderPolicyEligibilityReasonSchema'][];
      requiredAdapterVersion: string;
      requiredTermsVersion: string | null;
      requiresAuthorization: boolean;
      surfaceKey: string;
    };
    MeasurementResultCountsSchema: {
      ERROR: number;
      FAIL: number;
      INCONCLUSIVE: number;
      NOT_APPLICABLE: number;
      NOT_CHECKED: number;
      PASS: number;
    };
    MeasurementRunEnvelopeSchema: {
      data: {
        measurementRun: components['schemas']['MeasurementRunSchema'];
      };
      meta: components['schemas']['schema115'];
    };
    /** @enum {string} */
    MeasurementRunKindSchema: 'BASELINE' | 'REMEASUREMENT';
    MeasurementRunSchema: {
      /** @enum {string} */
      acquisitionClass:
        'CONSUMER_UI_SAMPLE' | 'MODEL_API_DIAGNOSTIC' | 'SEARCH_DATA_API' | 'MANUAL_IMPORT';
      acquisitionMethod: string;
      adapterVersion: string;
      completedAt: string | null;
      completedPromptRunCount: number;
      /** Format: date-time */
      createdAt: string;
      expectedPromptRunCount: number;
      /** Format: uuid */
      id: string;
      jobId: string | null;
      kind: components['schemas']['MeasurementRunKindSchema'];
      model: string;
      modelVersion: string;
      /** Format: uuid */
      promptRevisionId: string;
      providerKey: string;
      /** Format: uuid */
      scenarioId: string;
      scenarioSnapshot: components['schemas']['ScenarioSnapshotSchema'];
      scenarioVersion: number;
      startedAt: string | null;
      status: components['schemas']['MeasurementRunStatusSchema'];
      surfaceKey: string;
      /** Format: uuid */
      tenantId: string;
      /** Format: uuid */
      workspaceId: string;
    };
    /** @enum {string} */
    MeasurementRunStatusSchema:
      'QUEUED' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'ERROR' | 'CANCELLED';
    MeasurementScenarioInputSchema: {
      account: components['schemas']['schema58'];
      acquisitionMethod: components['schemas']['schema59'];
      freshSession: components['schemas']['schema60'];
      model: components['schemas']['schema56'];
      modelVersion: components['schemas']['schema57'];
      parameters: components['schemas']['schema62'];
      providerKey: components['schemas']['schema54'];
      repetitions: components['schemas']['schema63'];
      searchEnabled: components['schemas']['schema61'];
      surfaceKey: components['schemas']['schema55'];
    };
    MeasurementScenarioSchema: {
      account: components['schemas']['schema58'];
      acquisitionMethod: components['schemas']['schema59'];
      contentHash: components['schemas']['schema0'];
      /** Format: date-time */
      createdAt: string;
      freshSession: components['schemas']['schema60'];
      id: components['schemas']['schema4'];
      model: components['schemas']['schema56'];
      modelVersion: components['schemas']['schema57'];
      parameters: components['schemas']['schema62'];
      promptRevisionId: components['schemas']['schema4'];
      providerKey: components['schemas']['schema54'];
      /** @enum {string} */
      registryStatus: 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';
      repetitions: components['schemas']['schema63'];
      searchEnabled: components['schemas']['schema61'];
      surfaceKey: components['schemas']['schema55'];
      version: number;
    };
    MeasurementScopeSchema: {
      locale: string;
      market: string;
      region: string;
    };
    MeasurementSurfaceAdapterDescriptorSchema: {
      acquisitionClass: components['schemas']['MeasurementAcquisitionClassSchema'];
      acquisitionMethod: string;
      adapterKey: components['schemas']['schema125'];
      adapterVersion: components['schemas']['schema126'];
      processingRegion: components['schemas']['schema130'];
      providerKey: components['schemas']['schema127'];
      requiresAuthorization: boolean;
      retentionPolicy: components['schemas']['schema132'];
      storageRegion: components['schemas']['schema131'];
      subprocessors: components['schemas']['schema134'];
      surfaceKey: components['schemas']['schema128'];
      /** @enum {string} */
      surfaceKind: 'SEARCH_DATA' | 'CONSUMER_SEARCH' | 'CONSUMER_AI_ANSWER';
      termsVersion: components['schemas']['schema129'];
      trainingPolicy: components['schemas']['schema133'];
    };
    MembershipEnvelopeSchema: {
      data: {
        membership: {
          /** Format: email */
          email: string;
          /** Format: uuid */
          id: string;
          role: components['schemas']['TenantRoleSchema'];
          /** @enum {string} */
          status: 'PENDING' | 'ACTIVE' | 'REVOKED';
          /** Format: uuid */
          tenantId: string;
          /** Format: uuid */
          userId: string;
          /** Format: uuid */
          workspaceId: string;
        };
      };
      meta: {
        requestId: string;
        /** @constant */
        schemaVersion: '1.0.0';
      };
    };
    MonetaryCostSchema: {
      amount: string;
      currency: string;
    };
    OfferingEnvelopeSchema: {
      data: {
        offering: components['schemas']['OfferingRevisionSchema'];
      };
      meta: {
        requestId: string;
        /** @constant */
        schemaVersion: '1.0.0';
      };
    };
    OfferingInputSchema: {
      applicationScenarios: components['schemas']['schema143'];
      attributes: components['schemas']['schema145'];
      compatibility: components['schemas']['schema143'];
      evidenceHints: components['schemas']['schema143'];
      features: components['schemas']['schema143'];
      kind: components['schemas']['schema136'];
      locale: components['schemas']['LocaleSchema'];
      market: components['schemas']['MarketSchema'];
      name: components['schemas']['schema137'];
      principle?: components['schemas']['schema140'];
      specifications: components['schemas']['schema141'];
      taxonomy: components['schemas']['schema138'];
      usage: components['schemas']['schema143'];
    };
    OfferingListEnvelopeSchema: {
      data: {
        offerings: {
          completeness: components['schemas']['CompletenessSummarySchema'];
          currentRevision: number;
          /** Format: uuid */
          id: string;
          kind: string;
          locale: string;
          market: string;
          name: string;
          /** Format: uuid */
          profileId: string;
        }[];
      };
      meta: {
        requestId: string;
        /** @constant */
        schemaVersion: '1.0.0';
      };
    };
    OfferingRevisionSchema: {
      applicationScenarios: components['schemas']['schema143'];
      attributes: components['schemas']['schema145'];
      compatibility: components['schemas']['schema143'];
      completeness: components['schemas']['CompletenessSummarySchema'];
      contentHash: string;
      evidenceHints: components['schemas']['schema143'];
      features: components['schemas']['schema143'];
      /** Format: uuid */
      id: string;
      kind: components['schemas']['schema136'];
      locale: components['schemas']['LocaleSchema'];
      market: components['schemas']['MarketSchema'];
      name: components['schemas']['schema137'];
      /** Format: uuid */
      offeringId: string;
      principle?: components['schemas']['schema140'];
      /** Format: uuid */
      profileId: string;
      revision: number;
      specifications: components['schemas']['schema141'];
      taxonomy: components['schemas']['schema138'];
      /** Format: uuid */
      tenantId: string;
      usage: components['schemas']['schema143'];
      /** Format: uuid */
      workspaceId: string;
    };
    OpportunitySchema: {
      /** @enum {string} */
      action: 'BRIEF' | 'EVIDENCE_TASK';
      /** @enum {string} */
      assetKind: 'DEFINITION_PRODUCT' | 'COMPARISON' | 'TECHNICAL_EVIDENCE';
      businessValue: number;
      contentPlanId: components['schemas']['schema1'];
      effort: number;
      evidenceReadiness: number;
      evidenceReady: boolean;
      id: components['schemas']['schema1'];
      /** @enum {string} */
      key: 'DEFINITION_PRODUCT' | 'COMPARISON' | 'TECHNICAL_EVIDENCE';
      priorityScore: number;
      /** @constant */
      publishReady: false;
      rank: number;
      rankReason: string;
      risk: number;
      visibilityGap: {
        reason: string;
        /** @constant */
        status: 'UNKNOWN';
      };
    };
    PrivacyOverviewEnvelopeSchema: {
      data: {
        overview: components['schemas']['PrivacyOverviewSchema'];
      };
      meta: components['schemas']['schema15'];
    };
    PrivacyOverviewSchema: {
      breakGlassGrants: components['schemas']['BreakGlassGrantSchema'][];
      latestAuditEventAt: components['schemas']['schema12'] | null;
      latestDeletionReceipt: components['schemas']['TenantDeletionReceiptSchema'] | null;
      legalHolds: components['schemas']['TenantVisibleLegalHoldSchema'][];
      /** @enum {string} */
      lifecycleState: 'ACTIVE' | 'FROZEN' | 'DELETION_IN_PROGRESS' | 'TOMBSTONED';
      retention: {
        /** @constant */
        activeTenantDataDays: 30;
        /** @constant */
        applicationLogDays: 30;
        /** @constant */
        auditEvidenceDays: 365;
        /** @constant */
        backupCopyDays: 90;
        /** @constant */
        rawEvidenceDays: 180;
        /** @constant */
        screenshotDays: 90;
        /** @constant */
        secretForceDeleteHours: 24;
      };
      tenantId: components['schemas']['schema11'];
    };
    PrivacyTimeRangeSchema: {
      from: components['schemas']['schema12'];
      to: components['schemas']['schema12'];
    };
    ProblemDetailsSchema: {
      code: string;
      detail: string;
      requestId: string;
      retryable: boolean;
      status: number;
      title: string;
      /** Format: uri */
      type: string;
    } & {
      [key: string]: unknown;
    };
    ProfileEnvelopeSchema: {
      data: {
        profile: components['schemas']['ProfileRevisionSchema'];
      };
      meta: {
        requestId: string;
        /** @constant */
        schemaVersion: '1.0.0';
      };
    };
    ProfileInputSchema: {
      description?: components['schemas']['schema148'];
      digitalAssets: components['schemas']['schema149'];
      displayName: components['schemas']['schema147'];
      targetMarkets: components['schemas']['schema151'];
    };
    ProfileListEnvelopeSchema: {
      data: {
        profiles: {
          completeness: components['schemas']['CompletenessSummarySchema'];
          currentRevision: number;
          displayName: string;
          /** Format: uuid */
          id: string;
        }[];
      };
      meta: {
        requestId: string;
        /** @constant */
        schemaVersion: '1.0.0';
      };
    };
    ProfileRevisionSchema: {
      completeness: components['schemas']['CompletenessSummarySchema'];
      contentHash: string;
      description?: components['schemas']['schema148'];
      digitalAssets: components['schemas']['schema149'];
      displayName: components['schemas']['schema147'];
      /** Format: uuid */
      id: string;
      /** Format: uuid */
      profileId: string;
      revision: number;
      targetMarkets: components['schemas']['schema151'];
      /** Format: uuid */
      tenantId: string;
      /** Format: uuid */
      workspaceId: string;
    };
    PromptApprovalIssueSchema: {
      /** @enum {string} */
      code:
        | 'PROMPT_COUNT'
        | 'PROMPT_TEXT'
        | 'PROMPT_TAXONOMY'
        | 'SCOPE_COUNT'
        | 'SCOPE_MARKET'
        | 'SCOPE_LOCALE'
        | 'SCOPE_REGION'
        | 'REPETITIONS'
        | 'SURFACE_NOT_REGISTERED'
        | 'SURFACE_ACQUISITION_METHOD';
      message: string;
      path: string;
    };
    PromptApprovalSchema: {
      /** Format: date-time */
      approvedAt: string;
      approvedByUserId: components['schemas']['schema4'];
      id: components['schemas']['schema4'];
      promptContentHash: components['schemas']['schema0'];
      promptRevisionId: components['schemas']['schema4'];
      scenarioContentHash: components['schemas']['schema0'];
      scenarioId: components['schemas']['schema4'];
    };
    PromptBundleEnvelopeSchema: {
      data: {
        approval: components['schemas']['PromptApprovalSchema'] | null;
        approvalCurrent: boolean;
        previousApprovalStale: boolean;
        promptSet: components['schemas']['PromptSetSchema'];
        revision: components['schemas']['PromptRevisionSchema'];
        scenario: components['schemas']['MeasurementScenarioSchema'];
      };
      meta: components['schemas']['schema5'];
    };
    PromptDraftSchema: {
      id: components['schemas']['schema4'];
      journeyStage: string;
      persona: string;
      queryType: string;
      text: string;
    };
    PromptRegistryEnvelopeSchema: {
      data: {
        entries: components['schemas']['ProviderSurfaceRegistrySchema'][];
      };
      meta: components['schemas']['schema5'];
    };
    PromptRevisionSchema: {
      contentHash: components['schemas']['schema0'];
      /** Format: date-time */
      createdAt: string;
      createdByUserId: components['schemas']['schema4'];
      id: components['schemas']['schema4'];
      prompts: components['schemas']['PromptDraftSchema'][];
      promptSetId: components['schemas']['schema4'];
      revision: number;
      scopes: components['schemas']['PromptScopeSchema'][];
      sourceContext: components['schemas']['PromptSourceContextSchema'];
      /** @enum {string} */
      status: 'DRAFT' | 'APPROVED' | 'STALE';
      subject: string;
      title: string;
    };
    PromptRunEnvelopeSchema: {
      data: {
        promptRun: components['schemas']['PromptRunSchema'];
        rawEvidence: components['schemas']['RawMeasurementEvidenceSchema'];
      };
      meta: components['schemas']['schema115'];
    };
    PromptRunSchema: {
      /** @enum {string} */
      acquisitionClass:
        'CONSUMER_UI_SAMPLE' | 'MODEL_API_DIAGNOSTIC' | 'SEARCH_DATA_API' | 'MANUAL_IMPORT';
      acquisitionMethod: string;
      adapterKey: string;
      adapterVersion: string;
      cost: components['schemas']['MonetaryCostSchema'];
      /** Format: uuid */
      id: string;
      /** Format: uuid */
      measurementRunId: string;
      methodVersion: string;
      model: string;
      modelVersion: string;
      observation: components['schemas']['MeasurementObservationSchema'];
      /** Format: date-time */
      observedAt: string;
      policyReason: string | null;
      /** Format: uuid */
      promptId: string;
      promptOrdinal: number;
      providerKey: string;
      repetition: number;
      /** Format: uuid */
      scenarioId: string;
      scenarioVersion: number;
      scopeKey: string;
      status: components['schemas']['PromptRunStatusSchema'];
      surfaceKey: string;
    };
    /** @enum {string} */
    PromptRunStatusSchema:
      'PASS' | 'FAIL' | 'ERROR' | 'NOT_CHECKED' | 'INCONCLUSIVE' | 'NOT_APPLICABLE';
    PromptScopeSchema: {
      locale: string;
      market: string;
      region: string;
    };
    PromptSetSchema: {
      /** Format: date-time */
      createdAt: string;
      currentRevision: number;
      id: components['schemas']['schema4'];
      tenantId: components['schemas']['schema4'];
      workspaceId: components['schemas']['schema4'];
    };
    PromptSourceContextSchema: {
      claimRevisionIds: components['schemas']['schema4'][];
      offering: {
        id: components['schemas']['schema4'];
        revision: number;
      };
      profile: {
        id: components['schemas']['schema4'];
        revision: number;
      };
    };
    ProposePromptSetRequestSchema: {
      scenario: components['schemas']['MeasurementScenarioInputSchema'];
      scopes: components['schemas']['PromptScopeSchema'][];
      sourceContext: components['schemas']['PromptSourceContextSchema'];
      subject: string;
      title: string;
    };
    ProviderBudgetPolicyEnvelopeSchema: {
      data: {
        policy: components['schemas']['ProviderBudgetPolicySchema'];
      };
      meta: components['schemas']['schema157'];
    };
    ProviderBudgetPolicySchema: {
      id: components['schemas']['schema153'];
      limitUnits: components['schemas']['schema155'];
      providerKey: components['schemas']['ProviderKeySchema'];
      tenantId: components['schemas']['schema154'];
      warningPercent: components['schemas']['schema156'];
    };
    ProviderKeySchema: string;
    ProviderSurfaceRegistrySchema: {
      /** @enum {string} */
      acquisitionClass:
        'CONSUMER_UI_SAMPLE' | 'MODEL_API_DIAGNOSTIC' | 'SEARCH_DATA_API' | 'MANUAL_IMPORT';
      acquisitionMethod: string;
      adapterVersion: string;
      id: components['schemas']['schema4'];
      providerKey: string;
      providerName: string;
      /** @enum {string} */
      status: 'AVAILABLE' | 'UNAVAILABLE';
      surfaceKey: string;
      /** @enum {string} */
      surfaceKind: 'SEARCH_DATA' | 'CONSUMER_SEARCH' | 'CONSUMER_AI_ANSWER';
      surfaceName: string;
      unavailableReason: string | null;
    };
    PublicationAttemptRecordSchema: {
      attemptNumber: number;
      errorCode: string | null;
      finishedAt: string | null;
      id: components['schemas']['schema45'];
      /** @enum {string} */
      operation: 'PUBLISH' | 'RECONCILE' | 'ROLLBACK';
      /** @enum {string} */
      outcome:
        | 'STARTED'
        | 'APPLIED'
        | 'AMBIGUOUS'
        | 'DEFINITELY_NOT_APPLIED'
        | 'RETRYABLE_FAILURE'
        | 'TERMINAL_FAILURE'
        | 'UNKNOWN'
        | 'ROLLED_BACK'
        | 'ROLLBACK_FAILED';
      publicationId: components['schemas']['schema45'];
      remoteRef: string | null;
      /** Format: date-time */
      startedAt: string;
    };
    PublicationCommandEnvelopeSchema: {
      data: {
        created: boolean;
        job: components['schemas']['JobSchema'];
        publication: components['schemas']['PublicationRecordSchema'];
      };
      meta: {
        requestId: string;
        /** @constant */
        schemaVersion: '1.0.0';
      };
    };
    PublicationDetailEnvelopeSchema: {
      data: {
        attempts: components['schemas']['PublicationAttemptRecordSchema'][];
        job: components['schemas']['JobSchema'];
        publication: components['schemas']['PublicationRecordSchema'];
      };
      meta: {
        requestId: string;
        /** @constant */
        schemaVersion: '1.0.0';
      };
    };
    PublicationEligibilityEnvelopeSchema: {
      data: {
        eligibility:
          | {
              adapterVersionId: components['schemas']['schema45'];
              channelAuthorizationId: components['schemas']['schema45'];
              /** @constant */
              mode: 'PUBLISH_READY';
              packageChecksum: components['schemas']['schema46'];
              packageId: components['schemas']['schema45'];
            }
          | {
              /** @constant */
              mode: 'EXPORT_ONLY';
              packageChecksum: components['schemas']['schema46'];
              packageId: components['schemas']['schema45'];
              reasons: components['schemas']['PublicationEligibilityReasonSchema'][];
            };
        export: {
          href: string;
          packageChecksum: components['schemas']['schema46'];
        };
      };
      meta: {
        requestId: string;
        /** @constant */
        schemaVersion: '1.0.0';
      };
    };
    PublicationEligibilityReasonSchema: {
      /** @enum {string} */
      code:
        | 'AUTHORIZATION_MISSING'
        | 'AUTHORIZATION_EXPIRED'
        | 'AUTHORIZATION_REVOKED'
        | 'AUTHORIZATION_VALIDATION_PENDING'
        | 'AUTHORIZATION_VALIDATION_INVALID'
        | 'AUTHORIZATION_VALIDATION_STALE'
        | 'AUTHORIZATION_VALIDATED_TARGET_MISMATCH'
        | 'AUTHORIZATION_VALIDATED_SCOPE_INSUFFICIENT'
        | 'AUTHORIZATION_VALIDATED_TERMS_MISMATCH'
        | 'ADAPTER_NOT_FOUND'
        | 'ADAPTER_DISABLED'
        | 'ADAPTER_RUNTIME_UNAVAILABLE'
        | 'ADAPTER_RUNTIME_METADATA_MISMATCH'
        | 'ADAPTER_PROVIDER_API_VERSION_EXPIRED'
        | 'CHANNEL_UNAVAILABLE'
        | 'PUBLISH_CAPABILITY_MISSING'
        | 'RECONCILE_CAPABILITY_MISSING'
        | 'TERMS_NOT_APPROVED'
        | 'AUTHORIZATION_SCOPE_INSUFFICIENT';
      detail: string;
    };
    PublicationRecordSchema: {
      adapterVersionId: components['schemas']['schema45'];
      artifactContentHash: components['schemas']['schema46'];
      artifactRevisionId: components['schemas']['schema45'];
      channelAuthorizationId: components['schemas']['schema45'];
      channelPackageId: components['schemas']['schema45'];
      createdAt: components['schemas']['schema171'];
      id: components['schemas']['schema45'];
      idempotencyKey: components['schemas']['schema160'];
      packageChecksum: components['schemas']['schema46'];
      remoteRef: components['schemas']['schema161'];
      remoteState?: components['schemas']['schema162'];
      requestedByUserId: components['schemas']['schema45'];
      status: components['schemas']['schema158'];
      target: components['schemas']['schema159'];
      updatedAt: components['schemas']['schema172'];
    };
    PublicationRemoteStateSchema: {
      isProductionLive: components['schemas']['schema165'];
      number: components['schemas']['schema164'];
      receiptEvidence?: components['schemas']['schema169'];
      rollbackHandle: components['schemas']['schema166'];
      status: components['schemas']['schema163'];
    };
    PublicationRemoteStatusRefreshEnvelopeSchema: {
      data: {
        publication: components['schemas']['PublicationRecordSchema'];
      };
      meta: {
        requestId: string;
        /** @constant */
        schemaVersion: '1.0.0';
      };
    };
    RawCitationSchema: {
      snippet: string;
      title: string;
      /** Format: uri */
      url: string;
    };
    RawMeasurementEvidenceSchema: {
      citations: components['schemas']['schema111'];
      contentHash: string;
      error: components['schemas']['schema112'];
      responseText: components['schemas']['schema110'];
    };
    RequestDeletionRequestSchema: {
      reason: components['schemas']['schema20'];
    };
    RequestPublicationSchema: {
      adapterVersionId?: components['schemas']['schema45'];
      channelPackageId: components['schemas']['schema45'];
      expectedPackageChecksum: components['schemas']['schema46'];
      idempotencyKey: string;
      target: string;
    };
    ReviewArtifactRevisionEnvelopeSchema: {
      data: {
        review: components['schemas']['ArtifactReviewSchema'];
        revision: components['schemas']['ArtifactRevisionSchema'];
      };
      meta: components['schemas']['schema10'];
    };
    ReviewArtifactRevisionRequestSchema: {
      /** @enum {string} */
      decision: 'APPROVE' | 'REJECT';
      expectedContentHash: string;
      note: string;
    };
    ReviewBriefRequestSchema: {
      /** @enum {string} */
      decision: 'APPROVE' | 'REJECT';
      expectedContentHash: components['schemas']['schema2'];
      note: string;
    };
    ReviewClaimRequestSchema: {
      /** @enum {string} */
      decision: 'APPROVE' | 'REJECT';
      note: string;
    };
    ReviewManualMeasurementImportRequestSchema: {
      /** @enum {string} */
      decision: 'APPROVE' | 'REJECT';
      expectedContentHash: string;
      note?: string;
    };
    RevokeChannelAuthorizationRequestSchema: Record<string, never>;
    RevokeSignedWebhookEndpointVerificationRequestSchema: Record<string, never>;
    RuntimeBuildIdentityEnvelopeSchema: {
      data: {
        identity: components['schemas']['RuntimeBuildIdentitySchema'];
      };
      meta: {
        requestId: string;
        /** @constant */
        schemaVersion: '1.0.0';
      };
    };
    RuntimeBuildIdentitySchema: {
      /** Format: date-time */
      capturedAt: string;
      containerArn: string;
      image: string;
      imageDigest: string;
      imageId: string;
      /** @constant */
      schemaVersion: 'aeostudio.runtime-build-identity.v1';
      /** @enum {string} */
      service: 'api' | 'web' | 'worker';
      /** @constant */
      source: 'ecs-container-metadata-v4';
      taskArn: string;
      taskDefinitionArn: string;
    };
    ScenarioSnapshotSchema: {
      account: string;
      /** @enum {string} */
      acquisitionClass:
        'CONSUMER_UI_SAMPLE' | 'MODEL_API_DIAGNOSTIC' | 'SEARCH_DATA_API' | 'MANUAL_IMPORT';
      acquisitionMethod: string;
      contentHash: string;
      freshSession: boolean;
      /** Format: uuid */
      id: string;
      manualImport: {
        contentHash: string;
        /** Format: uuid */
        id: string;
      } | null;
      model: string;
      modelVersion: string;
      parameters: {
        [key: string]: unknown;
      };
      /** Format: uuid */
      promptRevisionId: string;
      providerKey: string;
      /** @enum {string} */
      registryStatus: 'AVAILABLE' | 'UNAVAILABLE';
      repetitions: number;
      scopes: components['schemas']['MeasurementScopeSchema'][];
      searchEnabled: boolean;
      surfaceKey: string;
      version: number;
    };
    schema0: string;
    /** Format: uuid */
    schema1: string;
    schema2: string;
    schema3: {
      requestId: string;
      /** @constant */
      schemaVersion: '1.0.0';
    };
    /** Format: uuid */
    schema4: string;
    schema5: {
      requestId: string;
      /** @constant */
      schemaVersion: '1.0.0';
    };
    /** Format: uuid */
    schema6: string;
    schema7: {
      aggregateId: components['schemas']['schema6'];
      contentHash: string | null;
      id: components['schemas']['schema6'];
      /** @enum {string} */
      kind: 'PROFILE_REVISION' | 'OFFERING_REVISION' | 'PROMPT_REVISION' | 'SITE_BASELINE';
      revision: number | null;
    };
    schema8: {
      claimContentHash: string;
      claimId: components['schemas']['schema6'];
      claimRevisionId: components['schemas']['schema6'];
      claimStatement: string;
      evidence: components['schemas']['schema9'][];
    };
    schema9: {
      snapshotId: components['schemas']['schema6'];
      sourceHash: string;
      sourceId: components['schemas']['schema6'];
    };
    schema10: {
      requestId: string;
      /** @constant */
      schemaVersion: '1.0.0';
    };
    /** Format: uuid */
    schema11: string;
    /** Format: date-time */
    schema12: string;
    schema13: string;
    schema14: string;
    schema15: {
      requestId: string;
      /** @constant */
      schemaVersion: '1.0.0';
    };
    /** @enum {string} */
    schema16: 'SUCCEEDED' | 'TAMPERED';
    schema17: boolean;
    schema18: number;
    schema19: string | null;
    schema20: string;
    schema21: string;
    schema22: string;
    schema23: string;
    schema24: string;
    schema25: components['schemas']['schema12'] | null;
    /** Format: uuid */
    schema26: string;
    schema27: string;
    /** Format: uuid */
    schema28: string;
    schema29: string;
    schema30: string;
    schema31: {
      [key: string]: unknown;
    };
    schema32: components['schemas']['schema33'][];
    schema33: string;
    schema34: {
      requestId: string;
      /** @constant */
      schemaVersion: '1.0.0';
    };
    schema35: string;
    schema36: string;
    schema37: string;
    schema38: components['schemas']['ChannelProfileFieldRequirementSchema'][];
    schema39: string;
    schema40: string;
    schema41: boolean;
    schema42: number | null;
    schema43: number | null;
    schema44: string;
    /** Format: uuid */
    schema45: string;
    schema46: string;
    schema47: string;
    schema48: {
      id: components['schemas']['schema1'];
      revision: number;
    };
    schema49: string;
    /** Format: uuid */
    schema50: string;
    /** Format: uuid */
    schema51: string;
    schema52: string;
    schema53: string;
    schema54: string;
    schema55: string;
    schema56: string;
    schema57: string;
    schema58: string;
    schema59: string;
    schema60: boolean;
    schema61: boolean;
    schema62: {
      [key: string]: unknown;
    };
    schema63: number;
    /** Format: uuid */
    schema64: string;
    schema65: string;
    /** @enum {string} */
    schema66: 'PENDING' | 'VERIFIED' | 'REVOKED';
    /** Format: date-time */
    schema67: string;
    /** Format: date-time */
    schema68: string;
    schema69: string | null;
    schema70: string | null;
    schema71: components['schemas']['schema72'][];
    schema72: {
      challenge: string;
      /** Format: date-time */
      challengeExpiresAt: string;
      exactUrl: components['schemas']['SignedWebhookUrlSchema'];
      /** @enum {string} */
      purpose: 'DELIVERY' | 'RECEIPT' | 'DELIVERY_AND_RECEIPT';
    };
    schema73: {
      requestId: string;
      /** @constant */
      schemaVersion: '1.0.0';
    };
    schema74: string;
    schema75: string;
    schema76: boolean;
    schema77: string;
    /** Format: uuid */
    schema78: string;
    /** Format: uuid */
    schema79: string;
    /** Format: uuid */
    schema80: string;
    /** @constant */
    schema81: 'experiment.v1';
    /** Format: uuid */
    schema82: string;
    /** Format: uuid */
    schema83: string;
    schema84: number;
    schema85: {
      completedAt: components['schemas']['schema88'];
      evidenceWindow: components['schemas']['schema89'];
      runId: components['schemas']['schema86'];
      startedAt: components['schemas']['schema87'];
    };
    /** Format: uuid */
    schema86: string;
    /** Format: date-time */
    schema87: string;
    /** Format: date-time */
    schema88: string;
    schema89: {
      /** Format: date-time */
      maxObservedAt: string;
      /** Format: date-time */
      minObservedAt: string;
    };
    schema90: components['schemas']['ExperimentMetricComparisonSchema'][];
    schema91: {
      ERROR: number;
      INCONCLUSIVE: number;
      NOT_APPLICABLE: number;
      NOT_CHECKED: number;
    };
    schema92: {
      baseline: number;
      remeasurement: number;
    };
    schema93: {
      baseline: components['schemas']['schema91'];
      remeasurement: components['schemas']['schema91'];
    };
    schema94: {
      baseline: components['schemas']['MonetaryCostSchema'][];
      remeasurement: components['schemas']['MonetaryCostSchema'][];
    };
    schema95: string;
    schema96: string;
    schema97: string;
    schema98: {
      baselineRunHref: string;
      interventionHref: string;
      remeasurementRunHref: string;
    };
    /** Format: uuid */
    schema99: string;
    /** Format: date-time */
    schema100: string;
    schema101: {
      requestId: string;
      /** @constant */
      schemaVersion: '1.0.0';
    };
    schema102: string;
    schema103: {
      /** Format: uuid */
      id: string;
      ordinal: number;
      text: string;
    };
    schema104: string;
    schema105: number;
    schema106: boolean;
    schema107: string | null;
    schema108: {
      cost: components['schemas']['MonetaryCostSchema'];
      observation: components['schemas']['MeasurementObservationSchema'];
      rawEvidence: components['schemas']['schema109'];
      status: components['schemas']['PromptRunStatusSchema'];
    } | null;
    schema109: {
      citations: components['schemas']['schema111'];
      contentHash?: string;
      error: components['schemas']['schema112'];
      responseText: components['schemas']['schema110'];
    };
    schema110: string | null;
    schema111: components['schemas']['RawCitationSchema'][];
    schema112: {
      code: string;
      message: string;
    } | null;
    schema113: string | null;
    schema114: string;
    schema115: {
      requestId: components['schemas']['schema116'];
      schemaVersion: components['schemas']['schema117'];
    };
    schema116: string;
    /** @constant */
    schema117: '1.0.0';
    schema118: {
      /** Format: uuid */
      measurementRunId: string;
      metrics: components['schemas']['DashboardMetricSchema'][];
    };
    schema119: [
      {
        /** @constant */
        key: 'TECHNICAL_HEALTH';
        /** @constant */
        sourceKind: 'OWNED_SITE_BASELINE';
        summary:
          | {
              /** @constant */
              reason: 'MEASUREMENT_SCENARIO_SITE_NOT_LINKED';
              /** @constant */
              state: 'NOT_LINKED';
            }
          | {
              /** Format: uuid */
              baselineId: string;
              /** Format: date-time */
              capturedAt: string;
              findingCount: number;
              pageCount: number;
              /** Format: uuid */
              siteId: string;
              /** @constant */
              state: 'AVAILABLE';
              /** @enum {string} */
              status: 'COMPLETE' | 'PARTIAL' | 'FAILED_TERMINAL';
            };
      },
      {
        /** @constant */
        key: 'CONTENT_EVIDENCE_READINESS';
        /** @constant */
        sourceKind: 'CLAIM_EVIDENCE_LEDGER';
        summary:
          | {
              /** @constant */
              reason: 'MEASUREMENT_SCENARIO_CLAIM_SET_NOT_LINKED';
              /** @constant */
              state: 'NOT_LINKED';
            }
          | {
              approvedCount: number;
              claimSetHash: string;
              /** Format: date-time */
              evaluatedAt: string;
              needsEvidenceCount: number;
              staleCount: number;
              /** @constant */
              state: 'AVAILABLE';
            };
      },
      {
        cohorts: {
          cohort: components['schemas']['DashboardCohortSchema'];
          cost: components['schemas']['schema122'];
          costBreakdown: components['schemas']['schema123'];
          metricIds: components['schemas']['schema120'];
          resultCounts: components['schemas']['MeasurementResultCountsSchema'];
        }[];
        crossSurfaceAggregate?: unknown;
        /** @constant */
        key: 'MEASURED_AI_VISIBILITY';
      },
    ];
    schema120: components['schemas']['schema121'][];
    /** Format: uuid */
    schema121: string;
    schema122: components['schemas']['MonetaryCostSchema'] | null;
    schema123: components['schemas']['MonetaryCostSchema'][];
    schema124: components['schemas']['MonetaryCostSchema'] | null;
    schema125: string;
    schema126: string;
    schema127: string;
    schema128: string;
    schema129: string;
    schema130: string;
    schema131: string;
    schema132: string;
    schema133: string;
    schema134: components['schemas']['schema135'][];
    schema135: string;
    schema136: string;
    schema137: string;
    /** @default [] */
    schema138: components['schemas']['schema139'][];
    schema139: string;
    schema140: string;
    /** @default [] */
    schema141: components['schemas']['schema142'][];
    schema142: {
      name: string;
      unit?: string;
      value: string;
    };
    /** @default [] */
    schema143: components['schemas']['schema144'][];
    schema144: string;
    /** @default [] */
    schema145: components['schemas']['DynamicAttributeSchema'][];
    /** @constant */
    schema146: 'FROZEN';
    schema147: string;
    schema148: string;
    /** @default [] */
    schema149: components['schemas']['schema150'][];
    schema150: {
      label: string;
      /** Format: uri */
      url: string;
    };
    schema151: components['schemas']['schema152'][];
    schema152: {
      locale: components['schemas']['LocaleSchema'];
      market: components['schemas']['MarketSchema'];
    };
    /** Format: uuid */
    schema153: string;
    /** Format: uuid */
    schema154: string;
    schema155: number;
    schema156: number;
    schema157: {
      requestId: string;
      /** @constant */
      schemaVersion: '1.0.0';
    };
    /** @enum {string} */
    schema158:
      | 'REQUESTED'
      | 'BUDGET_BLOCKED'
      | 'QUEUED'
      | 'RUNNING'
      | 'RETRY_WAIT'
      | 'AMBIGUOUS'
      | 'RECONCILE_REQUIRED'
      | 'RECONCILING'
      | 'MANUAL_REVIEW_REQUIRED'
      | 'REMOTE_APPLIED'
      | 'PUBLISHED'
      | 'FAILED_TERMINAL'
      | 'ROLLBACK_QUEUED'
      | 'ROLLED_BACK'
      | 'ROLLBACK_FAILED';
    schema159: string;
    schema160: string;
    schema161: string | null;
    schema162: components['schemas']['PublicationRemoteStateSchema'] | null;
    schema163: string;
    schema164: number | null;
    schema165: boolean;
    schema166: {
      [key: string]: components['schemas']['schema168'];
    } | null;
    schema167: string;
    schema168: string | number | boolean;
    schema169: components['schemas']['SignedWebhookReceiptEvidenceSchema'];
    schema170: string;
    /** Format: date-time */
    schema171: string;
    /** Format: date-time */
    schema172: string;
    schema173: string;
    schema174: string;
    schema175: string;
    /** @constant */
    schema176: '1.0.0';
    /** @constant */
    schema177: 'channel-package.approved.v1';
    /** Format: uuid */
    schema178: string;
    schema179: {
      artifact: components['schemas']['ChannelPackageArtifactSchema'];
      channel: {
        channelKey: string;
        definitionId: components['schemas']['schema178'];
      };
      files: {
        'content.html': string;
        'content.md': string;
        'structured-data.json': string;
      };
      id: components['schemas']['schema178'];
      manifest: components['schemas']['ChannelPackageManifestSchema'];
      packageChecksum: components['schemas']['schema180'];
      packageRevision: number;
      packageSchemaVersion: string;
      tenantId: components['schemas']['schema178'];
      transformer: {
        key: string;
        version: string;
      };
      workspaceId: components['schemas']['schema178'];
    };
    schema180: string;
    /** @constant */
    schema181: '1.0.0';
    /** @constant */
    schema182: 'channel-package.delivery-receipt.v1';
    schema183: number;
    /** @constant */
    schema184: '1.0.0';
    /** @constant */
    schema185: 'channel-package.delivery-receipt.v1';
    schema186: string;
    /** @enum {string} */
    schema187: 'APPLIED' | 'ALREADY_APPLIED' | 'PENDING' | 'NOT_FOUND' | 'CONFLICT';
    schema188: number;
    schema189: string | null;
    /** Format: date-time */
    schema190: string;
    /** @constant */
    schema191: false;
    /** @constant */
    schema192: 'signed-webhook-target.v1';
    /** Format: uuid */
    schema193: string;
    /** Format: uuid */
    schema194: string;
    /** Format: uuid */
    schema195: string;
    /** Format: uuid */
    schema196: string;
    /** Format: uuid */
    schema197: string;
    /** Format: uuid */
    schema198: string;
    /** @enum {string} */
    schema199: 'COMPLETE' | 'PARTIAL' | 'FAILED_TERMINAL';
    schema200: string | null;
    schema201: number;
    schema202: number;
    /** Format: date-time */
    schema203: string;
    schema204: components['schemas']['CrawlSnapshotSchema'][];
    schema205: components['schemas']['BaselineFindingSchema'][];
    schema206: number;
    schema207: number;
    /** Format: uuid */
    schema208: string;
    /** Format: uuid */
    schema209: string;
    /** Format: uuid */
    schema210: string;
    schema211: string;
    schema212: string;
    /** Format: uuid */
    schema213: string;
    schema214: string;
    schema215: string;
    /** @constant */
    schema216: '1.0.0';
    schema217: components['schemas']['TenantExportManifestObjectSchema'][];
    schema218: components['schemas']['TenantExportManifestFileSchema'][];
    /** @enum {string} */
    schema219: 'PENDING' | 'READY' | 'FAILED';
    schema220: boolean;
    schema221: string | null;
    /** @enum {string} */
    schema222: 'OAUTH' | 'APPLICATION_PASSWORD' | 'APPROVED_TOKEN';
    schema223: string;
    schema224: number;
    schema225: components['schemas']['schema226'][];
    schema226: number;
    SearchDataConnectorDescriptorSchema: {
      /** @constant */
      acquisitionClass: 'SEARCH_DATA_API';
      /** @constant */
      acquisitionMethod: 'OFFICIAL_API';
      adapterKey: components['schemas']['schema125'];
      adapterVersion: components['schemas']['schema126'];
      processingRegion: components['schemas']['schema130'];
      providerKey: components['schemas']['schema127'];
      /** @constant */
      requiresAuthorization: true;
      retentionPolicy: components['schemas']['schema132'];
      storageRegion: components['schemas']['schema131'];
      subprocessors: components['schemas']['schema134'];
      surfaceKey: components['schemas']['schema128'];
      /** @constant */
      surfaceKind: 'SEARCH_DATA';
      termsVersion: components['schemas']['schema129'];
      trainingPolicy: components['schemas']['schema133'];
    };
    SessionEnvelopeSchema: {
      data: {
        /** Format: email */
        email: string;
        /** Format: date-time */
        expiresAt: string;
      };
      meta: {
        requestId: string;
        /** @constant */
        schemaVersion: '1.0.0';
      };
    };
    SetBudgetRequestSchema: {
      limitUnits: number;
    };
    ShopifyDraftTargetV1Schema: {
      apiVersion: string;
      destination:
        | {
            handle: components['schemas']['schema174'];
            /** @constant */
            kind: 'PAGE';
            /** @constant */
            operation: 'CREATE';
          }
        | {
            handle: components['schemas']['schema174'];
            /** @constant */
            kind: 'PAGE';
            /** @constant */
            operation: 'UPDATE';
            remoteId: string;
          }
        | {
            blogId: components['schemas']['schema175'];
            handle: components['schemas']['schema174'];
            /** @constant */
            kind: 'BLOG_ARTICLE';
            /** @constant */
            operation: 'CREATE';
          }
        | {
            blogId: components['schemas']['schema175'];
            handle: components['schemas']['schema174'];
            /** @constant */
            kind: 'BLOG_ARTICLE';
            /** @constant */
            operation: 'UPDATE';
            remoteId: string;
          }
        | {
            handle: components['schemas']['schema174'];
            /** @constant */
            kind: 'PRODUCT';
            /** @constant */
            operation: 'CREATE';
          }
        | {
            handle: components['schemas']['schema174'];
            /** @constant */
            kind: 'PRODUCT';
            /** @constant */
            operation: 'UPDATE';
            remoteId: string;
          };
      /** @constant */
      schemaVersion: 'shopify-draft-target.v1';
      shopDomain: components['schemas']['schema173'];
    };
    ShopifyShopAuthorizationTargetV1Schema: {
      /** @constant */
      schemaVersion: 'shopify-shop-auth.v1';
      shopDomain: components['schemas']['schema173'];
    };
    SignedWebhookDeliveryV1Schema: {
      channelPackage: components['schemas']['schema179'];
      deliveryId: components['schemas']['schema178'];
      eventType: components['schemas']['schema177'];
      publicationId: components['schemas']['schema178'];
      schemaVersion: components['schemas']['schema176'];
    };
    SignedWebhookEndpointVerificationEnvelopeSchema: {
      data: {
        verification: components['schemas']['SignedWebhookEndpointVerificationSchema'];
      };
      meta: components['schemas']['schema73'];
    };
    SignedWebhookEndpointVerificationListEnvelopeSchema: {
      data: {
        verifications: components['schemas']['SignedWebhookEndpointVerificationSchema'][];
      };
      meta: components['schemas']['schema73'];
    };
    SignedWebhookEndpointVerificationPathParamsSchema: {
      verificationId: components['schemas']['schema64'];
    };
    SignedWebhookEndpointVerificationSchema: {
      algorithm: components['schemas']['SignedWebhookSigningAlgorithmSchema'];
      challengeExpiresAt: components['schemas']['schema68'];
      channelDefinitionId: components['schemas']['schema64'];
      createdAt: components['schemas']['schema67'];
      endpointUrl: components['schemas']['SignedWebhookUrlSchema'];
      id: components['schemas']['schema64'];
      keyId: components['schemas']['SignedWebhookKeyIdSchema'];
      receiptUrl: components['schemas']['SignedWebhookUrlSchema'];
      revokedAt: components['schemas']['schema70'];
      status: components['schemas']['schema66'];
      verificationReference: components['schemas']['schema65'];
      verifiedAt: components['schemas']['schema69'];
    };
    SignedWebhookKeyIdSchema: string;
    SignedWebhookReceiptEvidenceSchema: {
      deliveryId: components['schemas']['schema45'];
      receiptId: components['schemas']['schema170'];
      /** Format: date-time */
      receivedAt: string;
      receiverEffectId: components['schemas']['schema170'];
      requestBodySha256: components['schemas']['schema46'];
      /** @constant */
      schemaVersion: 'signed-webhook-receipt-evidence.v1';
      verifiedAlgorithm: components['schemas']['SignedWebhookSigningAlgorithmSchema'];
      verifiedKeyId: components['schemas']['SignedWebhookKeyIdSchema'];
    };
    SignedWebhookReceiptQueryV1Schema: {
      artifactContentHash: components['schemas']['schema180'];
      artifactRevisionId: components['schemas']['schema178'];
      channelPackageId: components['schemas']['schema178'];
      deliveryId: components['schemas']['schema178'];
      packageChecksum: components['schemas']['schema180'];
      packageRevision: components['schemas']['schema183'];
      publicationId: components['schemas']['schema178'];
      queryType: components['schemas']['schema182'];
      requestBodySha256: components['schemas']['schema180'];
      schemaVersion: components['schemas']['schema181'];
    };
    SignedWebhookReceiptV1Schema: {
      artifactContentHash: components['schemas']['schema180'];
      artifactRevisionId: components['schemas']['schema178'];
      channelPackageId: components['schemas']['schema178'];
      deliveryId: components['schemas']['schema178'];
      isProductionLive: components['schemas']['schema191'];
      packageChecksum: components['schemas']['schema180'];
      packageRevision: components['schemas']['schema188'];
      publicationId: components['schemas']['schema178'];
      receiptId: components['schemas']['schema186'];
      receiptType: components['schemas']['schema185'];
      receivedAt: components['schemas']['schema190'];
      receiverEffectId: components['schemas']['schema189'];
      remoteRef: components['schemas']['SignedWebhookUrlSchema'];
      requestBodySha256: components['schemas']['schema180'];
      schemaVersion: components['schemas']['schema184'];
      status: components['schemas']['schema187'];
      verifiedAlgorithm: components['schemas']['SignedWebhookSigningAlgorithmSchema'];
      verifiedKeyId: components['schemas']['SignedWebhookKeyIdSchema'];
    };
    /** @enum {string} */
    SignedWebhookSigningAlgorithmSchema: 'HMAC_SHA256' | 'ED25519';
    SignedWebhookTargetV1Schema: {
      algorithm: components['schemas']['SignedWebhookSigningAlgorithmSchema'];
      endpointUrl: components['schemas']['SignedWebhookUrlSchema'];
      endpointVerificationId: components['schemas']['schema193'];
      keyId: components['schemas']['SignedWebhookKeyIdSchema'];
      receiptUrl: components['schemas']['SignedWebhookUrlSchema'];
      schemaVersion: components['schemas']['schema192'];
    };
    SignedWebhookUrlSchema: string;
    SiteBaselineEnvelopeSchema: {
      data: {
        baseline: components['schemas']['SiteBaselineSchema'];
      };
      meta: {
        requestId: string;
        /** @constant */
        schemaVersion: '1.0.0';
      };
    };
    SiteBaselineListEnvelopeSchema: {
      data: {
        baselines: {
          completedAt: string;
          /** Format: uuid */
          id: string;
          pageCount: number;
          /** Format: uuid */
          siteId: string;
          /** @enum {string} */
          status: 'COMPLETE' | 'PARTIAL' | 'FAILED_TERMINAL';
        }[];
      };
      meta: {
        requestId: string;
        /** @constant */
        schemaVersion: '1.0.0';
      };
    };
    SiteBaselineSchema: {
      completedAt: components['schemas']['schema203'];
      errorCode: components['schemas']['schema200'];
      findings: components['schemas']['schema205'];
      id: components['schemas']['schema194'];
      jobId: components['schemas']['schema198'];
      pageCount: components['schemas']['schema201'];
      siteId: components['schemas']['schema197'];
      snapshots: components['schemas']['schema204'];
      status: components['schemas']['schema199'];
      tenantId: components['schemas']['schema195'];
      totalBytes: components['schemas']['schema202'];
      workspaceId: components['schemas']['schema196'];
    };
    SiteEnvelopeSchema: {
      data: {
        site: components['schemas']['SiteSchema'];
      };
      meta: {
        requestId: string;
        /** @constant */
        schemaVersion: '1.0.0';
      };
    };
    SiteSchema: {
      hostname: string;
      /** Format: uuid */
      id: string;
      /** Format: uri */
      origin: string;
      /** Format: uuid */
      profileId: string;
      /** @enum {string} */
      status: 'UNVERIFIED' | 'VERIFIED';
      /** Format: uuid */
      tenantId: string;
      verifiedAt: string | null;
      /** Format: uuid */
      workspaceId: string;
    };
    SiteVerificationEnvelopeSchema: {
      data: {
        verification: components['schemas']['SiteVerificationSchema'];
      };
      meta: {
        requestId: string;
        /** @constant */
        schemaVersion: '1.0.0';
      };
    };
    SiteVerificationSchema: {
      challengePath: string | null;
      challengeToken: string;
      /** Format: uuid */
      id: string;
      /** @enum {string} */
      method: 'DNS' | 'FILE' | 'OAUTH' | 'ADMIN';
      /** Format: uuid */
      siteId: string;
      /** @enum {string} */
      status: 'PENDING' | 'VERIFIED';
      /** Format: uuid */
      tenantId: string;
      verifiedAt: string | null;
      /** Format: uuid */
      workspaceId: string;
    };
    StartArtifactGenerationEnvelopeSchema: {
      data: {
        artifact: components['schemas']['ArtifactSchema'];
        job: components['schemas']['JobSchema'];
      };
      meta: components['schemas']['schema10'];
    };
    StartArtifactGenerationRequestSchema: {
      briefId: components['schemas']['schema6'];
      /** @description Deprecated client estimate; accepted for compatibility and ignored by the server. */
      estimatedUnits?: components['schemas']['schema206'];
      idempotencyKey: string;
      locale: string;
      market: string;
      /** @constant */
      methodPolicyVersion: 'artifact-fixture-v1';
    };
    StartContentPlanEnvelopeSchema: {
      data: {
        job: components['schemas']['JobSchema'];
        plan: components['schemas']['ContentPlanSchema'];
      };
      meta: components['schemas']['schema3'];
    };
    StartContentPlanRequestSchema: {
      baselineId: components['schemas']['schema1'];
      comparisonClaimRevisionIds: components['schemas']['schema1'][];
      /** @description Deprecated client estimate; accepted for compatibility and ignored by the server. */
      estimatedUnits?: components['schemas']['schema207'];
      idempotencyKey: string;
      /** @constant */
      methodPolicyVersion: 'content-plan-v1';
      offering: components['schemas']['schema48'];
      primaryClaimRevisionIds: components['schemas']['schema1'][];
      profile: components['schemas']['schema48'];
      promptRevisionId: components['schemas']['schema1'];
      promptSetId: components['schemas']['schema1'];
    };
    StartCrawlRequestSchema: {
      idempotencyKey: string;
    };
    StartMeasurementRunEnvelopeSchema: {
      data: {
        job: components['schemas']['JobSchema'];
        measurementRun: components['schemas']['MeasurementRunSchema'];
      };
      meta: components['schemas']['schema115'];
    };
    StartMeasurementRunRequestSchema: {
      expectedManualImportHash?: components['schemas']['schema214'];
      expectedPromptHash: components['schemas']['schema211'];
      expectedScenarioHash: components['schemas']['schema212'];
      idempotencyKey: components['schemas']['schema215'];
      kind: components['schemas']['MeasurementRunKindSchema'];
      manualImportId?: components['schemas']['schema213'];
      promptRevisionId: components['schemas']['schema209'];
      promptSetId: components['schemas']['schema208'];
      scenarioId: components['schemas']['schema210'];
    };
    SubmitArtifactRevisionEnvelopeSchema: {
      data: {
        revision: components['schemas']['ArtifactRevisionSchema'];
      };
      meta: components['schemas']['schema10'];
    };
    SubmitArtifactRevisionRequestSchema: {
      expectedContentHash: string;
    };
    SubmitClaimRequestSchema: Record<string, never>;
    SubmitJobRequestSchema: {
      /** Format: uuid */
      aggregateId: string;
      estimatedUnits: number;
      idempotencyKey: string;
      /** @constant */
      jobType: 'PROFILE_READINESS';
    };
    SubmitManualMeasurementImportRequestSchema: {
      entries: components['schemas']['ManualMeasurementImportEntrySchema'][];
      expectedPromptHash: string;
      expectedScenarioHash: string;
      idempotencyKey: string;
      /** Format: uuid */
      promptRevisionId: string;
      /** Format: uuid */
      promptSetId: string;
      /** Format: uuid */
      scenarioId: string;
      /** @constant */
      schemaVersion: 'measurement-manual-import.v1';
    };
    TenantBudgetPolicyEnvelopeSchema: {
      data: {
        policy: components['schemas']['TenantBudgetPolicySchema'];
      };
      meta: components['schemas']['schema157'];
    };
    TenantBudgetPolicySchema: {
      id: components['schemas']['schema153'];
      limitUnits: components['schemas']['schema155'];
      tenantId: components['schemas']['schema154'];
      warningPercent: components['schemas']['schema156'];
    };
    TenantDeletionReceiptEnvelopeSchema: {
      data: {
        receipt: components['schemas']['TenantDeletionReceiptSchema'];
      };
      meta: components['schemas']['schema15'];
    };
    TenantDeletionReceiptSchema: {
      activeDeleteBy: components['schemas']['schema12'];
      backupDeleteBy: components['schemas']['schema12'];
      id: components['schemas']['schema11'];
      requestedAt: components['schemas']['schema12'];
      scope: components['schemas']['DeletionScopeSchema'];
      secretForceDeleteBy: components['schemas']['schema12'];
      state: components['schemas']['schema146'];
    };
    TenantExportDisclosuresSchema: {
      /** @constant */
      integrity: 'Hashes support integrity checks but are not legal certification of completeness.';
      /** @constant */
      noGuarantee: 'This point-in-time export is not a guarantee of future ranking, citation, traffic, or business outcomes.';
      /** @constant */
      tenantScope: 'This export is limited to the requested Tenant and stated time range.';
    };
    TenantExportEnvelopeSchema: {
      data: {
        export: components['schemas']['TenantExportSchema'];
      };
      meta: components['schemas']['schema15'];
    };
    TenantExportManifestFileSchema: {
      byteLength: number;
      contentHash: components['schemas']['schema13'];
      objectCount: number;
      path: components['schemas']['schema14'];
    };
    TenantExportManifestObjectSchema: {
      contentHash: components['schemas']['schema13'];
      kind: components['schemas']['TenantExportObjectKindSchema'];
      objectId: string;
    };
    TenantExportManifestSchema: {
      disclosures: components['schemas']['TenantExportDisclosuresSchema'];
      files: components['schemas']['schema218'];
      objects: components['schemas']['schema217'];
      schemaVersion: components['schemas']['schema216'];
      tenantId: components['schemas']['schema11'];
      timeRange: components['schemas']['PrivacyTimeRangeSchema'];
    };
    /** @enum {string} */
    TenantExportObjectKindSchema:
      | 'PROFILE_REVISION'
      | 'OFFERING_REVISION'
      | 'CLAIM_REVISION'
      | 'ARTIFACT'
      | 'MEASUREMENT_RUN'
      | 'METRIC_SNAPSHOT'
      | 'PUBLICATION'
      | 'AUDIT_EVENT';
    TenantExportSchema: {
      archiveReady: components['schemas']['schema220'];
      archiveStatus: components['schemas']['schema219'];
      checksum: components['schemas']['schema13'];
      createdAt: components['schemas']['schema12'];
      id: components['schemas']['schema11'];
      manifest: components['schemas']['TenantExportManifestSchema'];
      objectRef: components['schemas']['schema221'];
    };
    /** @enum {string} */
    TenantRoleSchema:
      'OWNER' | 'ADMIN' | 'EDITOR' | 'REVIEWER' | 'PUBLISHER' | 'ANALYST' | 'VIEWER';
    TenantVisibleLegalHoldSchema: {
      createdAt: components['schemas']['schema12'];
      createdBy: components['schemas']['schema11'];
      id: components['schemas']['schema11'];
      name: string;
      reason: components['schemas']['schema20'];
      releasedAt: components['schemas']['schema12'] | null;
      target: components['schemas']['LegalHoldTargetSchema'];
      tenantId: components['schemas']['schema11'];
      /** @constant */
      visibleToTenant: true;
    };
    VerifySignedWebhookEndpointVerificationRequestSchema: Record<string, never>;
    WordPressDraftTargetV1Schema: {
      authMode: components['schemas']['schema222'];
      destination:
        | {
            /** @constant */
            kind: 'PAGE';
            /** @constant */
            operation: 'CREATE';
            slug: components['schemas']['schema223'];
          }
        | {
            /** @constant */
            kind: 'PAGE';
            /** @constant */
            operation: 'UPDATE';
            remoteId: components['schemas']['schema224'];
            slug: components['schemas']['schema223'];
          }
        | {
            categoryIds: components['schemas']['schema225'];
            /** @constant */
            kind: 'POST';
            /** @constant */
            operation: 'CREATE';
            slug: components['schemas']['schema223'];
          }
        | {
            categoryIds: components['schemas']['schema225'];
            /** @constant */
            kind: 'POST';
            /** @constant */
            operation: 'UPDATE';
            remoteId: components['schemas']['schema224'];
            slug: components['schemas']['schema223'];
          }
        | {
            categoryIds: components['schemas']['schema225'];
            /** @constant */
            kind: 'PRODUCT';
            /** @constant */
            operation: 'CREATE';
            slug: components['schemas']['schema223'];
          }
        | {
            categoryIds: components['schemas']['schema225'];
            /** @constant */
            kind: 'PRODUCT';
            /** @constant */
            operation: 'UPDATE';
            remoteId: components['schemas']['schema224'];
            slug: components['schemas']['schema223'];
          };
      /** @constant */
      schemaVersion: 'wordpress-draft-target.v1';
      siteUrl: string;
    };
    WordPressSiteAuthorizationTargetV1Schema: {
      authMode: components['schemas']['schema222'];
      /** @constant */
      schemaVersion: 'wordpress-site-auth.v1';
      siteUrl: string;
    };
    WorkspaceAccessEnvelopeSchema: {
      data: {
        activeRole: components['schemas']['TenantRoleSchema'];
        workspace: {
          /** Format: uuid */
          id: string;
          name: string;
          /** Format: uuid */
          tenantId: string;
        };
      };
      meta: {
        requestId: string;
        /** @constant */
        schemaVersion: '1.0.0';
      };
    };
    WorkspaceBudgetPolicyEnvelopeSchema: {
      data: {
        policy: components['schemas']['WorkspaceBudgetPolicySchema'];
      };
      meta: components['schemas']['schema157'];
    };
    WorkspaceBudgetPolicySchema: {
      id: components['schemas']['schema153'];
      limitUnits: components['schemas']['schema155'];
      tenantId: components['schemas']['schema154'];
      warningPercent: components['schemas']['schema156'];
      /** Format: uuid */
      workspaceId: string;
    };
    WorkspaceListEnvelopeSchema: {
      data: {
        workspaces: {
          activeRole: components['schemas']['TenantRoleSchema'];
          /** Format: uuid */
          membershipId: string;
          tenant: {
            /** Format: uuid */
            id: string;
            name: string;
          };
          workspace: {
            /** Format: uuid */
            id: string;
            name: string;
            /** Format: uuid */
            tenantId: string;
          };
        }[];
      };
      meta: {
        requestId: string;
        /** @constant */
        schemaVersion: '1.0.0';
      };
    };
  };
  responses: never;
  parameters: never;
  requestBodies: never;
  headers: never;
  pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
  FakeOidc_authorize: {
    parameters: {
      query?: {
        login_hint?: string;
        redirect_uri?: string;
        state?: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Redirect */
      302: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Auth_callback: {
    parameters: {
      query?: {
        code?: string;
        state?: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Redirect */
      302: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Auth_login: {
    parameters: {
      query?: {
        login_hint?: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Redirect */
      302: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Auth_logout: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success response is not yet represented by an exported Zod schema */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Auth_getSession: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SessionEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  DeletionReceipt_current: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['TenantDeletionReceiptEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  RuntimeBuildIdentity_get: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['RuntimeBuildIdentityEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Tenancy_listWorkspaces: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['WorkspaceListEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Tenancy_createTenant: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['CreateTenantRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['CreateTenantEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Tenancy_getWorkspace: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['WorkspaceAccessEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Artifacts_start: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['StartArtifactGenerationRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['StartArtifactGenerationEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Artifacts_get: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        artifactId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ArtifactBundleEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Artifacts_createRevision: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        artifactId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['CreateArtifactRevisionRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['CreateArtifactRevisionEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Artifacts_reviewRevision: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        artifactId: string;
        revision: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['ReviewArtifactRevisionRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ReviewArtifactRevisionEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Artifacts_submitRevision: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        artifactId: string;
        revision: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['SubmitArtifactRevisionRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SubmitArtifactRevisionEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Jobs_setBudget: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['SetBudgetRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['WorkspaceBudgetPolicyEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Jobs_listBudgetAlerts: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['BudgetAlertsEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Jobs_setProviderBudget: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        providerKey: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['SetBudgetRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ProviderBudgetPolicyEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Jobs_setTenantBudget: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['SetBudgetRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['TenantBudgetPolicyEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  ChannelAuthorizations_list: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ChannelAuthorizationListEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  ChannelAuthorizations_create: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['CreateChannelAuthorizationRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ChannelAuthorizationEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  ChannelAuthorizations_revoke: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        authorizationId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['RevokeChannelAuthorizationRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ChannelAuthorizationEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  ChannelPackages_build: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['BuildChannelPackageRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ChannelPackageEnvelopeSchema'];
        };
      };
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ChannelPackageEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  ChannelPackages_getPreview: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        packageId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ChannelPackageEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  ChannelPackages_export: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        packageId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/vnd.aeostudio.channel-package+json': components['schemas']['ChannelPackageExportSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Channels_list: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ChannelRegistryEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Claims_createClaim: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['CreateClaimRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ClaimEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Claims_getClaim: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        claimId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ClaimCurrentStateEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Claims_getClaimRevision: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        claimId: string;
        revisionId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ClaimEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Claims_getEvidenceDrillDown: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        claimId: string;
        revisionId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ClaimEvidenceDrillDownEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Claims_reviewClaim: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        claimId: string;
        revisionId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['ReviewClaimRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ClaimReviewEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Claims_submitClaim: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        claimId: string;
        revisionId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['SubmitClaimRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ClaimEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Claims_listApprovedClaims: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApprovedClaimListEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  ContentPlans_start: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['StartContentPlanRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['StartContentPlanEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  ContentPlans_get: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        planId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ContentPlanBundleEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  ContentPlans_reviewBrief: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        briefId: string;
        planId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['ReviewBriefRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['BriefReviewEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  ContentPlans_listApprovedBriefs: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApprovedBriefListEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Claims_createSource: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['CreateEvidenceSourceRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['EvidenceSourceEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Claims_createSnapshot: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        sourceId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['CreateEvidenceSnapshotRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['EvidenceSnapshotEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Experiments_create: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['CreateExperimentRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ExperimentEnvelopeSchema'];
        };
      };
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ExperimentEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      501: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Experiments_get: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        experimentId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ExperimentEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Experiments_listOptions: {
    parameters: {
      query?: {
        limit?: string;
      };
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ExperimentOptionsEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Tenancy_inviteMembership: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['InviteMembershipRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['MembershipEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Jobs_submitJob: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['SubmitJobRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['JobEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Jobs_getJob: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        jobId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['JobEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Jobs_cancelJob: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        jobId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['JobEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Measurement_submitManualImport: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['SubmitManualMeasurementImportRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ManualMeasurementImportEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Measurement_getManualImport: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        manualImportId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ManualMeasurementImportDetailEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Measurement_reviewManualImport: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        manualImportId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['ReviewManualMeasurementImportRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ManualMeasurementImportEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Measurement_getProviderPolicyState: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        providerKey: string;
        surfaceKey: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['MeasurementProviderPolicyStateEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Measurement_setProviderPolicy: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        providerKey: string;
        surfaceKey: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['MeasurementProviderPolicyRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['MeasurementProviderPolicyEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Prompts_registry: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['PromptRegistryEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Measurement_start: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['StartMeasurementRunRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['StartMeasurementRunEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Measurement_getRun: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        measurementRunId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['MeasurementRunEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Measurement_dashboard: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        measurementRunId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['MeasurementDashboardEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Measurement_listPromptRuns: {
    parameters: {
      query?: {
        dimension?: string;
        limit?: string;
        offset?: string;
        scopeKey?: string;
      };
      header?: never;
      path: {
        measurementRunId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['MeasurementPromptRunListEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Measurement_getPromptRun: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        measurementRunId: string;
        promptRunId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['PromptRunEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Tenancy_revokeMembership: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        membershipId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['MembershipEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Tenancy_changeMembershipRole: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        membershipId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['ChangeMembershipRoleRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['MembershipEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Tenancy_acceptMembership: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        membershipId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['MembershipEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  ProfileOffering_listOfferings: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['OfferingListEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  ProfileOffering_createOfferingRevision: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        offeringId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['OfferingInputSchema'];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['OfferingEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  ProfileOffering_getOfferingRevision: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        offeringId: string;
        revision: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['OfferingEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Privacy_sealAuditDigest: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['ExportTenantRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['AuditDigestEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Privacy_auditEvents: {
    parameters: {
      query?: {
        cursor?: string;
        from?: string;
        limit?: string;
        to?: string;
      };
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['AuditTimelineEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Privacy_auditIntegrity: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['AuditIntegrityEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Privacy_deleteTenant: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['RequestDeletionRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['TenantDeletionReceiptEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Privacy_deleteWorkspace: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['RequestDeletionRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['TenantDeletionReceiptEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Privacy_exportTenant: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['ExportTenantRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['TenantExportEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Privacy_downloadExport: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        exportId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success response is not yet represented by an exported Zod schema */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': string;
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Privacy_legalHolds: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['LegalHoldListEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Privacy_createLegalHold: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['CreateLegalHoldRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['LegalHoldEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Privacy_releaseLegalHold: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        holdId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['LegalHoldEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Privacy_overview: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['PrivacyOverviewEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  ProfileOffering_listProfiles: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ProfileListEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  ProfileOffering_createProfile: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['ProfileInputSchema'];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ProfileEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  ProfileOffering_createOffering: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        profileId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['OfferingInputSchema'];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['OfferingEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  ProfileOffering_createProfileRevision: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        profileId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['ProfileInputSchema'];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ProfileEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  ProfileOffering_getProfileRevision: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        profileId: string;
        revision: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ProfileEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Prompts_current: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        promptSetId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['PromptBundleEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Prompts_revise: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        promptSetId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['CreatePromptRevisionRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['PromptBundleEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Prompts_revision: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        promptSetId: string;
        revisionId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['PromptBundleEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Prompts_approve: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        promptSetId: string;
        revisionId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['ApprovePromptRevisionRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['PromptBundleEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Prompts_listApproved: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApprovedPromptSetListEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Prompts_propose: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['ProposePromptSetRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['PromptBundleEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Publications_requestPublication: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['RequestPublicationSchema'];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['PublicationCommandEnvelopeSchema'];
        };
      };
      /** @description Success */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['PublicationCommandEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json':
            | components['schemas']['ExportOnlyPublicationProblemSchema']
            | components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json':
            | components['schemas']['ExportOnlyPublicationProblemSchema']
            | components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json':
            | components['schemas']['ExportOnlyPublicationProblemSchema']
            | components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json':
            | components['schemas']['ExportOnlyPublicationProblemSchema']
            | components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json':
            | components['schemas']['ExportOnlyPublicationProblemSchema']
            | components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      501: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json':
            | components['schemas']['ExportOnlyPublicationProblemSchema']
            | components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Publications_getPublication: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        publicationId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['PublicationDetailEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Publications_refreshRemoteStatus: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        publicationId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['PublicationRemoteStatusRefreshEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      501: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      502: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Publications_checkEligibility: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['CheckPublicationEligibilitySchema'];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['PublicationEligibilityEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  SignedWebhookEndpointVerifications_list: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SignedWebhookEndpointVerificationListEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  SignedWebhookEndpointVerifications_create: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['CreateSignedWebhookEndpointVerificationRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['CreatedSignedWebhookEndpointVerificationEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  SignedWebhookEndpointVerifications_revoke: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        verificationId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['RevokeSignedWebhookEndpointVerificationRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SignedWebhookEndpointVerificationEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  SignedWebhookEndpointVerifications_verify: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        verificationId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['VerifySignedWebhookEndpointVerificationRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SignedWebhookEndpointVerificationEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Sites_registerSite: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['CreateSiteRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SiteEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Sites_getSite: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        siteId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SiteEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Sites_getBaseline: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        siteId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SiteBaselineEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Sites_startCrawl: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        siteId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['StartCrawlRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['JobEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Sites_createVerification: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        siteId: string;
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['CreateSiteVerificationRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SiteVerificationEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Sites_completeVerification: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        siteId: string;
        tenantId: string;
        verificationId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['CompleteSiteVerificationRequestSchema'];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SiteEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Sites_listBaselines: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
        workspaceId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SiteBaselineListEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Request rejected */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Health_health: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['HealthEnvelopeSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
  Health_ready: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['HealthEnvelopeSchema'];
        };
      };
      /** @description Request rejected */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
      /** @description Unhandled error */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['ProblemDetailsSchema'];
        };
      };
    };
  };
}
