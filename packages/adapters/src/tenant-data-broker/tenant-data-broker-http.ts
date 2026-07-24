import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type {
  TenantDataAccessRequest,
  TenantDataAuthorization,
  TenantDataBrokerAttemptStore,
  TenantDataBrokerEffectResolver,
} from '@aeostudio/application/tenant-data-access';
import { isTenantDataAccessRequest } from '@aeostudio/application/tenant-data-access';

const BROKER_PATH = '/internal/v1/tenant-data';
const HMAC_DOMAIN = 'AEO-TENANT-DATA-BROKER-HMAC-SHA256-V1';
const MAX_CLOCK_SKEW_SECONDS = 30;
const MAX_PREVIOUS_KEY_WINDOW_MS = 5 * 60 * 1_000;
const MAX_COMMAND_BYTES = 16 * 1_024;
const MAX_PAYLOAD_BYTES = 2 * 1_024 * 1_024 * 1_024;
const MAX_JSON_RESPONSE_BYTES = 8 * 1_024 * 1_024;
const MAX_OBJECT_METADATA_BYTES = 16 * 1_024;
const REQUEST_CONTENT_TYPE = 'application/vnd.aeostudio.tenant-data-request';
const RESPONSE_CONTENT_TYPE = 'application/vnd.aeostudio.tenant-data+json';
const OBJECT_RESPONSE_KIND = 'OBJECT_STREAM';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;
const CONTENT_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:[ -~]*)?$/u;

type AuthorizedGrant = Extract<TenantDataAuthorization, { outcome: 'AUTHORIZED' }>['grant'];
type CloudRecord = Record<string, unknown>;

export type TenantDataBrokerCommand = TenantDataAccessRequest;
export type TenantDataBrokerExecutionResult = CloudRecord;

export interface TenantDataBrokerHttpRequest {
  method: string;
  url: string;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  body: AsyncIterable<Uint8Array>;
  signal: AbortSignal;
  deadline: Date;
}

export interface TenantDataBrokerHttpResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: AsyncIterable<Uint8Array>;
}

export interface TenantDataBrokerVersionedSigningKey {
  id: string;
  value: string;
}

export interface TenantDataBrokerSigningKeyRing {
  current: TenantDataBrokerVersionedSigningKey;
  previous?: TenantDataBrokerVersionedSigningKey & { acceptUntil: string };
}

export interface TenantDataBrokerExecutor {
  execute(input: {
    grant: AuthorizedGrant;
    body: AsyncIterable<Uint8Array>;
    signal: AbortSignal;
    deadline: Date;
  }): Promise<unknown>;
}

interface BrokerLogger {
  info(entry: Readonly<Record<string, unknown>>): void;
  warn(entry: Readonly<Record<string, unknown>>): void;
}

interface BrokerClock {
  now(): Date;
}

export interface TenantDataBrokerStreamingHttpTransportOptions {
  audience: string;
  signingKeys: TenantDataBrokerSigningKeyRing;
  expectedBucketOwner?: string;
  authorizer: {
    authorize(request: TenantDataAccessRequest): Promise<TenantDataAuthorization>;
  };
  attempts: TenantDataBrokerAttemptStore;
  effectResolver: TenantDataBrokerEffectResolver;
  executor: TenantDataBrokerExecutor;
  clock: BrokerClock;
  logger: BrokerLogger;
}

interface AcceptedSigningKey {
  key: Buffer;
  acceptUntil: number | null;
}

interface AuthenticatedHeaders {
  commandLength: number;
  commandSha256: string;
  nonce: string;
  payloadLength: number;
  payloadSha256: string;
  signedAt: Date;
  nonceExpiresAt: Date;
}

interface ValidatedPayload {
  body: AsyncIterable<Uint8Array>;
  assertComplete(): void;
  close(): Promise<void>;
}

interface ObjectStreamMetadata {
  kind: typeof OBJECT_RESPONSE_KIND;
  bucket: string;
  key: string;
  versionId: string;
  checksum: string;
  contentType: string;
  byteLength: number;
  transportChecksumSha256: string;
}

interface ObjectStreamResult extends ObjectStreamMetadata {
  body: AsyncIterable<Uint8Array>;
}

export function parseTenantDataBrokerKeyRing(
  raw: string,
  clock: BrokerClock,
): TenantDataBrokerSigningKeyRing {
  try {
    if (typeof raw !== 'string' || raw.length < 2 || Buffer.byteLength(raw, 'utf8') > 16 * 1_024) {
      throw new Error('invalid');
    }
    const parsed: unknown = JSON.parse(raw);
    if (
      !exactObjectKeys(parsed, [
        'current',
        ...(hasOwnKey(parsed, 'previous') ? ['previous'] : []),
        'schemaVersion',
      ]) ||
      parsed.schemaVersion !== 'aeostudio.tenant-data-broker-key-ring.v1' ||
      !exactObjectKeys(parsed.current, ['id', 'value']) ||
      typeof parsed.current.id !== 'string' ||
      typeof parsed.current.value !== 'string'
    ) {
      throw new Error('invalid');
    }
    const previous = parsed.previous;
    if (
      previous !== undefined &&
      (!exactObjectKeys(previous, ['acceptUntil', 'id', 'value']) ||
        typeof previous.id !== 'string' ||
        typeof previous.value !== 'string' ||
        typeof previous.acceptUntil !== 'string')
    ) {
      throw new Error('invalid');
    }
    const result: TenantDataBrokerSigningKeyRing = {
      current: {
        id: parsed.current.id,
        value: parsed.current.value,
      },
      ...(previous === undefined
        ? {}
        : {
            previous: {
              id: previous.id as string,
              value: previous.value as string,
              acceptUntil: previous.acceptUntil as string,
            },
          }),
    };
    readAcceptedSigningKeys({ signingKeys: result }, clock);
    return result;
  } catch {
    throw new Error('TENANT_DATA_BROKER_SIGNING_KEYS_INVALID');
  }
}

export function createTenantDataBrokerStreamingHttpTransport(
  options: TenantDataBrokerStreamingHttpTransportOptions,
): TenantDataBrokerHttpHandler {
  return new TenantDataBrokerHttpHandler(options);
}

export class TenantDataBrokerHttpHandler {
  private readonly audience: string;
  private readonly signingKeys: ReadonlyMap<string, AcceptedSigningKey>;

  public constructor(private readonly options: TenantDataBrokerStreamingHttpTransportOptions) {
    if (options === null || typeof options !== 'object') {
      throw new Error('TENANT_DATA_BROKER_OPTIONS_INVALID');
    }
    this.audience = readAudience(options.audience);
    this.signingKeys = readAcceptedSigningKeys(options, options.clock);
    if (
      options.expectedBucketOwner !== undefined &&
      !/^\d{12}$/u.test(options.expectedBucketOwner)
    ) {
      throw new Error('TENANT_DATA_BROKER_EXPECTED_BUCKET_OWNER_INVALID');
    }
    if (
      !hasFunctions(options.authorizer, ['authorize']) ||
      !hasFunctions(options.attempts, ['beginAuthenticated', 'complete', 'fail']) ||
      !hasFunctions(options.effectResolver, [
        'resolveObjectPut',
        'resolveLegalHold',
        'resolveSecretDelete',
      ]) ||
      !hasFunctions(options.executor, ['execute']) ||
      !hasFunctions(options.clock, ['now']) ||
      !hasFunctions(options.logger, ['info', 'warn'])
    ) {
      throw new Error('TENANT_DATA_BROKER_PORT_INVALID');
    }
  }

