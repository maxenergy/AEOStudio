import type { PrivacyAuditStore } from '@aeostudio/application/privacy-audit';
import type { AuditIntegrityVerification } from '@aeostudio/contracts/privacy-audit';

const unavailable = (): Promise<never> =>
  Promise.reject(new Error('PRIVACY_AUDIT_STORE_NOT_CONFIGURED'));

export class MissingPrivacyAuditStore implements PrivacyAuditStore {
  loadTenantExportObjects(): ReturnType<PrivacyAuditStore['loadTenantExportObjects']> {
    return Promise.resolve({ outcome: 'PIPELINE_UNAVAILABLE' });
  }

  saveTenantExport(): ReturnType<PrivacyAuditStore['saveTenantExport']> {
    return Promise.resolve({ outcome: 'PIPELINE_UNAVAILABLE' });
  }

  getPrivacyOverview(): ReturnType<PrivacyAuditStore['getPrivacyOverview']> {
    return unavailable();
  }

  listAuditEvents(): ReturnType<PrivacyAuditStore['listAuditEvents']> {
    return unavailable();
  }

  requestTenantDeletion(): ReturnType<PrivacyAuditStore['requestTenantDeletion']> {
    return Promise.resolve({ outcome: 'PIPELINE_UNAVAILABLE' });
  }

  requestWorkspaceDeletion(): ReturnType<PrivacyAuditStore['requestWorkspaceDeletion']> {
    return Promise.resolve({ outcome: 'PIPELINE_UNAVAILABLE' });
  }

  finalizeDeletion(): ReturnType<PrivacyAuditStore['finalizeDeletion']> {
    return Promise.resolve({ outcome: 'PIPELINE_UNAVAILABLE' });
  }

  claimDueDeletionRequests(): ReturnType<PrivacyAuditStore['claimDueDeletionRequests']> {
    return unavailable();
  }

  claimDueSecretDeletions(): ReturnType<PrivacyAuditStore['claimDueSecretDeletions']> {
    return unavailable();
  }

  markSecretDeletionRequested(): ReturnType<PrivacyAuditStore['markSecretDeletionRequested']> {
    return unavailable();
  }

  markSecretUnreadable(): ReturnType<PrivacyAuditStore['markSecretUnreadable']> {
    return unavailable();
  }

  createLegalHold(): ReturnType<PrivacyAuditStore['createLegalHold']> {
    return unavailable();
  }

  listLegalHolds(): ReturnType<PrivacyAuditStore['listLegalHolds']> {
    return unavailable();
  }

  releaseLegalHold(): ReturnType<PrivacyAuditStore['releaseLegalHold']> {
    return unavailable();
  }

  grantBreakGlass(): ReturnType<PrivacyAuditStore['grantBreakGlass']> {
    return unavailable();
  }

  evaluateBreakGlassAccess(): ReturnType<PrivacyAuditStore['evaluateBreakGlassAccess']> {
    return unavailable();
  }

  revokeBreakGlass(): ReturnType<PrivacyAuditStore['revokeBreakGlass']> {
    return unavailable();
  }

  verifyAuditChain(): Promise<AuditIntegrityVerification> {
    return Promise.resolve({
      valid: false,
      eventCount: 0,
      lastSequence: 0,
      headHash: null,
      reason: 'The immutable audit store is not configured.',
    });
  }

  verifyAuditRange(): Promise<AuditIntegrityVerification> {
    return this.verifyAuditChain();
  }

  sealAuditDigest(): ReturnType<PrivacyAuditStore['sealAuditDigest']> {
    return Promise.resolve({ outcome: 'PIPELINE_UNAVAILABLE' });
  }
}
