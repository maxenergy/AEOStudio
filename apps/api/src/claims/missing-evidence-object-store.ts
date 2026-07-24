import type { EvidenceObjectStore } from '@aeostudio/application/evidence-claims';

export class MissingEvidenceObjectStore implements EvidenceObjectStore {
  ingestExact(): ReturnType<EvidenceObjectStore['ingestExact']> {
    return Promise.reject(new Error('EVIDENCE_OBJECT_STORE_NOT_CONFIGURED'));
  }

  readExact(): ReturnType<EvidenceObjectStore['readExact']> {
    return Promise.reject(new Error('EVIDENCE_OBJECT_STORE_NOT_CONFIGURED'));
  }
}