  public async handle(request: TenantDataBrokerHttpRequest): Promise<TenantDataBrokerHttpResponse> {
    const now = readNow(this.options.clock);
    const authenticated = authenticateHeaders(request, this.audience, this.signingKeys, now);
    if (authenticated === null) return this.denied();

    const reader = new FramedRequestReader(request.body);
    let payload: ValidatedPayload | null = null;
    try {
      const command = await readAuthenticatedCommand(reader, authenticated, request.signal);
      let authorization: TenantDataAuthorization;
      try {
        authorization = await callWithSignal(
          () => this.options.authorizer.authorize(command),
          request.signal,
        );
      } catch {
        await reader.close();
        return this.failure(503, 'TENANT_DATA_BROKER_UNAVAILABLE');
      }
      if (
        authorization.outcome !== 'AUTHORIZED' ||
        !authorizationMatchesCommand(authorization.grant, command) ||
        !SHA256.test(authorization.audit.resourceReferenceSha256) ||
        !payloadDeclarationMatchesGrant(
          authorization.grant,
          authenticated.payloadLength,
          authenticated.payloadSha256,
        )
      ) {
        await reader.close();
        return this.denied();
      }

      const beginInput = {
        capabilityId: authorization.grant.capabilityId,
        leaseToken: command.leaseToken,
        nonce: authenticated.nonce,
        operation: authorization.grant.operation,
        resourceReferenceSha256: authorization.audit.resourceReferenceSha256,
        signedAt: authenticated.signedAt,
        expiresAt: authenticated.nonceExpiresAt,
      };
      let begun: Awaited<ReturnType<TenantDataBrokerAttemptStore['beginAuthenticated']>>;
      try {
        begun = await callWithSignal(
          () => this.options.attempts.beginAuthenticated(beginInput),
          request.signal,
        );
      } catch {
        await reader.close();
        return this.failure(503, 'TENANT_DATA_BROKER_UNAVAILABLE');
      }
      const begin = validateAttemptBegin(begun);
      if (begin === null) {
        await reader.close();
        return this.failure(503, 'TENANT_DATA_BROKER_UNAVAILABLE');
      }
      if (begin.outcome === 'DENIED') {
        await reader.close();
        return this.denied();
      }
      if (begin.outcome === 'AMBIGUOUS') {
        await reader.close();
        return this.failure(503, 'TENANT_DATA_EFFECT_OUTCOME_UNKNOWN');
      }
      if (begin.outcome === 'ALREADY_SUCCEEDED') {
        await reader.close();
        const priorResult = validatePriorSuccessReceipt(
          authorization.grant,
          begin.successReceipt,
          this.options.expectedBucketOwner,
        );
        if (priorResult === null) {
          return this.failure(503, 'TENANT_DATA_EFFECT_OUTCOME_UNKNOWN');
        }
        safeLog(this.options.logger, 'info', {
          event: 'TENANT_DATA_BROKER_ALREADY_SUCCEEDED',
          operation: authorization.grant.operation,
          capabilityIdSha256: sha256(authorization.grant.capabilityId),
          resourceReferenceSha256: authorization.audit.resourceReferenceSha256,
        });
        return this.jsonResponse(200, priorResult);
      }

      payload = reader.validatedPayload(
        authenticated.payloadLength,
        authenticated.payloadSha256,
        request.signal,
      );
      safeLog(this.options.logger, 'info', {
        event: 'TENANT_DATA_BROKER_AUTHORIZED_ATTEMPT',
        operation: authorization.grant.operation,
        capabilityIdSha256: sha256(authorization.grant.capabilityId),
        resourceReferenceSha256: authorization.audit.resourceReferenceSha256,
      });

      let result: unknown;
      try {
        result = await this.options.executor.execute({
          grant: authorization.grant,
          body: payload.body,
          signal: request.signal,
          deadline: request.deadline,
        });
        payload.assertComplete();
      } catch (error) {
        await payload.close();
        if (isObjectPutRecoveryGrant(authorization.grant) && isHeadMetadataMismatch(error)) {
          try {
            const resolution = await callWithSignal(
              () =>
                this.options.effectResolver.resolveObjectPut({
                  probeAttemptId: begin.attemptId,
                  leaseToken: command.leaseToken,
                  observation: 'MISMATCH',
                  observedVersionId: null,
                  observedChecksum: null,
                  observedContentType: null,
                  observedByteLength: null,
                }),
              request.signal,
            );
            return resolution === 'RESOLVED_FAILED'
              ? this.failure(502, 'TENANT_DATA_EFFECT_FAILED')
              : this.failure(503, 'TENANT_DATA_EFFECT_OUTCOME_UNKNOWN');
          } catch {
            return this.failure(503, 'TENANT_DATA_BROKER_UNAVAILABLE');
          }
        }
        const outcome = isEffectfulOperation(authorization.grant.operation) ? 'UNKNOWN' : 'FAILED';
        const persisted = await this.persistFailure(begin.attemptId, command.leaseToken, outcome);
        return persisted
          ? this.failure(
              outcome === 'UNKNOWN' ? 503 : 502,
              outcome === 'UNKNOWN'
                ? 'TENANT_DATA_EFFECT_OUTCOME_UNKNOWN'
                : 'TENANT_DATA_EFFECT_FAILED',
            )
          : this.failure(503, 'TENANT_DATA_EFFECT_OUTCOME_UNKNOWN');
      }

      if (isObjectPutRecoveryGrant(authorization.grant)) {
        const observation = readObjectPutRecoveryObservation(authorization.grant, result);
        if (observation === null) {
          await this.persistFailure(begin.attemptId, command.leaseToken, 'FAILED');
          return this.failure(503, 'TENANT_DATA_EFFECT_OUTCOME_UNKNOWN');
        }
        try {
          const resolution = await callWithSignal(
            () =>
              this.options.effectResolver.resolveObjectPut({
                probeAttemptId: begin.attemptId,
                leaseToken: command.leaseToken,
                ...observation,
              }),
            request.signal,
          );
          if (
            (observation.observation === 'FOUND' && resolution !== 'RESOLVED_SUCCESS') ||
            (observation.observation === 'MISSING' && resolution !== 'RESOLVED_FAILED')
          ) {
            return this.failure(503, 'TENANT_DATA_EFFECT_OUTCOME_UNKNOWN');
          }
        } catch {
          return this.failure(503, 'TENANT_DATA_BROKER_UNAVAILABLE');
        }
        return this.jsonResponse(200, result);
      }

      if (isLegalHoldRecoveryGrant(authorization.grant)) {
        const observedStatus = readLegalHoldRecoveryObservation(authorization.grant, result);
        if (observedStatus === null) {
          await this.persistFailure(begin.attemptId, command.leaseToken, 'FAILED');
          return this.failure(503, 'TENANT_DATA_EFFECT_OUTCOME_UNKNOWN');
        }
        try {
          const resolution = await callWithSignal(
            () =>
              this.options.effectResolver.resolveLegalHold({
                probeAttemptId: begin.attemptId,
                leaseToken: command.leaseToken,
                observedStatus,
              }),
            request.signal,
          );
          if (resolution !== 'RESOLVED_SUCCESS' && resolution !== 'RESOLVED_FAILED') {
            return this.failure(503, 'TENANT_DATA_EFFECT_OUTCOME_UNKNOWN');
          }
        } catch {
          return this.failure(503, 'TENANT_DATA_BROKER_UNAVAILABLE');
        }
        return this.jsonResponse(200, result);
      }

      if (isSecretDeleteRecoveryGrant(authorization.grant)) {
        const observation = readSecretDeleteRecoveryObservation(result);
        if (observation === null) {
          await this.persistFailure(begin.attemptId, command.leaseToken, 'FAILED');
          return this.failure(503, 'TENANT_DATA_EFFECT_OUTCOME_UNKNOWN');
        }
        try {
          const resolution = await this.options.effectResolver.resolveSecretDelete({
            probeAttemptId: begin.attemptId,
            leaseToken: command.leaseToken,
            observation,
          });
          const expectedResolution =
            observation === 'EXISTS' ? 'RESOLVED_FAILED' : 'RESOLVED_SUCCESS';
          if (resolution !== expectedResolution) {
            return this.failure(503, 'TENANT_DATA_EFFECT_OUTCOME_UNKNOWN');
          }
        } catch {
          return this.failure(503, 'TENANT_DATA_BROKER_UNAVAILABLE');
        }
        return this.jsonResponse(200, result);
      }

      let objectResult: ObjectStreamResult | null;
      try {
        objectResult = readObjectStreamResult(result);
      } catch {
        const outcome = isEffectfulOperation(authorization.grant.operation) ? 'UNKNOWN' : 'FAILED';
        await this.persistFailure(begin.attemptId, command.leaseToken, outcome);
        return this.failure(
          outcome === 'UNKNOWN' ? 503 : 502,
          outcome === 'UNKNOWN'
            ? 'TENANT_DATA_EFFECT_OUTCOME_UNKNOWN'
            : 'TENANT_DATA_EFFECT_FAILED',
        );
      }
      if (objectResult !== null) {
        if (isEffectfulOperation(authorization.grant.operation)) {
          await closeAsyncIterable(objectResult.body);
          await this.persistFailure(begin.attemptId, command.leaseToken, 'UNKNOWN');
          return this.failure(503, 'TENANT_DATA_EFFECT_OUTCOME_UNKNOWN');
        }
        return this.objectResponse(
          objectResult,
          begin.attemptId,
          command.leaseToken,
          request.signal,
        );
      }

      let responseBody: Uint8Array;
      let receipt: CloudRecord | null;
      try {
        responseBody = encodeExecutionResult(result);
        receipt = successReceiptFor(authorization.grant, result);
      } catch {
        const outcome = isEffectfulOperation(authorization.grant.operation) ? 'UNKNOWN' : 'FAILED';
        await this.persistFailure(begin.attemptId, command.leaseToken, outcome);
        return this.failure(
          outcome === 'UNKNOWN' ? 503 : 502,
          outcome === 'UNKNOWN'
            ? 'TENANT_DATA_EFFECT_OUTCOME_UNKNOWN'
            : 'TENANT_DATA_EFFECT_FAILED',
        );
      }
      try {
        await this.options.attempts.complete({
          attemptId: begin.attemptId,
          leaseToken: command.leaseToken,
          receipt,
        });
      } catch {
        responseBody.fill(0);
        await this.persistFailure(
          begin.attemptId,
          command.leaseToken,
          isEffectfulOperation(authorization.grant.operation) ? 'UNKNOWN' : 'FAILED',
        );
        return this.failure(503, 'TENANT_DATA_EFFECT_OUTCOME_UNKNOWN');
      }
      safeLog(this.options.logger, 'info', {
        event: 'TENANT_DATA_BROKER_AUTHORIZED',
        operation: authorization.grant.operation,
        capabilityIdSha256: sha256(authorization.grant.capabilityId),
        resourceReferenceSha256: authorization.audit.resourceReferenceSha256,
        responseKind: readResultKind(result),
        responseBytes: responseBody.byteLength,
      });
      return {
        status: 200,
        headers: jsonResponseHeaders(responseBody.byteLength),
        body: oneChunkBody(responseBody, true),
      };
    } catch {
      if (payload !== null) await payload.close();
      else await reader.close();
      return this.denied();
    }
  }

