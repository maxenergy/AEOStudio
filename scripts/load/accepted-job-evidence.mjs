import { createHash } from 'node:crypto';

import {
  ACCEPTED_JOB_ID_CANONICALIZATION,
  acceptedJobIdsCanonicalPayload,
  canonicalAcceptedJobIds,
  REQUIRED_ACCEPTED_JOB_COUNT,
} from './task-18-load-contract.mjs';

export function buildAcceptedJobsEvidence(values) {
  const ids = canonicalAcceptedJobIds(values);
  return Object.freeze({
    count: REQUIRED_ACCEPTED_JOB_COUNT,
    canonicalization: ACCEPTED_JOB_ID_CANONICALIZATION,
    ids,
    sha256: createHash('sha256').update(acceptedJobIdsCanonicalPayload(ids)).digest('hex'),
  });
}

export function validateAcceptedJobsEvidence(value) {
  const evidence = object(value, 'LOAD_ACCEPTED_JOBS_INVALID');
  if (
    !sameStringSet(Object.keys(evidence), ['canonicalization', 'count', 'ids', 'sha256']) ||
    evidence.count !== REQUIRED_ACCEPTED_JOB_COUNT ||
    evidence.canonicalization !== ACCEPTED_JOB_ID_CANONICALIZATION
  ) {
    throw new Error('LOAD_ACCEPTED_JOBS_INVALID');
  }
  const canonical = buildAcceptedJobsEvidence(evidence.ids);
  if (!sameOrderedStrings(evidence.ids, canonical.ids) || evidence.sha256 !== canonical.sha256) {
    throw new Error('LOAD_ACCEPTED_JOBS_HASH_MISMATCH');
  }
  return canonical;
}

function object(value, errorCode) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(errorCode);
  }
  return value;
}

function sameOrderedStrings(left, right) {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameStringSet(left, right) {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}
