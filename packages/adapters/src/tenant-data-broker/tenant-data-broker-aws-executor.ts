import { createHash } from 'node:crypto';

import type { TenantDataAuthorization } from '@aeostudio/application/tenant-data-access';

const MEBIBYTE = 1_024 * 1_024;
const MAX_OBJECT_BYTES = 2 * 1_024 * MEBIBYTE;
const FIXED_MULTIPART_PART_BYTES = 5 * MEBIBYTE;
const CLEANUP_TIMEOUT_MS = 30_000;
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BUCKET = /^(?=.{3,63}$)(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/u;
const CONTENT_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:[ -~]*)?$/u;

type CloudRecord = Record<string, unknown>;
type AuthorizedGrant = Extract<TenantDataAuthorization, { outcome: 'AUTHORIZED' }>['grant'];

export interface TenantDataBrokerS3Port {
  putObject(input: CloudRecord, signal: AbortSignal): Promise<CloudRecord>;
  createMultipartUpload(input: CloudRecord, signal: AbortSignal): Promise<CloudRecord>;
  uploadPart(input: CloudRecord, signal: AbortSignal): Promise<CloudRecord>;
  completeMultipartUpload(input: CloudRecord, signal: AbortSignal): Promise<CloudRecord>;
  abortMultipartUpload(input: CloudRecord, signal: AbortSignal): Promise<CloudRecord>;
  listParts(input: CloudRecord, signal: AbortSignal): Promise<CloudRecord>;
  getObject(input: CloudRecord, signal: AbortSignal): Promise<CloudRecord>;
  headObject(input: CloudRecord, signal: AbortSignal): Promise<CloudRecord>;
  deleteObject(input: CloudRecord, signal: AbortSignal): Promise<CloudRecord>;
  listObjectVersions(input: CloudRecord, signal: AbortSignal): Promise<CloudRecord>;
  getObjectLegalHold(input: CloudRecord, signal: AbortSignal): Promise<CloudRecord>;
  putObjectLegalHold(input: CloudRecord, signal: AbortSignal): Promise<CloudRecord>;
}

export interface TenantDataBrokerSecretsPort {
  describeSecret(input: CloudRecord, signal: AbortSignal): Promise<CloudRecord>;
  getSecretValue(input: CloudRecord, signal: AbortSignal): Promise<CloudRecord>;
  deleteSecret(input: CloudRecord, signal: AbortSignal): Promise<CloudRecord>;
}

export interface AwsTenantDataBrokerExecutorOptions {
  artifactBucket: string;
  auditEvidenceBucket: string;
  expectedBucketOwner: string;
  kmsKeyArn: string;
  multipartPartBytes: number;
  s3: TenantDataBrokerS3Port;
  secrets: TenantDataBrokerSecretsPort;
}

export interface AwsTenantDataBrokerExecutor {
  execute(input: {
    grant: AuthorizedGrant;
    body: AsyncIterable<Uint8Array>;
    signal: AbortSignal;
    deadline: Date;
  }): Promise<unknown>;
}

interface ValidatedOptions extends AwsTenantDataBrokerExecutorOptions {
  artifactBucket: string;
  auditEvidenceBucket: string;
  expectedBucketOwner: string;
  kmsKeyArn: string;
  multipartPartBytes: typeof FIXED_MULTIPART_PART_BYTES;
}

interface ValidatedGrant {
  capabilityId: string;
  authorityKind: string;
  authorityReference: string;
  scopeKind: 'TENANT' | 'WORKSPACE';
  tenantId: string;
  workspaceId: string | null;
  operation: string;
  resource: CloudRecord;
  expiresAt: string;
}

interface OperationContext {
  signal: AbortSignal;
  abort(reason: unknown): void;
  dispose(): void;
}

/**
 * Streaming, authority-bound AWS data-plane executor. The normalized ports
 * deliberately keep AWS SDK command objects outside the application boundary.
 */
export function createAwsTenantDataBrokerExecutor(
  rawOptions: AwsTenantDataBrokerExecutorOptions,
): AwsTenantDataBrokerExecutor {
  const options = validateOptions(rawOptions);
  return {
    async execute(input) {
      const context = createOperationContext(input.signal, input.deadline);
      let contextOwnedByStream = false;
      try {
        const grant = validateGrant(input.grant, options);
        if (!isAsyncByteIterable(input.body)) {
          throw new Error('TENANT_DATA_BROKER_BODY_INVALID');
        }
        switch (grant.operation) {
          case 'PUT_WORKLOAD_OBJECT':
          case 'PUT_PRIVACY_OBJECT':
            return await executePut(options, grant, input.body, context);
          case 'READ_WORKLOAD_OBJECT':
          case 'READ_PRIVACY_OBJECT': {
            const result = await executeGet(options, grant, input.body, context);
            contextOwnedByStream = true;
            return result;
          }
          case 'READ_CONNECTOR_SECRET':
          case 'DESCRIBE_CONNECTOR_SECRET':
          case 'VERIFY_CONNECTOR_SECRET_UNREADABLE':
          case 'DELETE_CONNECTOR_SECRET':
            return await executeSecretOperation(options, grant, input.body, context);
          case 'HEAD_WORKLOAD_OBJECT':
          case 'HEAD_PRIVACY_OBJECT':
            return await executeHead(options, grant, input.body, context);
          case 'DELETE_WORKLOAD_OBJECT_VERSION':
          case 'DELETE_PRIVACY_OBJECT_VERSION':
            return await executeDelete(options, grant, input.body, context);
          case 'LIST_TENANT_OBJECT_VERSIONS':
            return await executeInventory(options, grant, input.body, context);
          case 'GET_OBJECT_LEGAL_HOLD':
          case 'SET_OBJECT_LEGAL_HOLD':
            return await executeLegalHold(options, grant, input.body, context);
          default:
            throw new Error('TENANT_DATA_BROKER_OPERATION_UNSUPPORTED');
        }
      } finally {
        if (!contextOwnedByStream) context.dispose();
      }
    },
  };
}

async function executePut(
  options: ValidatedOptions,
  grant: ValidatedGrant,
  body: AsyncIterable<Uint8Array>,
  context: OperationContext,
): Promise<unknown> {
  const resource = grant.resource;
  const byteLength = readByteLength(resource.byteLength);
  const checksum = readSha256(resource.checksumSha256);
  const contentType = readContentType(resource.contentType);
  if (byteLength >= options.multipartPartBytes) {
    return executeMultipartPut(options, grant, body, context, byteLength, checksum, contentType);
  }
  const validatedBody = createValidatedBody(body, {
    byteLength,
    checksum,
    signal: context.signal,
  });
  const result = await callWithSignal(
    () =>
      options.s3.putObject(
        {
          ...putIdentity(options, grant),
          body: validatedBody.body,
          bucketKeyEnabled: true,
          checksumSha256: hexToBase64(checksum),
          contentLength: byteLength,
          contentType,
          ifNoneMatch: '*',
          metadata: { 'aeostudio-direct-sha256': checksum },
          serverSideEncryption: 'aws:kms',
          sseKmsKeyId: options.kmsKeyArn,
          ...retentionFields(resource),
        },
        context.signal,
      ),
    context.signal,
  );
  validatedBody.assertComplete();
  const versionId = readVersionId(result.versionId);
  return putReceipt(grant, versionId, checksum, contentType, byteLength);
}

interface CompletedPart {
  checksumSha256: string;
  etag: string;
  partNumber: number;
}