  private objectResponse(
    result: ObjectStreamResult,
    attemptId: string,
    leaseToken: string,
    signal: AbortSignal,
  ): TenantDataBrokerHttpResponse {
    const metadata: ObjectStreamMetadata = {
      kind: OBJECT_RESPONSE_KIND,
      bucket: result.bucket,
      key: result.key,
      versionId: result.versionId,
      checksum: result.checksum,
      contentType: result.contentType,
      byteLength: result.byteLength,
      transportChecksumSha256: result.transportChecksumSha256,
    };
    const encodedMetadata = Buffer.from(canonicalJson(metadata), 'utf8');
    if (encodedMetadata.byteLength > MAX_OBJECT_METADATA_BYTES) {
      void closeAsyncIterable(result.body);
      return this.failure(502, 'TENANT_DATA_EFFECT_FAILED');
    }
    const metadataHeader = encodedMetadata.toString('base64url');
    encodedMetadata.fill(0);
    const body = createJournaledObjectStream(result.body, {
      byteLength: result.byteLength,
      checksum: result.checksum,
      signal,
      complete: () =>
        this.options.attempts.complete({
          attemptId,
          leaseToken,
          receipt: null,
        }),
      fail: () =>
        this.options.attempts.fail({
          attemptId,
          leaseToken,
          outcome: 'FAILED',
        }),
    });
    return {
      status: 200,
      headers: {
        ...noStoreHeaders(),
        'content-length': String(result.byteLength),
        'content-type': result.contentType,
        'x-aeostudio-result-kind': OBJECT_RESPONSE_KIND,
        'x-aeostudio-result-metadata': metadataHeader,
      },
      body,
    };
  }

  private denied(): TenantDataBrokerHttpResponse {
    safeLog(this.options.logger, 'warn', {
      event: 'TENANT_DATA_BROKER_DENIED',
    });
    return this.jsonResponse(403, {
      code: 'TENANT_DATA_ACCESS_DENIED',
    });
  }

  private failure(
    status: 502 | 503,
    code:
      | 'TENANT_DATA_BROKER_UNAVAILABLE'
      | 'TENANT_DATA_EFFECT_FAILED'
      | 'TENANT_DATA_EFFECT_OUTCOME_UNKNOWN',
  ): TenantDataBrokerHttpResponse {
    safeLog(this.options.logger, 'warn', {
      event: 'TENANT_DATA_BROKER_EFFECT_FAILURE',
      status,
      code,
    });
    return this.jsonResponse(status, { code });
  }

  private jsonResponse(status: number, value: unknown): TenantDataBrokerHttpResponse {
    const body = encodeExecutionResult(value);
    return {
      status,
      headers: jsonResponseHeaders(body.byteLength),
      body: oneChunkBody(body, true),
    };
  }

  private async persistFailure(
    attemptId: string,
    leaseToken: string,
    outcome: 'FAILED' | 'UNKNOWN',
  ): Promise<boolean> {
    try {
      await this.options.attempts.fail({
        attemptId,
        leaseToken,
        outcome,
      });
      return true;
    } catch {
      return false;
    }
  }
}

export class TenantDataBrokerHttpClient {
  private readonly endpoint: URL;
  private readonly keyId: string;
  private readonly signingKey: Buffer;

  public constructor(
    private readonly options: {
      endpoint: string;
      signingKey: TenantDataBrokerVersionedSigningKey;
      clock: BrokerClock;
      nextNonce(): string;
      transport(request: TenantDataBrokerHttpRequest): Promise<TenantDataBrokerHttpResponse>;
    },
  ) {
    if (options === null || typeof options !== 'object') {
      throw new Error('TENANT_DATA_BROKER_CLIENT_OPTIONS_INVALID');
    }
    this.endpoint = readEndpoint(options.endpoint);
    const signingKey = options.signingKey;
    if (
      signingKey === null ||
      typeof signingKey !== 'object' ||
      typeof signingKey.id !== 'string' ||
      typeof signingKey.value !== 'string'
    ) {
      throw new Error('TENANT_DATA_BROKER_SIGNING_KEYS_INVALID');
    }
    this.keyId = readKeyId(signingKey.id);
    this.signingKey = readSigningKey(signingKey.value);
    if (
      !hasFunctions(options.clock, ['now']) ||
      typeof options.nextNonce !== 'function' ||
      typeof options.transport !== 'function'
    ) {
      throw new Error('TENANT_DATA_BROKER_CLIENT_OPTIONS_INVALID');
    }
  }

  public async invoke(
    command: TenantDataBrokerCommand,
    input: {
      body: AsyncIterable<Uint8Array>;
      deadline: Date;
      payloadLength: number;
      payloadSha256: string;
      signal: AbortSignal;
    },
  ): Promise<unknown> {
    const now = readNow(this.options.clock);
    if (!isTenantDataAccessRequest(command)) {
      throw new Error('TENANT_DATA_ACCESS_DENIED');
    }
    if (
      input === null ||
      typeof input !== 'object' ||
      !isAsyncByteIterable(input.body) ||
      !isAbortSignal(input.signal) ||
      !validDeadline(input.deadline, now) ||
      !validPayloadLength(input.payloadLength) ||
      !SHA256.test(input.payloadSha256)
    ) {
      throw new Error('TENANT_DATA_BROKER_REQUEST_INVALID');
    }
    const nonce = this.options.nextNonce();
    if (!UUID.test(nonce)) {
      throw new Error('TENANT_DATA_BROKER_NONCE_INVALID');
    }
    const commandBytes = encodeCanonicalCommand(command);
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(commandBytes.byteLength, 0);
    const commandLength = String(commandBytes.byteLength);
    const commandSha256 = sha256(commandBytes);
    const payloadLength = String(input.payloadLength);
    const totalContentLength = String(4 + commandBytes.byteLength + input.payloadLength);
    const timestamp = String(Math.floor(now.getTime() / 1_000));
    const signature = signCanonicalRequest({
      key: this.signingKey,
      audience: this.endpoint.host,
      method: 'POST',
      path: BROKER_PATH,
      timestamp,
      nonce,
      keyId: this.keyId,
      commandLength,
      commandSha256,
      payloadLength,
      payloadSha256: input.payloadSha256,
      totalContentLength,
    });
    const body = framedRequestBody(prefix, commandBytes, input.body);
    try {
      const response = await callWithSignal(
        () =>
          this.options.transport({
            method: 'POST',
            url: this.endpoint.href,
            headers: {
              authorization: `AEO-HMAC-SHA256 ${signature}`,
              'content-length': totalContentLength,
              'content-type': REQUEST_CONTENT_TYPE,
              'x-aeostudio-command-length': commandLength,
              'x-aeostudio-command-sha256': commandSha256,
              'x-aeostudio-key-id': this.keyId,
              'x-aeostudio-nonce': nonce,
              'x-aeostudio-payload-length': payloadLength,
              'x-aeostudio-payload-sha256': input.payloadSha256,
              'x-aeostudio-timestamp': timestamp,
            },
            body,
            signal: input.signal,
            deadline: new Date(input.deadline),
          }),
        input.signal,
      );
      return await parseHttpResponse(response, input.signal);
    } finally {
      prefix.fill(0);
      commandBytes.fill(0);
    }
  }
}

class FramedRequestReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private current: Uint8Array | null = null;
  private offset = 0;
  private ended = false;
  private closed = false;
  private payloadCreated = false;

  public constructor(source: AsyncIterable<Uint8Array>) {
    if (!isAsyncByteIterable(source)) {
      throw new Error('TENANT_DATA_BROKER_BODY_INVALID');
    }
    this.iterator = source[Symbol.asyncIterator]();
  }

  public async readExact(byteLength: number, signal: AbortSignal): Promise<Uint8Array> {
    const result = new Uint8Array(byteLength);
    let written = 0;
    while (written < byteLength) {
      const chunk = await this.nextAvailable(signal);
      if (chunk === null) {
        throw new Error('TENANT_DATA_BROKER_FRAME_TRUNCATED');
      }
      const copyLength = Math.min(chunk.byteLength, byteLength - written);
      result.set(chunk.subarray(0, copyLength), written);
      written += copyLength;
      this.offset += copyLength;
    }
    return result;
  }

  public validatedPayload(
    byteLength: number,
    checksum: string,
    signal: AbortSignal,
  ): ValidatedPayload {
    if (this.payloadCreated) {
      throw new Error('TENANT_DATA_BROKER_PAYLOAD_REUSED');
    }
    this.payloadCreated = true;
    let consumed = false;
    let complete = false;
    let observedLength = 0;
    const hash = createHash('sha256');
    const readNext = (activeSignal: AbortSignal) => this.nextAvailable(activeSignal);
    const advance = (length: number) => {
      this.offset += length;
    };
    const closeReader = () => this.close();
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        if (consumed) {
          throw new Error('TENANT_DATA_BROKER_PAYLOAD_REUSED');
        }
        consumed = true;
        return {
          async next(): Promise<IteratorResult<Uint8Array>> {
            assertActive(signal);
            if (complete) return { done: true, value: undefined };
            if (observedLength === byteLength) {
              const extra = await readNext(signal);
              if (extra !== null) {
                throw new Error('TENANT_DATA_BROKER_PAYLOAD_LENGTH_MISMATCH');
              }
              const actualChecksum = hash.digest('hex');
              complete = true;
              if (actualChecksum !== checksum) {
                throw new Error('TENANT_DATA_BROKER_PAYLOAD_CHECKSUM_MISMATCH');
              }
              return { done: true, value: undefined };
            }
            const chunk = await readNext(signal);
            if (chunk === null) {
              throw new Error('TENANT_DATA_BROKER_PAYLOAD_LENGTH_MISMATCH');
            }
            const remaining = byteLength - observedLength;
            if (chunk.byteLength > remaining) {
              throw new Error('TENANT_DATA_BROKER_PAYLOAD_LENGTH_MISMATCH');
            }
            advance(chunk.byteLength);
            observedLength += chunk.byteLength;
            hash.update(chunk);
            return { done: false, value: chunk };
          },
          async return(): Promise<IteratorResult<Uint8Array>> {
            await closeReader();
            return { done: true, value: undefined };
          },
          async throw(error?: unknown): Promise<IteratorResult<Uint8Array>> {
            await closeReader();
            throw error;
          },
        };
      },
    };
    return {
      body,
      assertComplete() {
        if (!complete) {
          throw new Error('TENANT_DATA_BROKER_PAYLOAD_NOT_CONSUMED');
        }
      },
      close: closeReader,
    };
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (typeof this.iterator.return === 'function') {
      await this.iterator.return().catch(() => undefined);
    }
  }

  private async nextAvailable(signal: AbortSignal): Promise<Uint8Array | null> {
    while (true) {
      assertActive(signal);
      if (this.current !== null && this.offset < this.current.byteLength) {
        return this.current.subarray(this.offset);
      }
      this.current = null;
      this.offset = 0;
      if (this.ended) return null;
      const next = await callWithSignal(() => this.iterator.next(), signal);
      if (next.done) {
        this.ended = true;
        return null;
      }
      if (!(next.value instanceof Uint8Array)) {
        throw new Error('TENANT_DATA_BROKER_BODY_CHUNK_INVALID');
      }
      if (next.value.byteLength === 0) continue;
      this.current = next.value;
    }
  }
}

async function readAuthenticatedCommand(
  reader: FramedRequestReader,
  authenticated: AuthenticatedHeaders,
  signal: AbortSignal,
): Promise<TenantDataBrokerCommand> {
  const prefix = await reader.readExact(4, signal);
  const framedLength = Buffer.from(
    prefix.buffer,
    prefix.byteOffset,
    prefix.byteLength,
  ).readUInt32BE(0);
  prefix.fill(0);
  if (framedLength !== authenticated.commandLength) {
    throw new Error('TENANT_DATA_BROKER_COMMAND_LENGTH_MISMATCH');
  }
  const commandBytes = await reader.readExact(framedLength, signal);
  try {
    if (sha256(commandBytes) !== authenticated.commandSha256) {
      throw new Error('TENANT_DATA_BROKER_COMMAND_CHECKSUM_MISMATCH');
    }
    return parseCanonicalCommand(commandBytes);
  } finally {
    commandBytes.fill(0);
  }
}

function authenticateHeaders(
  request: TenantDataBrokerHttpRequest,
  audience: string,
  signingKeys: ReadonlyMap<string, AcceptedSigningKey>,
  now: Date,
): AuthenticatedHeaders | null {
  try {
    if (
      request === null ||
      typeof request !== 'object' ||
      request.method !== 'POST' ||
      !isAsyncByteIterable(request.body) ||
      !isAbortSignal(request.signal) ||
      request.signal.aborted ||
      !validDeadline(request.deadline, now)
    ) {
      return null;
    }
    const endpoint = new URL(request.url);
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.username.length !== 0 ||
      endpoint.password.length !== 0 ||
      endpoint.host !== audience ||
      endpoint.pathname !== BROKER_PATH ||
      endpoint.search.length !== 0 ||
      endpoint.hash.length !== 0 ||
      singleHeader(request.headers['content-type']) !== REQUEST_CONTENT_TYPE ||
      request.headers['transfer-encoding'] !== undefined ||
      request.headers['x-aeostudio-command'] !== undefined
    ) {
      return null;
    }
    const authorization = singleHeader(request.headers.authorization);
    const totalLengthHeader = singleHeader(request.headers['content-length']);
    const commandLengthHeader = singleHeader(request.headers['x-aeostudio-command-length']);
    const commandSha256 = singleHeader(request.headers['x-aeostudio-command-sha256']);
    const keyId = singleHeader(request.headers['x-aeostudio-key-id']);
    const nonce = singleHeader(request.headers['x-aeostudio-nonce']);
    const payloadLengthHeader = singleHeader(request.headers['x-aeostudio-payload-length']);
    const payloadSha256 = singleHeader(request.headers['x-aeostudio-payload-sha256']);
    const timestamp = singleHeader(request.headers['x-aeostudio-timestamp']);
    if (
      authorization === undefined ||
      totalLengthHeader === undefined ||
      commandLengthHeader === undefined ||
      commandSha256 === undefined ||
      keyId === undefined ||
      nonce === undefined ||
      payloadLengthHeader === undefined ||
      payloadSha256 === undefined ||
      timestamp === undefined ||
      !UUID.test(nonce) ||
      !SHA256.test(commandSha256) ||
      !SHA256.test(payloadSha256) ||
      !/^[0-9]{10}$/u.test(timestamp)
    ) {
      return null;
    }
    const commandLength = readCanonicalLength(commandLengthHeader, 2, MAX_COMMAND_BYTES);
    const payloadLength = readCanonicalLength(payloadLengthHeader, 0, MAX_PAYLOAD_BYTES);
    const totalContentLength = readCanonicalLength(
      totalLengthHeader,
      6,
      4 + MAX_COMMAND_BYTES + MAX_PAYLOAD_BYTES,
    );
    if (totalContentLength !== 4 + commandLength + payloadLength) {
      return null;
    }
    const timestampSeconds = Number(timestamp);
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    const acceptedKey = signingKeys.get(keyId);
    if (
      !Number.isSafeInteger(timestampSeconds) ||
      acceptedKey === undefined ||
      (acceptedKey.acceptUntil !== null && now.getTime() >= acceptedKey.acceptUntil) ||
      Math.abs(nowSeconds - timestampSeconds) > MAX_CLOCK_SKEW_SECONDS
    ) {
      return null;
    }
    const suppliedSignature = /^AEO-HMAC-SHA256 ([a-f0-9]{64})$/u.exec(authorization)?.[1];
    if (suppliedSignature === undefined) return null;
    const expectedSignature = signCanonicalRequest({
      key: acceptedKey.key,
      audience,
      method: request.method,
      path: BROKER_PATH,
      timestamp,
      nonce,
      keyId,
      commandLength: commandLengthHeader,
      commandSha256,
      payloadLength: payloadLengthHeader,
      payloadSha256,
      totalContentLength: totalLengthHeader,
    });
    if (!constantTimeHexEquals(expectedSignature, suppliedSignature)) {
      return null;
    }
    const signedAt = new Date(timestampSeconds * 1_000);
    return {
      commandLength,
      commandSha256,
      nonce,
      payloadLength,
      payloadSha256,
      signedAt,
      nonceExpiresAt: new Date(signedAt.getTime() + MAX_CLOCK_SKEW_SECONDS * 1_000),
    };
  } catch {
    return null;
  }
}

