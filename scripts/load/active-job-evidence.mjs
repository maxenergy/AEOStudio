import { createHash } from 'node:crypto';

import {
  ACTIVE_JOB_CANONICALIZATION,
  activeJobRecordsCanonicalPayload,
  canonicalActiveJobRecords,
  REQUIRED_ACTIVE_JOB_COUNT,
} from './task-18-load-contract.mjs';

export function buildActiveJobsEvidence(input) {
  const records = canonicalActiveJobRecords(input.records);
  const tenantCounts = new Map();
  for (const record of records) {
    tenantCounts.set(record.tenantId, (tenantCounts.get(record.tenantId) ?? 0) + 1);
  }
  return Object.freeze({
    pollingRound: input.pollingRound,
    status: 'RUNNING',
    count: REQUIRED_ACTIVE_JOB_COUNT,
    tenantCount: tenantCounts.size,
    maximumPerTenant: Math.max(...tenantCounts.values()),
    canonicalization: ACTIVE_JOB_CANONICALIZATION,
    records,
    sha256: createHash('sha256')
      .update(activeJobRecordsCanonicalPayload({ pollingRound: input.pollingRound, records }))
      .digest('hex'),
  });
}

export function validateActiveJobsEvidence(value, acceptedJobIds) {
  const evidence = object(value, 'LOAD_ACTIVE_JOBS_INVALID');
  if (
    !sameStringSet(Object.keys(evidence), [
      'canonicalization',
      'count',
      'maximumPerTenant',
      'pollingRound',
      'records',
      'sha256',
      'status',
      'tenantCount',
    ]) ||
    evidence.status !== 'RUNNING' ||
    evidence.count !== REQUIRED_ACTIVE_JOB_COUNT ||
    evidence.tenantCount !== 10 ||
    evidence.maximumPerTenant !== 5 ||
    evidence.canonicalization !== ACTIVE_JOB_CANONICALIZATION
  ) {
    throw new Error('LOAD_ACTIVE_JOBS_INVALID');
  }
  const canonical = buildActiveJobsEvidence({
    pollingRound: evidence.pollingRound,
    records: evidence.records,
  });
  if (!sameJson(evidence.records, canonical.records) || evidence.sha256 !== canonical.sha256) {
    throw new Error('LOAD_ACTIVE_JOBS_HASH_MISMATCH');
  }
  const accepted = new Set(acceptedJobIds);
  if (
    accepted.size !== REQUIRED_ACTIVE_JOB_COUNT ||
    canonical.records.some((record) => !accepted.has(record.jobId))
  ) {
    throw new Error('LOAD_ACTIVE_JOBS_ACCEPTED_SET_MISMATCH');
  }
  return canonical;
}

function object(value, errorCode) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(errorCode);
  }
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameStringSet(left, right) {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}