interface SettledUpload {
  error?: unknown;
  task: Promise<void>;
}

async function executeMultipartPut(
  options: ValidatedOptions,
  grant: ValidatedGrant,
  body: AsyncIterable<Uint8Array>,
  context: OperationContext,
  byteLength: number,
  checksum: string,
  contentType: string,
): Promise<unknown> {
  const identity = putIdentity(options, grant);
  let uploadId: string | null = null;
  const iterator = body[Symbol.asyncIterator]();
  const completedParts: CompletedPart[] = [];
  const activeUploads = new Map<Promise<void>, Promise<SettledUpload>>();
  const directHash = createHash('sha256');
  let observedLength = 0;
  let partNumber = 0;
  let accumulator = new Uint8Array(options.multipartPartBytes);
  let accumulatorLength = 0;

  const schedulePart = async (part: Uint8Array): Promise<void> => {
    partNumber += 1;
    const currentPartNumber = partNumber;
    const partChecksum = hexToBase64(createHash('sha256').update(part).digest('hex'));
    const task = callWithSignal(async () => {
      const result = await options.s3.uploadPart(
        {
          ...identity,
          body: oneChunkBody(part),
          checksumSha256: partChecksum,
          contentLength: part.byteLength,
          partNumber: currentPartNumber,
          uploadId,
        },
        context.signal,
      );
      const etag = readEtag(result.etag);
      if (result.checksumSha256 !== undefined && result.checksumSha256 !== partChecksum) {
        throw new Error('TENANT_DATA_BROKER_PART_CHECKSUM_MISMATCH');
      }
      completedParts.push({
        checksumSha256: partChecksum,
        etag,
        partNumber: currentPartNumber,
      });
    }, context.signal);
    const settled = task.then<SettledUpload, SettledUpload>(
      () => ({ task }),
      (error: unknown) => ({ error, task }),
    );
    activeUploads.set(task, settled);
    if (activeUploads.size >= 2) await waitForOneUpload(activeUploads);
  };

  try {
    const created = await callWithSignal(
      () =>
        options.s3.createMultipartUpload(
          {
            ...identity,
            bucketKeyEnabled: true,
            checksumAlgorithm: 'SHA256',
            checksumType: 'COMPOSITE',
            contentType,
            metadata: { 'aeostudio-direct-sha256': checksum },
            serverSideEncryption: 'aws:kms',
            sseKmsKeyId: options.kmsKeyArn,
            ...retentionFields(grant.resource),
          },
          context.signal,
        ),
      context.signal,
    );
    uploadId = readUploadId(created.uploadId);

    while (true) {
      assertActive(context.signal);
      const next = await callWithSignal(() => iterator.next(), context.signal);
      if (next.done) break;
      const chunk = next.value;
      if (!(chunk instanceof Uint8Array)) {
        throw new Error('TENANT_DATA_BROKER_BODY_CHUNK_INVALID');
      }
      if (chunk.byteLength === 0) continue;
      observedLength += chunk.byteLength;
      if (observedLength > byteLength) {
        throw new Error('TENANT_DATA_BROKER_BODY_LENGTH_MISMATCH');
      }
      directHash.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        assertActive(context.signal);
        const copyLength = Math.min(
          accumulator.byteLength - accumulatorLength,
          chunk.byteLength - offset,
        );
        accumulator.set(chunk.subarray(offset, offset + copyLength), accumulatorLength);
        accumulatorLength += copyLength;
        offset += copyLength;
        if (accumulatorLength === accumulator.byteLength) {
          const fullPart = accumulator;
          accumulator = new Uint8Array(options.multipartPartBytes);
          accumulatorLength = 0;
          await schedulePart(fullPart);
        }
      }
    }

    if (accumulatorLength > 0) {
      await schedulePart(accumulator.slice(0, accumulatorLength));
    }
    await drainUploads(activeUploads);
    if (observedLength !== byteLength || directHash.digest('hex') !== checksum) {
      throw new Error('TENANT_DATA_BROKER_BODY_INTEGRITY_MISMATCH');
    }
    const parts = completedParts.sort((left, right) => left.partNumber - right.partNumber);
    const completed = await callWithSignal(
      () =>
        options.s3.completeMultipartUpload(
          {
            ...identity,
            checksumType: 'COMPOSITE',
            ifNoneMatch: '*',
            mpuObjectSize: byteLength,
            parts,
            uploadId,
          },
          context.signal,
        ),
      context.signal,
    );
    return putReceipt(grant, readVersionId(completed.versionId), checksum, contentType, byteLength);
  } catch (error: unknown) {
    context.abort(error);
    await Promise.allSettled([...activeUploads.keys()]);
    if (typeof iterator.return === 'function') {
      await iterator.return().catch(() => undefined);
    }
    if (uploadId !== null) {
      await cleanupMultipart(options, identity, uploadId);
    }
    throw error;
  }
}

async function waitForOneUpload(active: Map<Promise<void>, Promise<SettledUpload>>): Promise<void> {
  const settled = await Promise.race(active.values());
  active.delete(settled.task);
  if ('error' in settled) throw settled.error;
}

async function drainUploads(active: Map<Promise<void>, Promise<SettledUpload>>): Promise<void> {
  while (active.size > 0) await waitForOneUpload(active);
}

async function cleanupMultipart(
  options: ValidatedOptions,
  identity: {
    bucket: string;
    expectedBucketOwner: string;
    key: string;
  },
  uploadId: string,
): Promise<void> {
  const signal = AbortSignal.timeout(CLEANUP_TIMEOUT_MS);
  try {
    while (!signal.aborted) {
      await callWithSignal(
        () => options.s3.abortMultipartUpload({ ...identity, uploadId }, signal),
        signal,
      );
      const remaining = await callWithSignal(
        () => options.s3.listParts({ ...identity, uploadId }, signal),
        signal,
      );
      if (!hasRemainingParts(remaining.parts)) return;
    }
  } catch {
    // Cleanup is bounded and best-effort. The durable broker attempt remains
    // UNKNOWN, so the same remote effect is never blindly repeated.
  }
}

function hasRemainingParts(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function oneChunkBody(chunk: Uint8Array): AsyncIterable<Uint8Array> {
  let consumed = false;
  return {
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      if (consumed) throw new Error('TENANT_DATA_BROKER_PART_BODY_REUSED');
      consumed = true;
      yield chunk;
    },
  };
}

async function executeGet(
  options: ValidatedOptions,
  grant: ValidatedGrant,
  requestBody: AsyncIterable<Uint8Array>,
  context: OperationContext,
): Promise<unknown> {
  await requireEmptyBody(requestBody, context.signal);
  const resource = grant.resource;
  const expectedVersionId = readVersionId(resource.versionId);
  const expectedChecksum = readSha256(resource.checksumSha256);
  const expectedContentType = readContentType(resource.contentType);
  const expectedByteLength = readByteLength(resource.byteLength);
  const identity = objectIdentity(options, grant, true);
  const result = await callWithSignal(
    () =>
      options.s3.getObject(
        {
          ...identity,
          checksumMode: 'ENABLED',
        },
        context.signal,
      ),
    context.signal,
  );
  const upstream = result.body;
  const metadata = result.metadata;
  if (
    !isAsyncByteIterable(upstream) ||
    !isPlainRecord(metadata) ||
    metadata['aeostudio-direct-sha256'] !== expectedChecksum ||
    result.versionId !== expectedVersionId ||
    result.contentType !== expectedContentType ||
    result.byteLength !== expectedByteLength ||
    typeof result.checksumSha256 !== 'string' ||
    result.checksumSha256.length < 1
  ) {
    if (isAsyncByteIterable(upstream)) await closeAsyncIterable(upstream);
    throw new Error('TENANT_DATA_BROKER_GET_METADATA_MISMATCH');
  }
  const responseBody = createAbortableValidatedStream(upstream, {
    byteLength: expectedByteLength,
    checksum: expectedChecksum,
    signal: context.signal,
    onClose: () => {
      context.dispose();
    },
  });
  return {
    kind: 'OBJECT_STREAM',
    bucket: identity.bucket,
    key: identity.key,
    versionId: expectedVersionId,
    checksum: expectedChecksum,
    contentType: expectedContentType,
    byteLength: expectedByteLength,
    transportChecksumSha256: result.checksumSha256,
    body: responseBody,
  };
}