function signCanonicalRequest(input: {
  key: Buffer;
  audience: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  keyId: string;
  commandLength: string;
  commandSha256: string;
  payloadLength: string;
  payloadSha256: string;
  totalContentLength: string;
}): string {
  return createHmac('sha256', input.key)
    .update(
      [
        HMAC_DOMAIN,
        input.method,
        input.audience,
        input.path,
        input.timestamp,
        input.nonce,
        input.keyId,
        input.commandLength,
        input.commandSha256,
        input.payloadLength,
        input.payloadSha256,
        input.totalContentLength,
      ].join('\n'),
      'utf8',
    )
    .digest('hex');
}

function encodeCanonicalCommand(command: TenantDataBrokerCommand): Uint8Array {
  const bytes = Buffer.from(canonicalJson(command), 'utf8');
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_COMMAND_BYTES) {
    bytes.fill(0);
    throw new Error('TENANT_DATA_BROKER_COMMAND_INVALID');
  }
  return bytes;
}

function parseCanonicalCommand(bytes: Uint8Array): TenantDataBrokerCommand {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    if (
      !exactObjectKeys(parsed, [
        'authorityReference',
        'capabilityId',
        'leaseToken',
        'operation',
        'scopeKind',
        'tenantId',
        'workspaceId',
      ]) ||
      !isTenantDataAccessRequest(parsed) ||
      canonicalJson(parsed) !== text
    ) {
      throw new Error('invalid');
    }
    return parsed;
  } catch {
    throw new Error('TENANT_DATA_BROKER_COMMAND_INVALID');
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('TENANT_DATA_BROKER_JSON_INVALID');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (!isPlainRecord(value)) {
    throw new Error('TENANT_DATA_BROKER_JSON_INVALID');
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function framedRequestBody(
  prefix: Uint8Array,
  command: Uint8Array,
  payload: AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  let consumed = false;
  return {
    async *[Symbol.asyncIterator]() {
      if (consumed) {
        throw new Error('TENANT_DATA_BROKER_REQUEST_BODY_REUSED');
      }
      consumed = true;
      yield prefix;
      yield command;
      for await (const chunk of payload) {
        if (!(chunk instanceof Uint8Array)) {
          throw new Error('TENANT_DATA_BROKER_BODY_CHUNK_INVALID');
        }
        yield chunk;
      }
    },
  };
}

async function parseHttpResponse(
  response: TenantDataBrokerHttpResponse,
  signal: AbortSignal,
): Promise<unknown> {
  if (
    response === null ||
    typeof response !== 'object' ||
    !isAsyncByteIterable(response.body) ||
    response.headers['cache-control'] !== 'no-store' ||
    response.headers.pragma !== 'no-cache' ||
    response.headers['x-content-type-options'] !== 'nosniff' ||
    response.headers['transfer-encoding'] !== undefined
  ) {
    throw new Error('TENANT_DATA_BROKER_RESPONSE_INVALID');
  }
  if (
    response.status === 200 &&
    response.headers['x-aeostudio-result-kind'] === OBJECT_RESPONSE_KIND
  ) {
    return parseObjectResponse(response, signal);
  }
  if (
    response.headers['x-aeostudio-result-kind'] !== undefined ||
    response.headers['x-aeostudio-result-metadata'] !== undefined ||
    response.headers['content-type'] !== RESPONSE_CONTENT_TYPE
  ) {
    await closeAsyncIterable(response.body);
    throw new Error('TENANT_DATA_BROKER_RESPONSE_INVALID');
  }
  const length = readCanonicalLength(
    response.headers['content-length'],
    2,
    MAX_JSON_RESPONSE_BYTES,
  );
  const bytes = await consumeExactBody(response.body, length, signal);
  if (response.status !== 200) {
    const code = parseFailureCode(bytes);
    bytes.fill(0);
    if (
      (response.status === 403 && code === 'TENANT_DATA_ACCESS_DENIED') ||
      (response.status === 502 && code === 'TENANT_DATA_EFFECT_FAILED') ||
      (response.status === 503 &&
        (code === 'TENANT_DATA_BROKER_UNAVAILABLE' ||
          code === 'TENANT_DATA_EFFECT_OUTCOME_UNKNOWN'))
    ) {
      throw new Error(code);
    }
    throw new Error('TENANT_DATA_BROKER_RESPONSE_INVALID');
  }
  return parseJsonResult(bytes);
}

async function parseObjectResponse(
  response: TenantDataBrokerHttpResponse,
  signal: AbortSignal,
): Promise<ObjectStreamResult> {
  let metadataBytes: Buffer | null = null;
  try {
    const metadataValue = response.headers['x-aeostudio-result-metadata'];
    if (
      typeof metadataValue !== 'string' ||
      metadataValue.length < 2 ||
      metadataValue.length > MAX_OBJECT_METADATA_BYTES * 2
    ) {
      throw new Error('invalid');
    }
    metadataBytes = Buffer.from(metadataValue, 'base64url');
    if (
      metadataBytes.byteLength > MAX_OBJECT_METADATA_BYTES ||
      metadataBytes.toString('base64url') !== metadataValue
    ) {
      throw new Error('invalid');
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(metadataBytes);
    const parsed: unknown = JSON.parse(text);
    if (canonicalJson(parsed) !== text) throw new Error('invalid');
    const metadata = readObjectStreamMetadata(parsed);
    if (
      response.headers['content-type'] !== metadata.contentType ||
      response.headers['content-length'] !== String(metadata.byteLength)
    ) {
      throw new Error('invalid');
    }
    return {
      ...metadata,
      body: createClientObjectStream(response.body, {
        byteLength: metadata.byteLength,
        checksum: metadata.checksum,
        signal,
      }),
    };
  } catch {
    await closeAsyncIterable(response.body);
    throw new Error('TENANT_DATA_BROKER_RESPONSE_INVALID');
  } finally {
    metadataBytes?.fill(0);
  }
}

function createClientObjectStream(
  source: AsyncIterable<Uint8Array>,
  options: {
    byteLength: number;
    checksum: string;
    signal: AbortSignal;
  },
): AsyncIterable<Uint8Array> {
  return createValidatedStream(source, {
    ...options,
    onComplete: () => Promise.resolve(),
    onFailure: () => Promise.resolve(),
  });
}

function createJournaledObjectStream(
  source: AsyncIterable<Uint8Array>,
  options: {
    byteLength: number;
    checksum: string;
    signal: AbortSignal;
    complete(): Promise<void>;
    fail(): Promise<void>;
  },
): AsyncIterable<Uint8Array> {
  return createValidatedStream(source, {
    byteLength: options.byteLength,
    checksum: options.checksum,
    signal: options.signal,
    onComplete: () => options.complete(),
    onFailure: () => options.fail(),
  });
}

function createValidatedStream(
  source: AsyncIterable<Uint8Array>,
  options: {
    byteLength: number;
    checksum: string;
    signal: AbortSignal;
    onComplete(): Promise<void>;
    onFailure(): Promise<void>;
  },
): AsyncIterable<Uint8Array> {
  let used = false;
  return {
    [Symbol.asyncIterator]() {
      if (used) {
        throw new Error('TENANT_DATA_BROKER_RESPONSE_BODY_REUSED');
      }
      used = true;
      const iterator = source[Symbol.asyncIterator]();
      const hash = createHash('sha256');
      let observedLength = 0;
      let closed = false;
      let finalized = false;

      const close = async (success: boolean, returnUpstream: boolean): Promise<void> => {
        if (closed) return;
        closed = true;
        if (returnUpstream && typeof iterator.return === 'function') {
          await iterator.return().catch(() => undefined);
        }
        try {
          if (success) await options.onComplete();
          else await options.onFailure();
        } catch {
          throw new Error('TENANT_DATA_EFFECT_OUTCOME_UNKNOWN');
        }
      };

      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          if (closed) return { done: true, value: undefined };
          try {
            assertActive(options.signal);
            const next = await callWithSignal(() => iterator.next(), options.signal);
            if (next.done) {
              const checksum = hash.digest('hex');
              finalized = true;
              if (observedLength !== options.byteLength || checksum !== options.checksum) {
                await close(false, false);
                throw new Error('TENANT_DATA_BROKER_RESPONSE_INTEGRITY_MISMATCH');
              }
              await close(true, false);
              return { done: true, value: undefined };
            }
            if (!(next.value instanceof Uint8Array)) {
              throw new Error('TENANT_DATA_BROKER_BODY_CHUNK_INVALID');
            }
            observedLength += next.value.byteLength;
            if (observedLength > options.byteLength) {
              throw new Error('TENANT_DATA_BROKER_RESPONSE_LENGTH_MISMATCH');
            }
            hash.update(next.value);
            return next;
          } catch (error: unknown) {
            if (!finalized) await close(false, true);
            throw error;
          }
        },
        async return(): Promise<IteratorResult<Uint8Array>> {
          await close(false, true);
          return { done: true, value: undefined };
        },
        async throw(error?: unknown): Promise<IteratorResult<Uint8Array>> {
          await close(false, true);
          throw error;
        },
      };
    },
  };
}

function readObjectStreamResult(value: unknown): ObjectStreamResult | null {
  if (!isPlainRecord(value) || value.kind !== OBJECT_RESPONSE_KIND) {
    return null;
  }
  if (
    !exactObjectKeys(value, [
      'body',
      'bucket',
      'byteLength',
      'checksum',
      'contentType',
      'key',
      'kind',
      'transportChecksumSha256',
      'versionId',
    ]) ||
    !isAsyncByteIterable(value.body)
  ) {
    throw new Error('TENANT_DATA_BROKER_OBJECT_RESULT_INVALID');
  }
  const { body: _body, ...metadataValue } = value;
  void _body;
  const metadata = readObjectStreamMetadata(metadataValue);
  return { ...metadata, body: value.body };
}

function readObjectStreamMetadata(value: unknown): ObjectStreamMetadata {
  if (
    !exactObjectKeys(value, [
      'bucket',
      'byteLength',
      'checksum',
      'contentType',
      'key',
      'kind',
      'transportChecksumSha256',
      'versionId',
    ]) ||
    value.kind !== OBJECT_RESPONSE_KIND ||
    typeof value.bucket !== 'string' ||
    value.bucket.length < 3 ||
    value.bucket.length > 63 ||
    typeof value.key !== 'string' ||
    !validBoundedText(value.key, 1, 1_024) ||
    typeof value.versionId !== 'string' ||
    !validBoundedText(value.versionId, 1, 1_024) ||
    typeof value.checksum !== 'string' ||
    !SHA256.test(value.checksum) ||
    typeof value.contentType !== 'string' ||
    value.contentType.length > 255 ||
    !CONTENT_TYPE.test(value.contentType) ||
    !validPayloadLength(value.byteLength) ||
    value.byteLength < 1 ||
    typeof value.transportChecksumSha256 !== 'string' ||
    !validBoundedText(value.transportChecksumSha256, 1, 256)
  ) {
    throw new Error('TENANT_DATA_BROKER_OBJECT_RESULT_INVALID');
  }
  return {
    kind: OBJECT_RESPONSE_KIND,
    bucket: value.bucket,
    key: value.key,
    versionId: value.versionId,
    checksum: value.checksum,
    contentType: value.contentType,
    byteLength: value.byteLength,
    transportChecksumSha256: value.transportChecksumSha256,
  };
}

function validateAttemptBegin(value: unknown):
  | { outcome: 'DENIED' }
  | { outcome: 'STARTED'; attemptId: string }
  | {
      outcome: 'ALREADY_SUCCEEDED';
      successReceipt: unknown;
    }
  | { outcome: 'AMBIGUOUS' }
  | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  if (value.outcome === 'DENIED' && exactObjectKeys(value, ['outcome'])) {
    return { outcome: value.outcome };
  }
  if (
    value.outcome === 'STARTED' &&
    exactObjectKeys(value, ['attemptId', 'outcome']) &&
    typeof value.attemptId === 'string' &&
    UUID.test(value.attemptId)
  ) {
    return {
      outcome: value.outcome,
      attemptId: value.attemptId,
    };
  }
  if (value.outcome === 'AMBIGUOUS' && exactObjectKeys(value, ['outcome'])) {
    return { outcome: value.outcome };
  }
  if (
    value.outcome === 'ALREADY_SUCCEEDED' &&
    exactObjectKeys(value, ['outcome', 'successReceipt'])
  ) {
    return {
      outcome: value.outcome,
      successReceipt: value.successReceipt,
    };
  }
  return null;
}

