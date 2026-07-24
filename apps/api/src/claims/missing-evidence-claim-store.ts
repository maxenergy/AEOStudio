import type { EvidenceClaimStore } from '@aeostudio/application/evidence-claims';

export class MissingEvidenceClaimStore implements EvidenceClaimStore {
  createSource(): ReturnType<EvidenceClaimStore['createSource']> {
    return Promise.reject(new Error('EVIDENCE_CLAIM_STORE_NOT_CONFIGURED'));
  }

  createSnapshot(): ReturnType<EvidenceClaimStore['createSnapshot']> {
    return Promise.reject(new Error('EVIDENCE_CLAIM_STORE_NOT_CONFIGURED'));
  }

  findSnapshots(): ReturnType<EvidenceClaimStore['findSnapshots']> {
    return Promise.reject(new Error('EVIDENCE_CLAIM_STORE_NOT_CONFIGURED'));
  }

  createClaim(): ReturnType<EvidenceClaimStore['createClaim']> {
    return Promise.reject(new Error('EVIDENCE_CLAIM_STORE_NOT_CONFIGURED'));
  }

  submitClaim(): ReturnType<EvidenceClaimStore['submitClaim']> {
    return Promise.reject(new Error('EVIDENCE_CLAIM_STORE_NOT_CONFIGURED'));
  }

  findClaimForReview(): ReturnType<EvidenceClaimStore['findClaimForReview']> {
    return Promise.reject(new Error('EVIDENCE_CLAIM_STORE_NOT_CONFIGURED'));
  }

  reviewClaim(): ReturnType<EvidenceClaimStore['reviewClaim']> {
    return Promise.reject(new Error('EVIDENCE_CLAIM_STORE_NOT_CONFIGURED'));
  }

  findEvidenceDrillDown(): ReturnType<EvidenceClaimStore['findEvidenceDrillDown']> {
    return Promise.reject(new Error('EVIDENCE_CLAIM_STORE_NOT_CONFIGURED'));
  }

  findCurrentClaim(): ReturnType<EvidenceClaimStore['findCurrentClaim']> {
    return Promise.reject(new Error('EVIDENCE_CLAIM_STORE_NOT_CONFIGURED'));
  }

  listApprovedClaims(): ReturnType<EvidenceClaimStore['listApprovedClaims']> {
    return Promise.reject(new Error('EVIDENCE_CLAIM_STORE_NOT_CONFIGURED'));
  }
}