async function requireEmptyBody(
  body: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): Promise<void> {
  const iterator = body[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await callWithSignal(() => iterator.next(), signal);
      if (next.done) return;
      if (!(next.value instanceof Uint8Array) || next.value.byteLength > 0) {
        throw new Error('TENANT_DATA_BROKER_UNEXPECTED_REQUEST_BODY');
      }
    }
  } finally {
    if (typeof iterator.return === 'function') {
      await iterator.return().catch(() => undefined);
    }
  }
}

function createAbortableValidatedStream(
  source: AsyncIterable<Uint8Array>,
  options: {
    byteLength: number;
    checksum: string;
    signal: AbortSignal;
    onClose(): void;
  },
): AsyncIterable<Uint8Array> {
  let iteratorCreated = false;
  let iterator: AsyncIterator<Uint8Array> | null = null;
  let closed = false;
  let observedLength = 0;
  const hash = createHash('sha256');

  const finish = async (returnUpstream: boolean): Promise<void> => {
    if (closed) return;
    closed = true;
    options.signal.removeEventListener('abort', onAbort);
    try {
      if (returnUpstream && iterator !== null && typeof iterator.return === 'function') {
        await iterator.return();
      }
    } finally {
      options.onClose();
    }
  };
  const onAbort = () => {
    void finish(true);
  };
  options.signal.addEventListener('abort', onAbort, { once: true });

  return {
    [Symbol.asyncIterator]() {
      if (iteratorCreated) {
        throw new Error('TENANT_DATA_BROKER_RESPONSE_BODY_REUSED');
      }
      iteratorCreated = true;
      iterator = source[Symbol.asyncIterator]();
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          if (closed || options.signal.aborted) {
            await finish(true);
            throw new Error('TENANT_DATA_BROKER_RESPONSE_ABORTED');
          }
          let next: IteratorResult<Uint8Array>;
          try {
            next = await callWithSignal(() => iterator!.next(), options.signal);
          } catch (error: unknown) {
            await finish(true);
            throw error;
          }
          if (next.done) {
            const actualChecksum = hash.digest('hex');
            await finish(false);
            if (observedLength !== options.byteLength || actualChecksum !== options.checksum) {
              throw new Error('TENANT_DATA_BROKER_GET_BODY_INTEGRITY_MISMATCH');
            }
            return { done: true, value: undefined };
          }
          if (!(next.value instanceof Uint8Array)) {
            await finish(true);
            throw new Error('TENANT_DATA_BROKER_BODY_CHUNK_INVALID');
          }
          observedLength += next.value.byteLength;
          if (observedLength > options.byteLength) {
            await finish(true);
            throw new Error('TENANT_DATA_BROKER_GET_BODY_LENGTH_MISMATCH');
          }
          hash.update(next.value);
          return next;
        },
        async return(): Promise<IteratorResult<Uint8Array>> {
          await finish(true);
          return { done: true, value: undefined };
        },
        async throw(error?: unknown): Promise<IteratorResult<Uint8Array>> {
          await finish(true);
          throw error;
        },
      };
    },
  };
}

async function closeAsyncIterable(value: AsyncIterable<Uint8Array>): Promise<void> {
  try {
    const iterator = value[Symbol.asyncIterator]();
    if (typeof iterator.return === 'function') await iterator.return();
  } catch {
    // Release is best-effort on an already rejected remote response.
  }
}

async function executeSecretOperation(
  options: ValidatedOptions,
  grant: ValidatedGrant,
  requestBody: AsyncIterable<Uint8Array>,
  context: OperationContext,
): Promise<unknown> {
  await requireEmptyBody(requestBody, context.signal);
  const secretId = readSecretArn(grant.resource.secretArn);
  switch (grant.operation) {
    case 'READ_CONNECTOR_SECRET': {
      const result = await callWithSignal(
        () => options.secrets.getSecretValue({ secretId }, context.signal),
        context.signal,
      );
      if (
        typeof result.secretString !== 'string' ||
        result.secretString.length < 1 ||
        Buffer.byteLength(result.secretString, 'utf8') > 65_536
      ) {
        throw new Error('TENANT_DATA_BROKER_SECRET_VALUE_INVALID');
      }
      return { kind: 'SECRET_VALUE', value: result.secretString };
    }
    case 'DESCRIBE_CONNECTOR_SECRET': {
      let result: CloudRecord;
      try {
        result = await callWithSignal(
          () => options.secrets.describeSecret({ secretId }, context.signal),
          context.signal,
        );
      } catch (error: unknown) {
        if (isResourceNotFound(error)) {
          return { kind: 'SECRET_DESCRIPTION', exists: false };
        }
        throw error;
      }
      return {
        kind: 'SECRET_DESCRIPTION',
        exists: result.exists !== false,
        ...(isCanonicalInstant(result.deletedAt) ? { deletedAt: result.deletedAt } : {}),
      };
    }
    case 'VERIFY_CONNECTOR_SECRET_UNREADABLE':
      return verifySecretUnreadable(options, secretId, context.signal);
    case 'DELETE_CONNECTOR_SECRET': {
      await callWithSignal(
        () =>
          options.secrets.deleteSecret(
            { forceDeleteWithoutRecovery: true, secretId },
            context.signal,
          ),
        context.signal,
      );
      return { kind: 'SECRET_DELETE_RECEIPT', deleted: true };
    }
    default:
      throw new Error('TENANT_DATA_BROKER_OPERATION_UNSUPPORTED');
  }
}

async function verifySecretUnreadable(
  options: ValidatedOptions,
  secretId: string,
  signal: AbortSignal,
): Promise<{ kind: 'CONNECTOR_SECRET_UNREADABLE'; unreadable: boolean }> {
  let description: CloudRecord;
  try {
    description = await callWithSignal(
      () => options.secrets.describeSecret({ secretId }, signal),
      signal,
    );
  } catch (error: unknown) {
    if (isResourceNotFound(error)) {
      return { kind: 'CONNECTOR_SECRET_UNREADABLE', unreadable: true };
    }
    throw error;
  }
  if (description.exists === false) {
    return { kind: 'CONNECTOR_SECRET_UNREADABLE', unreadable: true };
  }
  try {
    const result = await callWithSignal(
      () => options.secrets.getSecretValue({ secretId }, signal),
      signal,
    );
    if (typeof result.secretString !== 'string' && !(result.secretBinary instanceof Uint8Array)) {
      throw new Error('TENANT_DATA_BROKER_SECRET_PROBE_INVALID');
    }
    return { kind: 'CONNECTOR_SECRET_UNREADABLE', unreadable: false };
  } catch (error: unknown) {
    if (isResourceNotFound(error)) {
      return { kind: 'CONNECTOR_SECRET_UNREADABLE', unreadable: true };
    }
    throw error;
  }
}