function validatePriorSuccessReceipt(
  grant: AuthorizedGrant,
  value: unknown,
  expectedBucketOwner: string | undefined,
): CloudRecord | null {
  if (!isEffectfulOperation(grant.operation)) return null;
  if (grant.operation === 'PUT_WORKLOAD_OBJECT' || grant.operation === 'PUT_PRIVACY_OBJECT') {
    try {
      return readPutReceipt(grant, value);
    } catch {
      return null;
    }
  }
  if (!exactObjectKeys(value, [])) return null;
  const resource = grant.resource as CloudRecord;
  switch (grant.operation) {
    case 'DELETE_CONNECTOR_SECRET':
      return exactObjectKeys(resource, ['kind', 'secretArn']) &&
        resource.kind === 'CONNECTOR_SECRET' &&
        typeof resource.secretArn === 'string' &&
        validBoundedText(resource.secretArn, 1, 2_048)
        ? { kind: 'SECRET_DELETE_RECEIPT', deleted: true }
        : null;
    case 'DELETE_WORKLOAD_OBJECT_VERSION':
    case 'DELETE_PRIVACY_OBJECT_VERSION':
      if (
        !exactObjectKeys(resource, [
          'bucket',
          'isDeleteMarker',
          'key',
          'kind',
          'objectClass',
          'versionId',
        ]) ||
        resource.kind !== 'OBJECT_VERSION_DELETE' ||
        (grant.operation === 'DELETE_WORKLOAD_OBJECT_VERSION'
          ? resource.objectClass !== 'WORKLOAD_OBJECTS'
          : resource.objectClass !== 'TENANT_EXPORTS' &&
            resource.objectClass !== 'AUDIT_EVIDENCE') ||
        typeof resource.bucket !== 'string' ||
        !validBoundedText(resource.bucket, 3, 63) ||
        typeof resource.key !== 'string' ||
        !validBoundedText(resource.key, 1, 2_048) ||
        typeof resource.versionId !== 'string' ||
        !validBoundedText(resource.versionId, 1, 1_024) ||
        typeof resource.isDeleteMarker !== 'boolean'
      ) {
        return null;
      }
      return {
        kind: 'OBJECT_VERSION_DELETED',
        bucket: resource.bucket,
        key: resource.key,
        versionId: resource.versionId,
        isDeleteMarker: resource.isDeleteMarker,
      };
    case 'SET_OBJECT_LEGAL_HOLD':
      if (
        expectedBucketOwner === undefined ||
        !/^\d{12}$/u.test(expectedBucketOwner) ||
        !exactObjectKeys(resource, [
          'bucket',
          'desiredStatus',
          'key',
          'kind',
          'objectClass',
          'revision',
          'versionId',
        ]) ||
        resource.kind !== 'OBJECT_LEGAL_HOLD_WRITE' ||
        (resource.objectClass !== 'WORKLOAD_OBJECTS' &&
          resource.objectClass !== 'TENANT_EXPORTS' &&
          resource.objectClass !== 'AUDIT_EVIDENCE') ||
        typeof resource.bucket !== 'string' ||
        !validBoundedText(resource.bucket, 3, 63) ||
        typeof resource.key !== 'string' ||
        !validBoundedText(resource.key, 1, 2_048) ||
        typeof resource.versionId !== 'string' ||
        !validBoundedText(resource.versionId, 1, 1_024) ||
        (resource.desiredStatus !== 'ON' && resource.desiredStatus !== 'OFF') ||
        typeof resource.revision !== 'number' ||
        !Number.isSafeInteger(resource.revision) ||
        resource.revision < 1
      ) {
        return null;
      }
      return {
        kind: 'OBJECT_LEGAL_HOLD_SET',
        bucket: resource.bucket,
        expectedBucketOwner,
        key: resource.key,
        versionId: resource.versionId,
        status: resource.desiredStatus,
        revision: resource.revision,
      };
  }
  return null;
}

function successReceiptFor(grant: AuthorizedGrant, result: unknown): CloudRecord | null {
  if (!isEffectfulOperation(grant.operation)) return null;
  if (grant.operation === 'PUT_WORKLOAD_OBJECT' || grant.operation === 'PUT_PRIVACY_OBJECT') {
    return readPutReceipt(grant, result);
  }
  return {};
}

function readPutReceipt(grant: AuthorizedGrant, value: unknown): CloudRecord {
  const resource = grant.resource as CloudRecord;
  if (
    !exactObjectKeys(value, [
      'bucket',
      'byteLength',
      'checksum',
      'contentType',
      'key',
      'versionId',
    ]) ||
    value.bucket !== resource.bucket ||
    value.key !== resource.key ||
    value.checksum !== resource.checksumSha256 ||
    value.contentType !== resource.contentType ||
    value.byteLength !== resource.byteLength ||
    typeof value.versionId !== 'string' ||
    !validBoundedText(value.versionId, 1, 1_024)
  ) {
    throw new Error('TENANT_DATA_BROKER_PUT_RECEIPT_INVALID');
  }
  return {
    bucket: value.bucket,
    key: value.key,
    versionId: value.versionId,
    checksum: value.checksum,
    contentType: value.contentType,
    byteLength: value.byteLength,
  };
}

function authorizationMatchesCommand(
  grant: AuthorizedGrant,
  command: TenantDataBrokerCommand,
): boolean {
  return (
    grant.capabilityId === command.capabilityId &&
    grant.authorityReference === command.authorityReference &&
    grant.scopeKind === command.scopeKind &&
    grant.tenantId === command.tenantId &&
    grant.workspaceId === command.workspaceId &&
    grant.operation === command.operation &&
    typeof grant.expiresAt === 'string' &&
    isCanonicalInstant(grant.expiresAt)
  );
}

function payloadDeclarationMatchesGrant(
  grant: AuthorizedGrant,
  payloadLength: number,
  payloadSha256: string,
): boolean {
  if (grant.operation === 'PUT_WORKLOAD_OBJECT' || grant.operation === 'PUT_PRIVACY_OBJECT') {
    const resource = grant.resource as CloudRecord;
    return resource.byteLength === payloadLength && resource.checksumSha256 === payloadSha256;
  }
  return payloadLength === 0 && payloadSha256 === sha256(new Uint8Array());
}

function encodeExecutionResult(value: unknown): Uint8Array {
  const body = Buffer.from(canonicalJson(value), 'utf8');
  if (body.byteLength < 2 || body.byteLength > MAX_JSON_RESPONSE_BYTES) {
    body.fill(0);
    throw new Error('TENANT_DATA_BROKER_EXECUTION_RESULT_INVALID');
  }
  if (
    isPlainRecord(value) &&
    value.kind === 'SECRET_VALUE' &&
    (typeof value.value !== 'string' ||
      value.value.length < 1 ||
      Buffer.byteLength(value.value, 'utf8') > 65_536)
  ) {
    body.fill(0);
    throw new Error('TENANT_DATA_BROKER_EXECUTION_RESULT_INVALID');
  }
  return body;
}

function parseJsonResult(bytes: Uint8Array): unknown {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    if (!isPlainRecord(parsed) || canonicalJson(parsed) !== text) {
      throw new Error('invalid');
    }
    return parsed;
  } catch {
    throw new Error('TENANT_DATA_BROKER_RESPONSE_INVALID');
  } finally {
    bytes.fill(0);
  }
}

function parseFailureCode(bytes: Uint8Array): string | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    return exactObjectKeys(parsed, ['code']) && typeof parsed.code === 'string'
      ? parsed.code
      : null;
  } catch {
    return null;
  }
}

async function consumeExactBody(
  source: AsyncIterable<Uint8Array>,
  byteLength: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const result = new Uint8Array(byteLength);
  const iterator = source[Symbol.asyncIterator]();
  let offset = 0;
  try {
    while (true) {
      const next = await callWithSignal(() => iterator.next(), signal);
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) || offset + next.value.byteLength > byteLength) {
        throw new Error('TENANT_DATA_BROKER_RESPONSE_INVALID');
      }
      result.set(next.value, offset);
      offset += next.value.byteLength;
    }
    if (offset !== byteLength) {
      throw new Error('TENANT_DATA_BROKER_RESPONSE_INVALID');
    }
    return result;
  } catch (error: unknown) {
    result.fill(0);
    if (typeof iterator.return === 'function') {
      await iterator.return().catch(() => undefined);
    }
    throw error;
  }
}

function oneChunkBody(chunk: Uint8Array, clearAfterYield: boolean): AsyncIterable<Uint8Array> {
  let used = false;
  return {
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      if (used) {
        throw new Error('TENANT_DATA_BROKER_RESPONSE_BODY_REUSED');
      }
      used = true;
      try {
        yield chunk;
      } finally {
        if (clearAfterYield) chunk.fill(0);
      }
    },
  };
}

async function closeAsyncIterable(value: AsyncIterable<Uint8Array>): Promise<void> {
  try {
    const iterator = value[Symbol.asyncIterator]();
    if (typeof iterator.return === 'function') {
      await iterator.return();
    }
  } catch {
    // Release is best effort after an already rejected response.
  }
}

function jsonResponseHeaders(contentLength: number): Readonly<Record<string, string>> {
  return {
    ...noStoreHeaders(),
    'content-length': String(contentLength),
    'content-type': RESPONSE_CONTENT_TYPE,
  };
}

function noStoreHeaders(): Readonly<Record<string, string>> {
  return {
    'cache-control': 'no-store',
    pragma: 'no-cache',
    'x-content-type-options': 'nosniff',
  };
}

function readAcceptedSigningKeys(
  options: { signingKeys: TenantDataBrokerSigningKeyRing },
  clock: BrokerClock,
): ReadonlyMap<string, AcceptedSigningKey> {
  if (
    options.signingKeys === null ||
    typeof options.signingKeys !== 'object' ||
    options.signingKeys.current === null ||
    typeof options.signingKeys.current !== 'object'
  ) {
    throw new Error('TENANT_DATA_BROKER_SIGNING_KEYS_INVALID');
  }
  const current = options.signingKeys.current;
  const currentId = readKeyId(current.id);
  const accepted = new Map<string, AcceptedSigningKey>([
    [
      currentId,
      {
        key: readSigningKey(current.value),
        acceptUntil: null,
      },
    ],
  ]);
  const previous = options.signingKeys.previous;
  if (previous !== undefined) {
    const now = readNow(clock).getTime();
    const previousId = readKeyId(previous.id);
    const acceptUntil = Date.parse(previous.acceptUntil);
    if (
      previousId === currentId ||
      !Number.isFinite(acceptUntil) ||
      new Date(acceptUntil).toISOString() !== previous.acceptUntil ||
      acceptUntil <= now ||
      acceptUntil - now > MAX_PREVIOUS_KEY_WINDOW_MS
    ) {
      throw new Error('TENANT_DATA_BROKER_SIGNING_KEYS_INVALID');
    }
    accepted.set(previousId, {
      key: readSigningKey(previous.value),
      acceptUntil,
    });
  }
  return accepted;
}

function readSigningKey(value: string): Buffer {
  if (
    typeof value !== 'string' ||
    value.length < 32 ||
    value.length > 4_096 ||
    Buffer.byteLength(value, 'utf8') !== value.length ||
    hasControlCharacter(value)
  ) {
    throw new Error('TENANT_DATA_BROKER_SIGNING_KEY_INVALID');
  }
  return Buffer.from(value, 'utf8');
}

function readKeyId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(value)) {
    throw new Error('TENANT_DATA_BROKER_KEY_ID_INVALID');
  }
  return value;
}

function readAudience(value: string): string {
  if (
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::443)?$/u.test(
      value,
    )
  ) {
    throw new Error('TENANT_DATA_BROKER_AUDIENCE_INVALID');
  }
  return value;
}

function readEndpoint(value: string): URL {
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username.length !== 0 ||
    endpoint.password.length !== 0 ||
    endpoint.pathname !== BROKER_PATH ||
    endpoint.search.length !== 0 ||
    endpoint.hash.length !== 0 ||
    readAudience(endpoint.host) !== endpoint.host
  ) {
    throw new Error('TENANT_DATA_BROKER_ENDPOINT_INVALID');
  }
  return endpoint;
}

function readNow(clock: BrokerClock): Date {
  const now = clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('TENANT_DATA_BROKER_TIME_INVALID');
  }
  return new Date(now);
}

function readCanonicalLength(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,10})$/u.test(value)) {
    throw new Error('TENANT_DATA_BROKER_LENGTH_INVALID');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error('TENANT_DATA_BROKER_LENGTH_INVALID');
  }
  return parsed;
}

function validPayloadLength(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_PAYLOAD_BYTES
  );
}

function validDeadline(value: unknown, now: Date): value is Date {
  return (
    value instanceof Date && Number.isFinite(value.getTime()) && value.getTime() > now.getTime()
  );
}