function isResourceNotFound(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; name?: unknown };
  return (
    candidate.name === 'ResourceNotFoundException' || candidate.code === 'ResourceNotFoundException'
  );
}

async function executeHead(
  options: ValidatedOptions,
  grant: ValidatedGrant,
  requestBody: AsyncIterable<Uint8Array>,
  context: OperationContext,
): Promise<unknown> {
  await requireEmptyBody(requestBody, context.signal);
  const hasVersion = typeof grant.resource.versionId === 'string';
  const identity = objectIdentity(options, grant, hasVersion);
  let result: CloudRecord;
  try {
    result = await callWithSignal(
      () => options.s3.headObject({ ...identity, checksumMode: 'ENABLED' }, context.signal),
      context.signal,
    );
  } catch (error: unknown) {
    if (isResourceNotFound(error)) {
      return {
        kind: 'OBJECT_HEAD',
        exists: false,
        bucket: identity.bucket,
        key: identity.key,
        ...(hasVersion ? { versionId: identity.versionId } : {}),
      };
    }
    throw error;
  }
  if (result.exists === false) {
    return {
      kind: 'OBJECT_HEAD',
      exists: false,
      bucket: identity.bucket,
      key: identity.key,
      ...(hasVersion ? { versionId: identity.versionId } : {}),
    };
  }
  const expected = headExpectations(grant.resource);
  const metadata = result.metadata;
  const resultVersionId = readVersionId(result.versionId);
  if (
    !isPlainRecord(metadata) ||
    metadata['aeostudio-direct-sha256'] !== expected.checksum ||
    result.contentType !== expected.contentType ||
    result.byteLength !== expected.byteLength ||
    (hasVersion && resultVersionId !== identity.versionId) ||
    (grant.resource.objectClass === 'AUDIT_EVIDENCE' &&
      normalizeInstant(result.objectLockRetainUntilDate) !== grant.resource.lockedUntil)
  ) {
    throw new Error('TENANT_DATA_BROKER_HEAD_METADATA_MISMATCH');
  }
  return {
    kind: 'OBJECT_HEAD',
    exists: true,
    bucket: identity.bucket,
    key: identity.key,
    versionId: resultVersionId,
    checksum: expected.checksum,
    contentType: expected.contentType,
    byteLength: expected.byteLength,
  };
}

function headExpectations(resource: CloudRecord): {
  byteLength: number;
  checksum: string;
  contentType: string;
} {
  if (
    resource.kind === 'WORKLOAD_OBJECT_WRITE_RECOVERY_HEAD' ||
    resource.kind === 'PRIVACY_OBJECT_WRITE_RECOVERY_HEAD'
  ) {
    return {
      byteLength: readByteLength(resource.expectedByteLength),
      checksum: readSha256(resource.expectedChecksumSha256),
      contentType: readContentType(resource.expectedContentType),
    };
  }
  return {
    byteLength: readByteLength(resource.byteLength),
    checksum: readSha256(resource.checksumSha256),
    contentType: readContentType(resource.contentType),
  };
}

async function executeDelete(
  options: ValidatedOptions,
  grant: ValidatedGrant,
  requestBody: AsyncIterable<Uint8Array>,
  context: OperationContext,
): Promise<unknown> {
  await requireEmptyBody(requestBody, context.signal);
  const identity = objectIdentity(options, grant, true);
  const result = await callWithSignal(
    () => options.s3.deleteObject(identity, context.signal),
    context.signal,
  );
  if (
    (result.versionId !== undefined && result.versionId !== identity.versionId) ||
    (result.deleteMarker !== undefined && typeof result.deleteMarker !== 'boolean')
  ) {
    throw new Error('TENANT_DATA_BROKER_DELETE_RECEIPT_INVALID');
  }
  return {
    kind: 'OBJECT_VERSION_DELETED',
    bucket: identity.bucket,
    key: identity.key,
    versionId: identity.versionId,
    isDeleteMarker: grant.resource.isDeleteMarker,
  };
}

async function executeInventory(
  options: ValidatedOptions,
  grant: ValidatedGrant,
  requestBody: AsyncIterable<Uint8Array>,
  context: OperationContext,
): Promise<unknown> {
  await requireEmptyBody(requestBody, context.signal);
  const resource = grant.resource;
  const cursor = resource.cursor as { keyMarker: string; versionIdMarker: string } | null;
  const limit = resource.limit as number;
  const prefix = resource.prefix as string;
  const result = await callWithSignal(
    () =>
      options.s3.listObjectVersions(
        {
          bucket: readBucket(resource.bucket),
          expectedBucketOwner: options.expectedBucketOwner,
          prefix,
          maxKeys: limit,
          ...(cursor === null
            ? {}
            : {
                keyMarker: cursor.keyMarker,
                versionIdMarker: cursor.versionIdMarker,
              }),
        },
        context.signal,
      ),
    context.signal,
  );
  const versions = normalizeInventoryEntries(result.versions, false, prefix);
  const deleteMarkers = normalizeInventoryEntries(result.deleteMarkers, true, prefix);
  if (versions.length + deleteMarkers.length > limit) {
    throw new Error('TENANT_DATA_BROKER_INVENTORY_LIMIT_EXCEEDED');
  }
  const isTruncated = result.isTruncated === true;
  return {
    kind: 'OBJECT_VERSION_INVENTORY',
    objectClass: resource.objectClass,
    versions,
    deleteMarkers,
    isTruncated,
    nextCursor: isTruncated ? readNextInventoryCursor(result) : null,
  };
}

function normalizeInventoryEntries(
  value: unknown,
  isDeleteMarker: boolean,
  prefix: string,
): CloudRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error('TENANT_DATA_BROKER_INVENTORY_RESPONSE_INVALID');
  }
  return value.map((entry: unknown) => {
    if (
      !isPlainRecord(entry) ||
      typeof entry.key !== 'string' ||
      !entry.key.startsWith(prefix) ||
      entry.key.length <= prefix.length
    ) {
      throw new Error('TENANT_DATA_BROKER_INVENTORY_SCOPE_MISMATCH');
    }
    const normalized: CloudRecord = {
      key: readObjectReference(entry.key),
      versionId: readVersionId(entry.versionId),
      isDeleteMarker,
    };
    const modified = normalizeInstant(entry.lastModified);
    if (modified !== null) normalized.lastModified = modified;
    return normalized;
  });
}

function readNextInventoryCursor(result: CloudRecord): {
  keyMarker: string;
  versionIdMarker: string;
} {
  return {
    keyMarker: readObjectReference(result.nextKeyMarker),
    versionIdMarker: readVersionId(result.nextVersionIdMarker),
  };
}

async function executeLegalHold(
  options: ValidatedOptions,
  grant: ValidatedGrant,
  requestBody: AsyncIterable<Uint8Array>,
  context: OperationContext,
): Promise<unknown> {
  await requireEmptyBody(requestBody, context.signal);
  const identity = objectIdentity(options, grant, true);
  if (grant.operation === 'GET_OBJECT_LEGAL_HOLD') {
    const result = await callWithSignal(
      () => options.s3.getObjectLegalHold(identity, context.signal),
      context.signal,
    );
    if (result.status !== 'ON' && result.status !== 'OFF') {
      throw new Error('TENANT_DATA_BROKER_LEGAL_HOLD_RESPONSE_INVALID');
    }
    return { kind: 'OBJECT_LEGAL_HOLD', ...identity, status: result.status };
  }
  const desiredStatus = grant.resource.desiredStatus;
  if (desiredStatus !== 'ON' && desiredStatus !== 'OFF') {
    throw new Error('TENANT_DATA_BROKER_LEGAL_HOLD_STATUS_INVALID');
  }
  await callWithSignal(
    () =>
      options.s3.putObjectLegalHold(
        { ...identity, legalHold: { status: desiredStatus } },
        context.signal,
      ),
    context.signal,
  );
  return {
    kind: 'OBJECT_LEGAL_HOLD_SET',
    ...identity,
    status: desiredStatus,
    revision: grant.resource.revision,
  };
}

function normalizeInstant(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  return isCanonicalInstant(value) ? value : null;
}

function validateOptions(input: AwsTenantDataBrokerExecutorOptions): ValidatedOptions {
  if (input === null || typeof input !== 'object') {
    throw new Error('TENANT_DATA_BROKER_EXECUTOR_OPTIONS_INVALID');
  }
  const artifactBucket = readBucket(input.artifactBucket);
  const auditEvidenceBucket = readBucket(input.auditEvidenceBucket);
  if (artifactBucket === auditEvidenceBucket) {
    throw new Error('TENANT_DATA_BROKER_BUCKETS_MUST_BE_DISTINCT');
  }
  if (!/^\d{12}$/u.test(input.expectedBucketOwner)) {
    throw new Error('TENANT_DATA_BROKER_BUCKET_OWNER_INVALID');
  }
  const kmsPattern = new RegExp(
    `^arn:aws:kms:ap-southeast-1:${input.expectedBucketOwner}:key/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
    'iu',
  );
  if (!kmsPattern.test(input.kmsKeyArn)) {
    throw new Error('TENANT_DATA_BROKER_KMS_KEY_INVALID');
  }
  if (input.multipartPartBytes !== FIXED_MULTIPART_PART_BYTES) {
    throw new Error('TENANT_DATA_BROKER_MULTIPART_PART_SIZE_INVALID');
  }
  const s3 = input.s3 as unknown;
  const secrets = input.secrets as unknown;
  if (
    !hasFunctionProperties(s3, [
      'putObject',
      'createMultipartUpload',
      'uploadPart',
      'completeMultipartUpload',
      'abortMultipartUpload',
      'listParts',
      'getObject',
      'headObject',
      'deleteObject',
      'listObjectVersions',
      'getObjectLegalHold',
      'putObjectLegalHold',
    ]) ||
    !hasFunctionProperties(secrets, ['describeSecret', 'getSecretValue', 'deleteSecret'])
  ) {
    throw new Error('TENANT_DATA_BROKER_CLOUD_PORT_INVALID');
  }
  return {
    ...input,
    artifactBucket,
    auditEvidenceBucket,
    expectedBucketOwner: input.expectedBucketOwner,
    kmsKeyArn: input.kmsKeyArn,
    multipartPartBytes: FIXED_MULTIPART_PART_BYTES,
  };
}

function validateGrant(value: unknown, options: ValidatedOptions): ValidatedGrant {
  if (
    !exactRecord(value, [
      'authorityKind',
      'authorityReference',
      'capabilityId',
      'expiresAt',
      'operation',
      'resource',
      'scopeKind',
      'tenantId',
      'workspaceId',
    ]) ||
    typeof value.capabilityId !== 'string' ||
    !UUID.test(value.capabilityId) ||
    typeof value.authorityReference !== 'string' ||
    value.authorityReference.length < 1 ||
    value.authorityReference.length > 1_024 ||
    (value.scopeKind !== 'TENANT' && value.scopeKind !== 'WORKSPACE') ||
    typeof value.tenantId !== 'string' ||
    !UUID.test(value.tenantId) ||
    (value.scopeKind === 'TENANT'
      ? value.workspaceId !== null
      : typeof value.workspaceId !== 'string' || !UUID.test(value.workspaceId)) ||
    typeof value.operation !== 'string' ||
    typeof value.authorityKind !== 'string' ||
    !isCanonicalInstant(value.expiresAt) ||
    !isPlainRecord(value.resource)
  ) {
    throw new Error('TENANT_DATA_BROKER_GRANT_INVALID');
  }
  const grant: ValidatedGrant = {
    capabilityId: value.capabilityId,
    authorityKind: value.authorityKind,
    authorityReference: value.authorityReference,
    scopeKind: value.scopeKind,
    tenantId: value.tenantId.toLowerCase(),
    workspaceId: typeof value.workspaceId === 'string' ? value.workspaceId.toLowerCase() : null,
    operation: value.operation,
    resource: value.resource,
    expiresAt: value.expiresAt,
  };
  validateOperationGrant(grant, options);
  return grant;
}

function validateOperationGrant(grant: ValidatedGrant, options: ValidatedOptions): void {
  assertAuthorityForOperation(grant);
  switch (grant.operation) {
    case 'PUT_WORKLOAD_OBJECT':
    case 'PUT_PRIVACY_OBJECT':
      validatePutGrant(grant, options);
      return;
    case 'READ_WORKLOAD_OBJECT':
      validateObjectVersionGrant(grant, options, ['WORKLOAD_OBJECTS']);
      return;
    case 'READ_PRIVACY_OBJECT':
      validateObjectVersionGrant(grant, options, ['TENANT_EXPORTS', 'AUDIT_EVIDENCE']);
      return;
    case 'HEAD_WORKLOAD_OBJECT':
    case 'HEAD_PRIVACY_OBJECT':
      validateHeadGrant(grant, options);
      return;
    case 'DELETE_WORKLOAD_OBJECT_VERSION':
      validateDeleteGrant(grant, options, ['WORKLOAD_OBJECTS']);
      return;
    case 'DELETE_PRIVACY_OBJECT_VERSION':
      validateDeleteGrant(grant, options, ['TENANT_EXPORTS', 'AUDIT_EVIDENCE']);
      return;
    case 'LIST_TENANT_OBJECT_VERSIONS':
      validateInventoryGrant(grant, options);
      return;
    case 'GET_OBJECT_LEGAL_HOLD':
      validateLegalHoldGrant(grant, options, false);
      return;
    case 'SET_OBJECT_LEGAL_HOLD':
      validateLegalHoldGrant(grant, options, true);
      return;
    case 'READ_CONNECTOR_SECRET':
    case 'DESCRIBE_CONNECTOR_SECRET':
    case 'DELETE_CONNECTOR_SECRET':
      validateSecretGrant(grant, options, false);
      return;
    case 'VERIFY_CONNECTOR_SECRET_UNREADABLE':
      validateSecretGrant(grant, options, true);
      return;
    default:
      throw new Error('TENANT_DATA_BROKER_OPERATION_UNSUPPORTED');
  }
}

function assertAuthorityForOperation(grant: ValidatedGrant): void {
  const allowed: Readonly<Record<string, readonly string[]>> = {
    READ_CONNECTOR_SECRET: ['ACTIVE_PUBLICATION_JOB', 'CHANNEL_AUTHORIZATION_VALIDATION'],
    DESCRIBE_CONNECTOR_SECRET: ['CONNECTOR_DELETION_INTENT'],
    VERIFY_CONNECTOR_SECRET_UNREADABLE: ['CONNECTOR_DELETION_INTENT'],
    DELETE_CONNECTOR_SECRET: ['CONNECTOR_DELETION_INTENT'],
    PUT_WORKLOAD_OBJECT: ['WORKLOAD_WRITE_INTENT'],
    READ_WORKLOAD_OBJECT: ['ACTIVE_JOB_OBJECT_READ', 'AUTHENTICATED_OBJECT_READ'],
    HEAD_WORKLOAD_OBJECT: ['WORKLOAD_WRITE_INTENT', 'DELETION_OBJECT_INTENT'],
    DELETE_WORKLOAD_OBJECT_VERSION: ['DELETION_OBJECT_INTENT'],
    PUT_PRIVACY_OBJECT: ['PRIVACY_WRITE_INTENT'],
    READ_PRIVACY_OBJECT: ['ACTIVE_JOB_OBJECT_READ', 'AUTHENTICATED_OBJECT_READ'],
    HEAD_PRIVACY_OBJECT: ['PRIVACY_WRITE_INTENT', 'DELETION_OBJECT_INTENT'],
    LIST_TENANT_OBJECT_VERSIONS: ['DELETION_INVENTORY_INTENT'],
    DELETE_PRIVACY_OBJECT_VERSION: ['DELETION_OBJECT_INTENT'],
    GET_OBJECT_LEGAL_HOLD: ['DELETION_OBJECT_INTENT', 'LEGAL_HOLD_RECONCILIATION_INTENT'],
    SET_OBJECT_LEGAL_HOLD: ['LEGAL_HOLD_RECONCILIATION_INTENT'],
  };
  if (!(allowed[grant.operation] ?? []).includes(grant.authorityKind)) {
    throw new Error('TENANT_DATA_BROKER_AUTHORITY_INVALID');
  }
}

function validatePutGrant(grant: ValidatedGrant, options: ValidatedOptions): void {
  const resource = grant.resource;
  if (grant.operation === 'PUT_WORKLOAD_OBJECT') {
    if (
      grant.scopeKind !== 'WORKSPACE' ||
      !exactRecord(resource, [
        'bucket',
        'byteLength',
        'checksumSha256',
        'contentType',
        'key',
        'kind',
        'lockedUntil',
        'objectClass',
        'sealedAt',
      ]) ||
      resource.kind !== 'WORKLOAD_OBJECT_PUT' ||
      resource.objectClass !== 'WORKLOAD_OBJECTS' ||
      resource.lockedUntil !== null ||
      resource.sealedAt !== null
    ) {
      throw new Error('TENANT_DATA_BROKER_GRANT_INVALID');
    }
  } else if (grant.operation === 'PUT_PRIVACY_OBJECT') {
    if (
      grant.scopeKind !== 'TENANT' ||
      !exactRecord(resource, [
        'bucket',
        'byteLength',
        'checksumSha256',
        'contentType',
        'key',
        'kind',
        'lockedUntil',
        'objectClass',
        'sealedAt',
      ]) ||
      resource.kind !== 'PRIVACY_OBJECT_PUT' ||
      (resource.objectClass !== 'TENANT_EXPORTS' && resource.objectClass !== 'AUDIT_EVIDENCE') ||
      !validPrivacyRetention(resource)
    ) {
      throw new Error('TENANT_DATA_BROKER_GRANT_INVALID');
    }
  }
  readByteLength(resource.byteLength);
  readSha256(resource.checksumSha256);
  readContentType(resource.contentType);
  const bucket = readBucket(resource.bucket);
  const expectedBucket =
    resource.objectClass === 'AUDIT_EVIDENCE'
      ? options.auditEvidenceBucket
      : options.artifactBucket;
  if (bucket !== expectedBucket || !validScopedKey(grant, resource)) {
    throw new Error('TENANT_DATA_BROKER_RESOURCE_SCOPE_INVALID');
  }
}

function validateObjectVersionGrant(
  grant: ValidatedGrant,
  options: ValidatedOptions,
  allowedClasses: readonly string[],
): void {
  const resource = grant.resource;
  if (
    !exactRecord(resource, [
      'bucket',
      'byteLength',
      'checksumSha256',
      'contentType',
      'key',
      'kind',
      'objectClass',
      'versionId',
    ]) ||
    resource.kind !== 'OBJECT_VERSION' ||
    typeof resource.objectClass !== 'string' ||
    !allowedClasses.includes(resource.objectClass)
  ) {
    throw new Error('TENANT_DATA_BROKER_GRANT_INVALID');
  }
  readByteLength(resource.byteLength);
  readSha256(resource.checksumSha256);
  readContentType(resource.contentType);
  readVersionId(resource.versionId);
  validateObjectCoordinates(grant, resource, options);
}

function validateHeadGrant(grant: ValidatedGrant, options: ValidatedOptions): void {
  const resource = grant.resource;
  if (resource.kind === 'OBJECT_VERSION') {
    validateObjectVersionGrant(
      grant,
      options,
      grant.operation === 'HEAD_WORKLOAD_OBJECT'
        ? ['WORKLOAD_OBJECTS']
        : ['TENANT_EXPORTS', 'AUDIT_EVIDENCE'],
    );
    return;
  }
  const workload = grant.operation === 'HEAD_WORKLOAD_OBJECT';
  const expectedKind = workload
    ? 'WORKLOAD_OBJECT_WRITE_RECOVERY_HEAD'
    : 'PRIVACY_OBJECT_WRITE_RECOVERY_HEAD';
  if (
    !exactRecord(resource, [
      'bucket',
      'expectedByteLength',
      'expectedChecksumSha256',
      'expectedContentType',
      'key',
      'kind',
      'lockedUntil',
      'objectClass',
      'sealedAt',
    ]) ||
    resource.kind !== expectedKind ||
    (workload
      ? resource.objectClass !== 'WORKLOAD_OBJECTS' ||
        grant.scopeKind !== 'WORKSPACE' ||
        resource.lockedUntil !== null ||
        resource.sealedAt !== null
      : (resource.objectClass !== 'TENANT_EXPORTS' && resource.objectClass !== 'AUDIT_EVIDENCE') ||
        grant.scopeKind !== 'TENANT' ||
        !validPrivacyRetention(resource))
  ) {
    throw new Error('TENANT_DATA_BROKER_GRANT_INVALID');
  }
  readByteLength(resource.expectedByteLength);
  readSha256(resource.expectedChecksumSha256);
  readContentType(resource.expectedContentType);
  validateObjectCoordinates(grant, resource, options);
}

function validateDeleteGrant(
  grant: ValidatedGrant,
  options: ValidatedOptions,
  allowedClasses: readonly string[],
): void {
  const resource = grant.resource;
  if (
    !exactRecord(resource, [
      'bucket',
      'isDeleteMarker',
      'key',
      'kind',
      'objectClass',
      'versionId',
    ]) ||
    resource.kind !== 'OBJECT_VERSION_DELETE' ||
    typeof resource.objectClass !== 'string' ||
    !allowedClasses.includes(resource.objectClass) ||
    typeof resource.isDeleteMarker !== 'boolean'
  ) {
    throw new Error('TENANT_DATA_BROKER_GRANT_INVALID');
  }
  readVersionId(resource.versionId);
  validateObjectCoordinates(grant, resource, options);
}

function validateInventoryGrant(grant: ValidatedGrant, options: ValidatedOptions): void {
  const resource = grant.resource;
  if (
    !exactRecord(resource, ['bucket', 'cursor', 'kind', 'limit', 'objectClass', 'prefix']) ||
    resource.kind !== 'OBJECT_VERSION_INVENTORY' ||
    (resource.objectClass !== 'WORKLOAD_OBJECTS' &&
      resource.objectClass !== 'TENANT_EXPORTS' &&
      resource.objectClass !== 'AUDIT_EVIDENCE') ||
    typeof resource.limit !== 'number' ||
    !Number.isSafeInteger(resource.limit) ||
    resource.limit < 1 ||
    resource.limit > 1_000 ||
    !validInventoryCursor(resource.cursor)
  ) {
    throw new Error('TENANT_DATA_BROKER_GRANT_INVALID');
  }
  const bucket = readBucket(resource.bucket);
  if (
    bucket !== bucketForObjectClass(options, resource.objectClass) ||
    typeof resource.prefix !== 'string' ||
    resource.prefix !== scopedPrefix(grant, resource.objectClass)
  ) {
    throw new Error('TENANT_DATA_BROKER_RESOURCE_SCOPE_INVALID');
  }
}

function validateLegalHoldGrant(
  grant: ValidatedGrant,
  options: ValidatedOptions,
  write: boolean,
): void {
  const resource = grant.resource;
  const keys = write
    ? ['bucket', 'desiredStatus', 'key', 'kind', 'objectClass', 'revision', 'versionId']
    : ['bucket', 'key', 'kind', 'objectClass', 'versionId'];
  if (
    !exactRecord(resource, keys) ||
    resource.kind !== (write ? 'OBJECT_LEGAL_HOLD_WRITE' : 'OBJECT_LEGAL_HOLD_READ') ||
    (resource.objectClass !== 'WORKLOAD_OBJECTS' &&
      resource.objectClass !== 'TENANT_EXPORTS' &&
      resource.objectClass !== 'AUDIT_EVIDENCE') ||
    (write &&
      ((resource.desiredStatus !== 'ON' && resource.desiredStatus !== 'OFF') ||
        typeof resource.revision !== 'number' ||
        !Number.isSafeInteger(resource.revision) ||
        resource.revision < 1))
  ) {
    throw new Error('TENANT_DATA_BROKER_GRANT_INVALID');
  }
  readVersionId(resource.versionId);
  validateObjectCoordinates(grant, resource, options);
}

function validateSecretGrant(
  grant: ValidatedGrant,
  options: ValidatedOptions,
  unreadableProbe: boolean,
): void {
  const resource = grant.resource;
  const keys = unreadableProbe ? ['kind', 'resultKind', 'secretArn'] : ['kind', 'secretArn'];
  if (
    grant.scopeKind !== 'WORKSPACE' ||
    grant.workspaceId === null ||
    !exactRecord(resource, keys) ||
    resource.kind !==
      (unreadableProbe ? 'CONNECTOR_SECRET_UNREADABLE_VERIFICATION' : 'CONNECTOR_SECRET') ||
    (unreadableProbe && resource.resultKind !== 'BOOLEAN_ONLY') ||
    !validSecretArn(resource.secretArn, grant, options.expectedBucketOwner)
  ) {
    throw new Error('TENANT_DATA_BROKER_SECRET_SCOPE_INVALID');
  }
}

function validateObjectCoordinates(
  grant: ValidatedGrant,
  resource: CloudRecord,
  options: ValidatedOptions,
): void {
  const bucket = readBucket(resource.bucket);
  if (
    typeof resource.objectClass !== 'string' ||
    bucket !== bucketForObjectClass(options, resource.objectClass) ||
    !validScopedKey(grant, resource)
  ) {
    throw new Error('TENANT_DATA_BROKER_RESOURCE_SCOPE_INVALID');
  }
}

function validInventoryCursor(value: unknown): boolean {
  if (value === null) return true;
  return (
    exactRecord(value, ['keyMarker', 'versionIdMarker']) &&
    typeof value.keyMarker === 'string' &&
    validObjectReference(value.keyMarker) &&
    typeof value.versionIdMarker === 'string' &&
    value.versionIdMarker.length >= 1 &&
    value.versionIdMarker.length <= 1_024 &&
    !hasControlCharacter(value.versionIdMarker)
  );
}

function validPrivacyRetention(resource: CloudRecord): boolean {
  if (resource.objectClass === 'TENANT_EXPORTS') {
    return resource.lockedUntil === null && resource.sealedAt === null;
  }
  if (
    resource.objectClass !== 'AUDIT_EVIDENCE' ||
    !isCanonicalInstant(resource.lockedUntil) ||
    !isCanonicalInstant(resource.sealedAt)
  ) {
    return false;
  }
  return Date.parse(resource.lockedUntil) - Date.parse(resource.sealedAt) >= 365 * 86_400_000;
}

function validScopedKey(grant: ValidatedGrant, resource: CloudRecord): boolean {
  if (typeof resource.key !== 'string' || !validObjectReference(resource.key)) {
    return false;
  }
  const objectClass = resource.objectClass;
  let prefix: string;
  if (objectClass === 'WORKLOAD_OBJECTS') {
    if (grant.scopeKind === 'TENANT' && grant.workspaceId === null) {
      prefix = `tenants/${grant.tenantId}/workspaces/`;
    } else if (grant.scopeKind === 'WORKSPACE' && grant.workspaceId !== null) {
      prefix = `tenants/${grant.tenantId}/workspaces/${grant.workspaceId}/`;
    } else {
      return false;
    }
  } else if (objectClass === 'TENANT_EXPORTS') {
    if (grant.scopeKind !== 'TENANT') return false;
    prefix = `tenants/${grant.tenantId}/exports/`;
  } else if (objectClass === 'AUDIT_EVIDENCE') {
    if (grant.scopeKind !== 'TENANT') return false;
    prefix = `tenants/${grant.tenantId}/audit-digests/`;
  } else {
    return false;
  }
  return resource.key.startsWith(prefix) && resource.key.length > prefix.length;
}

function scopedPrefix(grant: ValidatedGrant, objectClass: string): string | null {
  if (objectClass === 'WORKLOAD_OBJECTS') {
    if (grant.scopeKind === 'TENANT' && grant.workspaceId === null) {
      return `tenants/${grant.tenantId}/workspaces/`;
    }
    if (grant.scopeKind === 'WORKSPACE' && grant.workspaceId !== null) {
      return `tenants/${grant.tenantId}/workspaces/${grant.workspaceId}/`;
    }
    return null;
  }
  if (grant.scopeKind !== 'TENANT' || grant.workspaceId !== null) return null;
  if (objectClass === 'TENANT_EXPORTS') {
    return `tenants/${grant.tenantId}/exports/`;
  }
  if (objectClass === 'AUDIT_EVIDENCE') {
    return `tenants/${grant.tenantId}/audit-digests/`;
  }
  return null;
}

function bucketForObjectClass(options: ValidatedOptions, objectClass: string): string {
  if (objectClass === 'WORKLOAD_OBJECTS' || objectClass === 'TENANT_EXPORTS') {
    return options.artifactBucket;
  }
  if (objectClass === 'AUDIT_EVIDENCE') return options.auditEvidenceBucket;
  throw new Error('TENANT_DATA_BROKER_OBJECT_CLASS_INVALID');
}

function validSecretArn(
  value: unknown,
  grant: ValidatedGrant,
  expectedAccount: string,
): value is string {
  if (typeof value !== 'string' || grant.scopeKind !== 'WORKSPACE' || grant.workspaceId === null) {
    return false;
  }
  const match =
    /^arn:aws:secretsmanager:ap-southeast-1:(\d{12}):secret:([A-Za-z0-9/_+=.@-]{1,512})$/u.exec(
      value,
    );
  if (match === null) return false;
  const expectedPrefix = `tenant-${grant.tenantId}/workspace-${grant.workspaceId}/`;
  const name = match[2] ?? '';
  return (
    match[1] === expectedAccount &&
    name.startsWith(expectedPrefix) &&
    name.length > expectedPrefix.length
  );
}

function putIdentity(
  options: ValidatedOptions,
  grant: ValidatedGrant,
): {
  bucket: string;
  expectedBucketOwner: string;
  key: string;
} {
  return {
    bucket: readBucket(grant.resource.bucket),
    expectedBucketOwner: options.expectedBucketOwner,
    key: readObjectReference(grant.resource.key),
  };
}

function objectIdentity(
  options: ValidatedOptions,
  grant: ValidatedGrant,
  requireVersion: boolean,
): {
  bucket: string;
  expectedBucketOwner: string;
  key: string;
  versionId?: string;
} {
  const base = {
    bucket: readBucket(grant.resource.bucket),
    expectedBucketOwner: options.expectedBucketOwner,
    key: readObjectReference(grant.resource.key),
  };
  return requireVersion ? { ...base, versionId: readVersionId(grant.resource.versionId) } : base;
}

function retentionFields(resource: CloudRecord): CloudRecord {
  return resource.objectClass === 'AUDIT_EVIDENCE'
    ? {
        objectLockMode: 'COMPLIANCE',
        objectLockRetainUntilDate: resource.lockedUntil,
      }
    : {};
}

function putReceipt(
  grant: ValidatedGrant,
  versionId: string,
  checksum: string,
  contentType: string,
  byteLength: number,
): CloudRecord {
  return {
    bucket: readBucket(grant.resource.bucket),
    key: readObjectReference(grant.resource.key),
    versionId,
    checksum,
    contentType,
    byteLength,
  };
}

function hasFunctionProperties(value: unknown, names: readonly string[]): boolean {
  if (!isPlainRecord(value)) return false;
  return names.every((name) => typeof value[name] === 'function');
}

function createValidatedBody(
  source: AsyncIterable<Uint8Array>,
  expected: { byteLength: number; checksum: string; signal: AbortSignal },
): {
  body: AsyncIterable<Uint8Array>;
  assertComplete(): void;
} {
  let complete = false;
  let consumed = false;
  let observedLength = 0;
  const hash = createHash('sha256');
  return {
    body: {
      async *[Symbol.asyncIterator]() {
        if (consumed) throw new Error('TENANT_DATA_BROKER_BODY_REUSED');
        consumed = true;
        const iterator = source[Symbol.asyncIterator]();
        try {
          while (true) {
            assertActive(expected.signal);
            const next = await callWithSignal(() => iterator.next(), expected.signal);
            if (next.done) break;
            const chunk = next.value;
            if (!(chunk instanceof Uint8Array)) {
              throw new Error('TENANT_DATA_BROKER_BODY_CHUNK_INVALID');
            }
            observedLength += chunk.byteLength;
            if (observedLength > expected.byteLength) {
              throw new Error('TENANT_DATA_BROKER_BODY_LENGTH_MISMATCH');
            }
            hash.update(chunk);
            yield chunk;
          }
          if (observedLength !== expected.byteLength || hash.digest('hex') !== expected.checksum) {
            throw new Error('TENANT_DATA_BROKER_BODY_INTEGRITY_MISMATCH');
          }
          complete = true;
        } finally {
          if (!complete && typeof iterator.return === 'function') {
            await iterator.return().catch(() => undefined);
          }
        }
      },
    },
    assertComplete() {
      if (!complete) throw new Error('TENANT_DATA_BROKER_BODY_NOT_CONSUMED');
    },
  };
}

function createOperationContext(signal: AbortSignal, deadline: Date): OperationContext {
  if (!(signal instanceof AbortSignal) || !(deadline instanceof Date)) {
    throw new Error('TENANT_DATA_BROKER_EXECUTION_CONTEXT_INVALID');
  }
  const deadlineMs = deadline.getTime();
  if (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now() || signal.aborted) {
    throw new Error('TENANT_DATA_BROKER_DEADLINE_EXPIRED');
  }
  const controller = new AbortController();
  const forwardAbort = () => {
    controller.abort(signal.reason ?? new Error('TENANT_DATA_BROKER_CALLER_ABORTED'));
  };
  signal.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new Error('TENANT_DATA_BROKER_DEADLINE_EXPIRED'));
  }, deadlineMs - Date.now());
  timer.unref?.();
  return {
    signal: controller.signal,
    abort: (reason) => {
      if (!controller.signal.aborted) controller.abort(reason);
    },
    dispose: () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', forwardAbort);
    },
  };
}

async function callWithSignal<T>(effect: () => Promise<T>, signal: AbortSignal): Promise<T> {
  assertActive(signal);
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    rejectAbort?.(signal.reason ?? new Error('TENANT_DATA_BROKER_OPERATION_ABORTED'));
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([Promise.resolve().then(effect), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error('TENANT_DATA_BROKER_OPERATION_ABORTED');
  }
}

function readBucket(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !BUCKET.test(value) ||
    value.includes('..') ||
    value.includes('.-') ||
    value.includes('-.')
  ) {
    throw new Error('TENANT_DATA_BROKER_BUCKET_INVALID');
  }
  return value;
}

function readObjectReference(value: unknown): string {
  if (typeof value !== 'string' || !validObjectReference(value)) {
    throw new Error('TENANT_DATA_BROKER_OBJECT_REFERENCE_INVALID');
  }
  return value;
}

function readSecretArn(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 20 ||
    value.length > 1_024 ||
    hasControlCharacter(value)
  ) {
    throw new Error('TENANT_DATA_BROKER_SECRET_ARN_INVALID');
  }
  return value;
}

function validObjectReference(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 1_024 &&
    !value.startsWith('/') &&
    !hasControlCharacter(value)
  );
}

function readVersionId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 1_024 ||
    hasControlCharacter(value)
  ) {
    throw new Error('TENANT_DATA_BROKER_VERSION_ID_INVALID');
  }
  return value;
}

function readUploadId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 1_024 ||
    hasControlCharacter(value)
  ) {
    throw new Error('TENANT_DATA_BROKER_UPLOAD_ID_INVALID');
  }
  return value;
}

function readEtag(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 1_024 ||
    hasControlCharacter(value)
  ) {
    throw new Error('TENANT_DATA_BROKER_ETAG_INVALID');
  }
  return value;
}

function readSha256(value: unknown): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error('TENANT_DATA_BROKER_SHA256_INVALID');
  }
  return value;
}

function readByteLength(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_OBJECT_BYTES
  ) {
    throw new Error('TENANT_DATA_BROKER_BYTE_LENGTH_INVALID');
  }
  return value;
}

function readContentType(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 3 ||
    value.length > 255 ||
    !CONTENT_TYPE.test(value)
  ) {
    throw new Error('TENANT_DATA_BROKER_CONTENT_TYPE_INVALID');
  }
  return value;
}

function hexToBase64(value: string): string {
  return Buffer.from(readSha256(value), 'hex').toString('base64');
}

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isAsyncByteIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return (
    value !== null &&
    typeof value === 'object' &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === 'function'
  );
}

function isPlainRecord(value: unknown): value is CloudRecord {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactRecord(value: unknown, keys: readonly string[]): value is CloudRecord {
  return (
    isPlainRecord(value) && Object.keys(value).sort().join('\n') === [...keys].sort().join('\n')
  );
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) return true;
  }
  return false;
}