function isCanonicalInstant(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function singleHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function exactObjectKeys(value: unknown, expectedKeys: readonly string[]): value is CloudRecord {
  return (
    isPlainRecord(value) &&
    Object.keys(value).sort().join('\n') === [...expectedKeys].sort().join('\n')
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

function hasOwnKey(value: unknown, key: string): boolean {
  return (
    value !== null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key)
  );
}

function hasFunctions(value: unknown, names: readonly string[]): boolean {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return names.every((name) => typeof candidate[name] === 'function');
}

function isAsyncByteIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return (
    value !== null &&
    typeof value === 'object' &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function'
  );
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as AbortSignal).aborted === 'boolean' &&
    typeof (value as AbortSignal).addEventListener === 'function' &&
    typeof (value as AbortSignal).removeEventListener === 'function'
  );
}

function validBoundedText(value: string, minimum: number, maximum: number): boolean {
  return value.length >= minimum && value.length <= maximum && !hasControlCharacter(value);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function safeLog(
  logger: BrokerLogger,
  level: 'info' | 'warn',
  entry: Readonly<Record<string, unknown>>,
): void {
  try {
    logger[level](entry);
  } catch {
    // Logging is observability-only and cannot change an effect outcome.
  }
}

function readResultKind(result: unknown): string {
  return isPlainRecord(result) && typeof result.kind === 'string' ? result.kind : 'RESULT';
}

function constantTimeHexEquals(expected: string, actual: string): boolean {
  if (!SHA256.test(expected) || !SHA256.test(actual)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('TENANT_DATA_BROKER_ABORTED');
  }
}

async function callWithSignal<T>(effect: () => Promise<T>, signal: AbortSignal): Promise<T> {
  assertActive(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () =>
      reject(
        signal.reason instanceof Error ? signal.reason : new Error('TENANT_DATA_BROKER_ABORTED'),
      );
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([effect(), aborted]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

function isEffectfulOperation(operation: TenantDataAccessRequest['operation']): boolean {
  switch (operation) {
    case 'DELETE_CONNECTOR_SECRET':
    case 'PUT_WORKLOAD_OBJECT':
    case 'DELETE_WORKLOAD_OBJECT_VERSION':
    case 'PUT_PRIVACY_OBJECT':
    case 'DELETE_PRIVACY_OBJECT_VERSION':
    case 'SET_OBJECT_LEGAL_HOLD':
      return true;
    case 'READ_CONNECTOR_SECRET':
    case 'DESCRIBE_CONNECTOR_SECRET':
    case 'VERIFY_CONNECTOR_SECRET_UNREADABLE':
    case 'READ_WORKLOAD_OBJECT':
    case 'HEAD_WORKLOAD_OBJECT':
    case 'READ_PRIVACY_OBJECT':
    case 'HEAD_PRIVACY_OBJECT':
    case 'LIST_TENANT_OBJECT_VERSIONS':
    case 'GET_OBJECT_LEGAL_HOLD':
      return false;
  }
}

type ObjectPutRecoveryGrant =
  | Extract<
      AuthorizedGrant,
      { authorityKind: 'WORKLOAD_WRITE_INTENT'; operation: 'HEAD_WORKLOAD_OBJECT' }
    >
  | Extract<
      AuthorizedGrant,
      { authorityKind: 'PRIVACY_WRITE_INTENT'; operation: 'HEAD_PRIVACY_OBJECT' }
    >;

function isObjectPutRecoveryGrant(grant: AuthorizedGrant): grant is ObjectPutRecoveryGrant {
  return (
    (grant.authorityKind === 'WORKLOAD_WRITE_INTENT' &&
      grant.operation === 'HEAD_WORKLOAD_OBJECT' &&
      grant.resource.kind === 'WORKLOAD_OBJECT_WRITE_RECOVERY_HEAD') ||
    (grant.authorityKind === 'PRIVACY_WRITE_INTENT' &&
      grant.operation === 'HEAD_PRIVACY_OBJECT' &&
      grant.resource.kind === 'PRIVACY_OBJECT_WRITE_RECOVERY_HEAD')
  );
}

function readObjectPutRecoveryObservation(
  grant: ObjectPutRecoveryGrant,
  result: unknown,
):
  | {
      observation: 'FOUND';
      observedVersionId: string;
      observedChecksum: string;
      observedContentType: string;
      observedByteLength: number;
    }
  | {
      observation: 'MISSING';
      observedVersionId: null;
      observedChecksum: null;
      observedContentType: null;
      observedByteLength: null;
    }
  | null {
  if (
    exactObjectKeys(result, ['bucket', 'exists', 'key', 'kind']) &&
    result.kind === 'OBJECT_HEAD' &&
    result.exists === false &&
    result.bucket === grant.resource.bucket &&
    result.key === grant.resource.key
  ) {
    return {
      observation: 'MISSING',
      observedVersionId: null,
      observedChecksum: null,
      observedContentType: null,
      observedByteLength: null,
    };
  }
  if (
    !exactObjectKeys(result, [
      'bucket',
      'byteLength',
      'checksum',
      'contentType',
      'exists',
      'key',
      'kind',
      'versionId',
    ]) ||
    result.kind !== 'OBJECT_HEAD' ||
    result.exists !== true ||
    result.bucket !== grant.resource.bucket ||
    result.key !== grant.resource.key ||
    typeof result.versionId !== 'string' ||
    !validBoundedText(result.versionId, 1, 2_048) ||
    typeof result.checksum !== 'string' ||
    !constantTimeHexEquals(grant.resource.expectedChecksumSha256, result.checksum) ||
    result.contentType !== grant.resource.expectedContentType ||
    result.byteLength !== grant.resource.expectedByteLength
  ) {
    return null;
  }
  return {
    observation: 'FOUND',
    observedVersionId: result.versionId,
    observedChecksum: result.checksum,
    observedContentType: result.contentType,
    observedByteLength: result.byteLength,
  };
}

function isHeadMetadataMismatch(error: unknown): boolean {
  return error instanceof Error && error.message === 'TENANT_DATA_BROKER_HEAD_METADATA_MISMATCH';
}

type LegalHoldRecoveryGrant = Extract<AuthorizedGrant, { operation: 'GET_OBJECT_LEGAL_HOLD' }>;

function isLegalHoldRecoveryGrant(grant: AuthorizedGrant): grant is LegalHoldRecoveryGrant {
  return (
    grant.authorityKind === 'LEGAL_HOLD_RECONCILIATION_INTENT' &&
    grant.operation === 'GET_OBJECT_LEGAL_HOLD' &&
    grant.resource.kind === 'OBJECT_LEGAL_HOLD_READ'
  );
}

function readLegalHoldRecoveryObservation(
  grant: LegalHoldRecoveryGrant,
  result: unknown,
): 'ON' | 'OFF' | null {
  if (
    !exactObjectKeys(result, ['bucket', 'key', 'kind', 'status', 'versionId']) ||
    result.kind !== 'OBJECT_LEGAL_HOLD' ||
    result.bucket !== grant.resource.bucket ||
    result.key !== grant.resource.key ||
    result.versionId !== grant.resource.versionId ||
    (result.status !== 'ON' && result.status !== 'OFF')
  ) {
    return null;
  }
  return result.status;
}

type SecretDeleteRecoveryGrant = Extract<
  AuthorizedGrant,
  {
    authorityKind: 'CONNECTOR_DELETION_INTENT';
    operation: 'DESCRIBE_CONNECTOR_SECRET';
  }
>;

function isSecretDeleteRecoveryGrant(grant: AuthorizedGrant): grant is SecretDeleteRecoveryGrant {
  return (
    grant.authorityKind === 'CONNECTOR_DELETION_INTENT' &&
    grant.operation === 'DESCRIBE_CONNECTOR_SECRET' &&
    grant.resource.kind === 'CONNECTOR_SECRET'
  );
}

function readSecretDeleteRecoveryObservation(
  result: unknown,
): 'ABSENT' | 'DELETION_REQUESTED' | 'EXISTS' | null {
  if (
    exactObjectKeys(result, ['exists', 'kind']) &&
    result.kind === 'SECRET_DESCRIPTION' &&
    result.exists === false
  ) {
    return 'ABSENT';
  }
  if (
    exactObjectKeys(result, ['deletedAt', 'exists', 'kind']) &&
    result.kind === 'SECRET_DESCRIPTION' &&
    result.exists === true &&
    typeof result.deletedAt === 'string' &&
    isCanonicalInstant(result.deletedAt)
  ) {
    return 'DELETION_REQUESTED';
  }
  if (
    exactObjectKeys(result, ['exists', 'kind']) &&
    result.kind === 'SECRET_DESCRIPTION' &&
    result.exists === true
  ) {
    return 'EXISTS';
  }
  return null;
}
