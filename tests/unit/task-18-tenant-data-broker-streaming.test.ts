import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

const root = process.cwd();
const MEBIBYTE = 1_024 * 1_024;
const PART_BYTES = 5 * MEBIBYTE;
const MAX_OBJECT_BYTES = 2 * 1_024 * MEBIBYTE;
const SIGNAL_TIMEOUT_MS = 5_000;
const BROKER_HMAC_DOMAIN = 'AEO-TENANT-DATA-BROKER-HMAC-SHA256-V1';
const BROKER_AUDIENCE = 'tenant-data-broker.staging.internal';
const BROKER_PATH = '/internal/v1/tenant-data';
const BROKER_REQUEST_CONTENT_TYPE = 'application/vnd.aeostudio.tenant-data-request';
const BROKER_RESPONSE_CONTENT_TYPE = 'application/vnd.aeostudio.tenant-data+json';
const BROKER_NOW = new Date('2026-07-23T17:39:30.000Z');
const BROKER_TIMESTAMP = String(Math.floor(BROKER_NOW.getTime() / 1_000));
const BROKER_NONCE = '018f3b76-1000-7000-8000-000000000071';
const BROKER_ALTERNATE_NONCE = '018f3b76-1000-7000-8000-000000000072';
const BROKER_KEY_ID = 'tenant-data-broker-current';
const BROKER_PREVIOUS_KEY_ID = 'tenant-data-broker-previous';
const BROKER_SIGNING_KEY = 'tenant-data-broker-current-signing-key-2026';
const BROKER_PREVIOUS_SIGNING_KEY = 'tenant-data-broker-previous-signing-key-2026';

describe('Task 18 Tenant Data Broker streaming boundary', () => {
  test('exports the streaming HTTP transport and authoritative AWS executor factories', async () => {
    const broker = (await import('@aeostudio/adapters/tenant-data-broker')) as Record<
      string,
      unknown
    >;

    expect(
      broker.createTenantDataBrokerStreamingHttpTransport,
      'TENANT_DATA_BROKER_STREAMING_HTTP_TRANSPORT_UNAVAILABLE',
    ).toBeTypeOf('function');
    expect(
      broker.createAwsTenantDataBrokerExecutor,
      'TENANT_DATA_BROKER_AWS_EXECUTOR_UNAVAILABLE',
    ).toBeTypeOf('function');
  });

  test('frames a bounded command separately from a single-pass streaming payload', async () => {
    const source = await readFile(
      join(root, 'packages/adapters/src/tenant-data-broker/tenant-data-broker-http.ts'),
      'utf8',
    );

    expect(source).toMatch(/body\s*:\s*AsyncIterable<Uint8Array>/u);
    expect(source).toContain('x-aeostudio-command-sha256');
    expect(source).toContain('x-aeostudio-payload-length');
    expect(source).toContain('x-aeostudio-payload-sha256');
    expect(source).not.toContain('x-aeostudio-body-sha256');
    expect(source).not.toMatch(/const payload\s*=\s*Uint8Array\.from/u);
    expect(source).not.toMatch(/Buffer\.concat\s*\(/u);
  });

  test('carries one abort signal and deadline across HTTP and cloud effects', async () => {
    const sources = await Promise.all(
      [
        'packages/adapters/src/tenant-data-broker/tenant-data-broker-http.ts',
        'packages/adapters/src/tenant-data-broker/tenant-data-broker-aws-executor.ts',
      ].map((path) => readFile(join(root, path), 'utf8').catch(() => '')),
    );
    const combined = sources.join('\n');

    expect(combined).toMatch(/signal\s*:\s*AbortSignal/u);
    expect(combined).toMatch(/deadline/u);
    expect(combined).toMatch(/abortMultipartUpload|AbortMultipartUpload/u);
  });

  describe('streaming HTTP HMAC transport', () => {
    test('client invoke emits the exact signed command frame and an AsyncIterable request body', async () => {
      const broker = (await import('@aeostudio/adapters/tenant-data-broker')) as Record<
        string,
        unknown
      >;
      const Client = broker.TenantDataBrokerHttpClient;
      expect(Client).toBeTypeOf('function');
      const signal = AbortSignal.timeout(SIGNAL_TIMEOUT_MS);
      const deadline = new Date(BROKER_NOW.getTime() + SIGNAL_TIMEOUT_MS);
      const command = secretReadCommand();
      let transportCalls = 0;
      const client = new (Client as StreamingHttpClientConstructor)({
        clock: { now: () => new Date(BROKER_NOW) },
        endpoint: `https://${BROKER_AUDIENCE}${BROKER_PATH}`,
        nextNonce: () => BROKER_NONCE,
        signingKey: { id: BROKER_KEY_ID, value: BROKER_SIGNING_KEY },
        async transport(request) {
          transportCalls += 1;
          expect(request.signal).toBe(signal);
          expect(request.deadline).toEqual(deadline);
          expect(request.body).not.toBeInstanceOf(Uint8Array);
          const framedBody = await consumeBody(request.body);
          const commandLength = Buffer.from(framedBody).readUInt32BE(0);
          const commandBytes = framedBody.subarray(4, 4 + commandLength);
          const payloadBytes = framedBody.subarray(4 + commandLength);
          expect(Buffer.from(commandBytes).toString('utf8')).toBe(canonicalStreamingJson(command));
          expect(payloadBytes).toHaveLength(0);
          expect(request.headers['x-aeostudio-body-sha256']).toBeUndefined();
          expect(request.headers['transfer-encoding']).toBeUndefined();
          expect(request.headers['content-type']).toBe(BROKER_REQUEST_CONTENT_TYPE);
          expect(request.headers['x-aeostudio-command-length']).toBe(String(commandLength));
          expect(request.headers['x-aeostudio-command-sha256']).toBe(sha256(commandBytes));
          expect(request.headers['x-aeostudio-payload-length']).toBe('0');
          expect(request.headers['x-aeostudio-payload-sha256']).toBe(sha256(new Uint8Array()));
          expect(request.headers['content-length']).toBe(String(framedBody.byteLength));
          expect(request.headers.authorization).toBe(
            streamingAuthorization({
              audience: BROKER_AUDIENCE,
              commandLength: String(commandLength),
              commandSha256: sha256(commandBytes),
              domain: BROKER_HMAC_DOMAIN,
              keyId: BROKER_KEY_ID,
              method: 'POST',
              nonce: BROKER_NONCE,
              path: BROKER_PATH,
              payloadLength: '0',
              payloadSha256: sha256(new Uint8Array()),
              signingKey: BROKER_SIGNING_KEY,
              timestamp: BROKER_TIMESTAMP,
              totalContentLength: String(framedBody.byteLength),
            }),
          );
          return streamingJsonResponse({
            kind: 'SECRET_VALUE',
            value: 'fixture-connector-secret',
          });
        },
      });

      const result = await client.invoke(command, {
        body: singlePassBody([]),
        deadline,
        payloadLength: 0,
        payloadSha256: sha256(new Uint8Array()),
        signal,
      });

      expect(result).toEqual({
        kind: 'SECRET_VALUE',
        value: 'fixture-connector-secret',
      });
      expect(transportCalls).toBe(1);
    });

    test('accepts the exact versioned canonical signature and streams only the payload to the executor', async () => {
      const harness = await createStreamingHttpHarness();
      const signed = createSignedStreamingRequest();

      const response = await harness.transport.handle(signed.request);
      const responseBody = await consumeBody(response.body);

      expect(response.status).toBe(200);
      expect(JSON.parse(Buffer.from(responseBody).toString('utf8'))).toEqual({
        kind: 'SECRET_VALUE',
        value: 'fixture-connector-secret',
      });
      expect(signed.pulls.prefix).toBe(1);
      expect(signed.pulls.command).toBe(1);
      expect(signed.pulls.payload).toBe(0);
      expect(harness.calls).toMatchObject({
        atomicBegin: 1,
        attemptComplete: 1,
        attemptFail: 0,
        authorizer: 1,
        executor: 1,
      });
      expect(harness.attemptBegins).toHaveLength(1);
      expect(harness.attemptBegins[0]).toMatchObject({
        capabilityId: '018f3b76-1000-7000-8000-000000000031',
        expiresAt: new Date('2026-07-23T17:40:00.000Z'),
        leaseToken: '018f3b76-1000-7000-8000-000000000033',
        nonce: BROKER_NONCE,
        operation: 'READ_CONNECTOR_SECRET',
        resourceReferenceSha256: 'a'.repeat(64),
        signedAt: BROKER_NOW,
      });
      expect(harness.attemptCompletions).toHaveLength(1);
      expect(harness.attemptCompletions[0]).toMatchObject({
        attemptId: '018f3b76-1000-7000-8000-000000000073',
        leaseToken: '018f3b76-1000-7000-8000-000000000033',
        receipt: null,
      });
      expect(serializable(harness.attemptCompletions[0])).not.toContain('fixture-connector-secret');
      expect(harness.executorPayloads).toEqual([new Uint8Array()]);
    });

    test.each([
      [
        'versioned domain',
        (signed: SignedStreamingRequest) => {
          signed.request.headers.authorization = streamingAuthorization({
            ...signed.signatureFields,
            domain: `${BROKER_HMAC_DOMAIN}-TAMPERED`,
          });
        },
      ],
      [
        'method',
        (signed: SignedStreamingRequest) => {
          signed.request.method = 'PUT';
        },
      ],
      [
        'audience',
        (signed: SignedStreamingRequest) => {
          signed.request.url = `https://tenant-data-broker.other.internal${BROKER_PATH}`;
        },
      ],
      [
        'path',
        (signed: SignedStreamingRequest) => {
          signed.request.url = `https://${BROKER_AUDIENCE}/internal/v1/other`;
        },
      ],
      [
        'timestamp',
        (signed: SignedStreamingRequest) => {
          signed.request.headers['x-aeostudio-timestamp'] = String(Number(BROKER_TIMESTAMP) + 1);
        },
      ],
      [
        'nonce',
        (signed: SignedStreamingRequest) => {
          signed.request.headers['x-aeostudio-nonce'] = BROKER_ALTERNATE_NONCE;
        },
      ],
      [
        'key id',
        (signed: SignedStreamingRequest) => {
          signed.request.headers['x-aeostudio-key-id'] = BROKER_PREVIOUS_KEY_ID;
        },
      ],
      [
        'command length',
        (signed: SignedStreamingRequest) => {
          signed.request.headers['x-aeostudio-command-length'] = String(
            signed.commandBytes.byteLength + 1,
          );
        },
      ],
      [
        'command SHA-256',
        (signed: SignedStreamingRequest) => {
          signed.request.headers['x-aeostudio-command-sha256'] = '0'.repeat(64);
        },
      ],
      [
        'payload length',
        (signed: SignedStreamingRequest) => {
          signed.request.headers['x-aeostudio-payload-length'] = '1';
        },
      ],
      [
        'payload SHA-256',
        (signed: SignedStreamingRequest) => {
          signed.request.headers['x-aeostudio-payload-sha256'] = '0'.repeat(64);
        },
      ],
      [
        'total Content-Length',
        (signed: SignedStreamingRequest) => {
          signed.request.headers['content-length'] = String(
            Number(signed.signatureFields.totalContentLength) + 1,
          );
        },
      ],
    ] as const)(
      'rejects a tampered %s before reading the body or reaching the atomic nonce/attempt or executor',
      async (_field, tamper) => {
        const harness = await createStreamingHttpHarness();
        const signed = createSignedStreamingRequest();
        tamper(signed);

        const response = await harness.transport.handle(signed.request);

        expect(response.status).toBe(403);
        expect(signed.pulls).toEqual({ command: 0, payload: 0, prefix: 0 });
        expectNoBrokerEffects(harness.calls);
      },
    );

    test.each([
      'authorization',
      'content-length',
      'content-type',
      'x-aeostudio-command-length',
      'x-aeostudio-command-sha256',
      'x-aeostudio-key-id',
      'x-aeostudio-nonce',
      'x-aeostudio-payload-length',
      'x-aeostudio-payload-sha256',
      'x-aeostudio-timestamp',
    ])(
      'rejects a duplicate %s header before reading the body or reaching any effect',
      async (headerName) => {
        const harness = await createStreamingHttpHarness();
        const signed = createSignedStreamingRequest();
        const value = signed.request.headers[headerName];
        expect(value).toBeTypeOf('string');
        signed.request.headers[headerName] = [value as string, value as string];

        const response = await harness.transport.handle(signed.request);

        expect(response.status).toBe(403);
        expect(signed.pulls).toEqual({ command: 0, payload: 0, prefix: 0 });
        expectNoBrokerEffects(harness.calls);
      },
    );

    test('rejects Transfer-Encoding even when Content-Length and HMAC are otherwise exact', async () => {
      const harness = await createStreamingHttpHarness();
      const signed = createSignedStreamingRequest();
      signed.request.headers['transfer-encoding'] = 'chunked';

      const response = await harness.transport.handle(signed.request);

      expect(response.status).toBe(403);
      expect(signed.pulls).toEqual({ command: 0, payload: 0, prefix: 0 });
      expectNoBrokerEffects(harness.calls);
    });

    test.each([
      ['x-aeostudio-command-length', '00'],
      ['x-aeostudio-command-length', '-1'],
      ['x-aeostudio-command-length', '2147483649'],
      ['x-aeostudio-payload-length', '00'],
      ['x-aeostudio-payload-length', '-1'],
      ['x-aeostudio-payload-length', '2147483649'],
      ['content-length', '00'],
      ['content-length', '-1'],
    ])(
      'rejects non-canonical or out-of-range %s=%s before reading the body or reaching any effect',
      async (headerName, value) => {
        const harness = await createStreamingHttpHarness();
        const signed = createSignedStreamingRequest();
        setSignedLengthDeclaration(signed, headerName, value);

        const response = await harness.transport.handle(signed.request);

        expect(response.status).toBe(403);
        expect(signed.pulls).toEqual({ command: 0, payload: 0, prefix: 0 });
        expectNoBrokerEffects(harness.calls);
      },
    );

    test('rejects Content-Length 2147483649 when it does not equal this command plus payload frame', async () => {
      const harness = await createStreamingHttpHarness();
      const signed = createSignedStreamingRequest();
      setSignedLengthDeclaration(signed, 'content-length', '2147483649');

      const response = await harness.transport.handle(signed.request);

      expect(response.status).toBe(403);
      expect(signed.pulls).toEqual({ command: 0, payload: 0, prefix: 0 });
      expectNoBrokerEffects(harness.calls);
    });

    test.each([
      [
        'command length prefix',
        (signed: SignedStreamingRequest) => {
          signed.prefixBytes.writeUInt32BE(signed.commandBytes.byteLength + 1, 0);
        },
      ],
      [
        'command bytes',
        (signed: SignedStreamingRequest) => {
          const finalIndex = signed.commandBytes.byteLength - 1;
          signed.commandBytes[finalIndex] = signed.commandBytes[finalIndex] === 0x7d ? 0x7b : 0x7d;
        },
      ],
    ] as const)(
      'rejects tampered %s after only the bounded command frame and before any effect',
      async (_field, tamper) => {
        const harness = await createStreamingHttpHarness();
        const signed = createSignedStreamingRequest();
        tamper(signed);

        const response = await harness.transport.handle(signed.request);

        expect(response.status).toBe(403);
        expect(signed.pulls.payload).toBe(0);
        expectNoBrokerEffects(harness.calls);
      },
    );

    test.each([
      [
        'payload length',
        (payload: Uint8Array) => workloadPutGrant(payload.byteLength + 1, sha256(payload)),
      ],
      [
        'payload SHA-256',
        (payload: Uint8Array) => workloadPutGrant(payload.byteLength, 'f'.repeat(64)),
      ],
    ] as const)(
      'rejects a signed declaration whose %s differs from the authoritative grant before the atomic nonce/attempt or executor',
      async (_field, mismatchedGrant) => {
        const payload = new Uint8Array([0x10, 0x20, 0x30]);
        const harness = await createStreamingHttpHarness({
          grant: mismatchedGrant(payload),
        });
        const signed = createSignedStreamingRequest({
          command: workloadPutCommand(),
          payloadChunks: [payload],
        });

        const response = await harness.transport.handle(signed.request);

        expect(response.status).toBe(403);
        expect(signed.pulls.payload).toBe(0);
        expect(harness.calls.authorizer).toBe(1);
        expect(harness.calls.atomicBegin).toBe(0);
        expect(harness.calls.attemptComplete).toBe(0);
        expect(harness.calls.attemptFail).toBe(0);
        expect(harness.calls.executor).toBe(0);
      },
    );
  });

  test('streams a small PUT once with the authoritative checksum, length, KMS and create-only fence', async () => {
    const payload = Uint8Array.from({ length: 1_024 }, (_, index) => index % 251);
    const checksum = sha256(payload);
    let pulls = 0;
    let putInput: UnknownRecord | undefined;
    let putSignal: AbortSignal | undefined;
    const signal = AbortSignal.timeout(SIGNAL_TIMEOUT_MS);
    const executor = await createExecutor({
      s3: cloudPort({
        async putObject(input, receivedSignal) {
          putInput = input;
          putSignal = receivedSignal;
          expect(await consumeBody(bodyField(input))).toEqual(payload);
          return { versionId: 'version-small-1' };
        },
      }),
    });

    const result = await executor.execute({
      grant: workloadPutGrant(payload.byteLength, checksum),
      body: singlePassBody([payload], () => {
        pulls += 1;
      }),
      signal,
      deadline: new Date(Date.now() + SIGNAL_TIMEOUT_MS),
    });

    expect(pulls).toBe(1);
    expect(putSignal).toBeInstanceOf(AbortSignal);
    expect(putInput).toMatchObject({
      bucket: 'aeostudio-staging-artifacts',
      bucketKeyEnabled: true,
      checksumSha256: Buffer.from(checksum, 'hex').toString('base64'),
      contentLength: payload.byteLength,
      contentType: 'application/json',
      expectedBucketOwner: '123456789012',
      ifNoneMatch: '*',
      key: 'tenants/018f3b76-1000-7000-8000-000000000003/workspaces/018f3b76-1000-7000-8000-000000000004/artifacts/object.json',
      serverSideEncryption: 'aws:kms',
      sseKmsKeyId:
        'arn:aws:kms:ap-southeast-1:123456789012:key/11111111-1111-4111-8111-111111111111',
    });
    expect(serializable(putInput)).toContain(
      'arn:aws:kms:ap-southeast-1:123456789012:key/11111111-1111-4111-8111-111111111111',
    );
    expect(putInput?.metadata).toMatchObject({
      'aeostudio-direct-sha256': checksum,
    });
    expect(serializable(result)).toContain('version-small-1');
    expect(serializable(result)).toContain(checksum);
  });

  test('preserves a strict write-recovery HEAD metadata mismatch as the exact resolver observation signal', async () => {
    const checksum = 'a'.repeat(64);
    let headInput: UnknownRecord | undefined;
    const executor = await createExecutor({
      s3: cloudPort({
        headObject(input) {
          headInput = input;
          return Promise.resolve({
            exists: true,
            versionId: 'version-mismatched-1',
            metadata: { 'aeostudio-direct-sha256': 'b'.repeat(64) },
            contentType: 'application/json',
            byteLength: 128,
          });
        },
      }),
    });

    await expect(
      executor.execute({
        grant: workloadRecoveryHeadGrant(128, checksum),
        body: singlePassBody([]),
        signal: AbortSignal.timeout(SIGNAL_TIMEOUT_MS),
        deadline: new Date(Date.now() + SIGNAL_TIMEOUT_MS),
      }),
    ).rejects.toThrow('TENANT_DATA_BROKER_HEAD_METADATA_MISMATCH');
    expect(headInput).toMatchObject({
      bucket: 'aeostudio-staging-artifacts',
      checksumMode: 'ENABLED',
      expectedBucketOwner: '123456789012',
      key: 'tenants/018f3b76-1000-7000-8000-000000000003/workspaces/018f3b76-1000-7000-8000-000000000004/artifacts/object.json',
    });
    expect(headInput).not.toHaveProperty('versionId');
  });

  test('rejects an expired deadline before reading payload or calling a cloud port', async () => {
    const payload = new Uint8Array([0x01]);
    let pulls = 0;
    let cloudCalls = 0;
    const executor = await createExecutor({
      s3: cloudPort({
        putObject: () => {
          cloudCalls += 1;
          return Promise.reject(new Error('CLOUD_CALL_MUST_NOT_OCCUR'));
        },
      }),
    });

    await expect(
      executor.execute({
        grant: workloadPutGrant(payload.byteLength, sha256(payload)),
        body: singlePassBody([payload], () => {
          pulls += 1;
        }),
        signal: new AbortController().signal,
        deadline: new Date(Date.now() - 1),
      }),
    ).rejects.toThrow();

    expect(pulls).toBe(0);
    expect(cloudCalls).toBe(0);
  });

  test('aborts an in-flight cloud call when the absolute deadline elapses', async () => {
    const payload = new Uint8Array([0x01]);
    let observedSignal: AbortSignal | undefined;
    const executor = await createExecutor({
      s3: cloudPort({
        async putObject(input, signal) {
          observedSignal = signal;
          await consumeBody(bodyField(input));
          return new Promise((_resolve, reject) => {
            const rejectDeadline = () => {
              reject(new Error('deadline elapsed'));
            };
            if (signal.aborted) {
              rejectDeadline();
            } else {
              signal.addEventListener('abort', rejectDeadline, { once: true });
            }
          });
        },
      }),
    });

    await expect(
      executor.execute({
        grant: workloadPutGrant(payload.byteLength, sha256(payload)),
        body: singlePassBody([payload]),
        signal: new AbortController().signal,
        deadline: new Date(Date.now() + 50),
      }),
    ).rejects.toThrow();

    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal?.aborted).toBe(true);
  });

  test('uses fixed multipart parts with bounded in-flight work and completes only after direct SHA-256 matches', async () => {
    const chunks = [
      new Uint8Array(0),
      new Uint8Array(2 * MEBIBYTE).fill(0x11),
      new Uint8Array(8 * MEBIBYTE).fill(0x22),
      new Uint8Array(11 * MEBIBYTE).fill(0x33),
      new Uint8Array(9 * MEBIBYTE + 17).fill(0x44),
    ];
    const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const checksum = sha256Chunks(chunks);
    let pulls = 0;
    let activeUploads = 0;
    let maxActiveUploads = 0;
    const partLengths: number[] = [];
    const uploadedParts = new Map<
      number,
      { checksumSha256: string; etag: string; partNumber: number }
    >();
    const createInputs: UnknownRecord[] = [];
    const completeInputs: UnknownRecord[] = [];
    const primarySignals: AbortSignal[] = [];
    const signal = AbortSignal.timeout(SIGNAL_TIMEOUT_MS);
    const executor = await createExecutor({
      s3: cloudPort({
        createMultipartUpload(input) {
          createInputs.push(input);
          return Promise.resolve({ uploadId: 'upload-bounded-1' });
        },
        async uploadPart(input, receivedSignal) {
          primarySignals.push(receivedSignal);
          activeUploads += 1;
          maxActiveUploads = Math.max(maxActiveUploads, activeUploads);
          const partBody = await consumeBody(bodyField(input));
          partLengths.push(partBody.byteLength);
          const partChecksum = Buffer.from(sha256(partBody), 'hex').toString('base64');
          const partNumber = Number(input.partNumber);
          const etag = `"etag-${String(partNumber)}"`;
          expect(input).toMatchObject({
            bucket: 'aeostudio-staging-artifacts',
            checksumSha256: partChecksum,
            contentLength: partBody.byteLength,
            expectedBucketOwner: '123456789012',
            key: 'tenants/018f3b76-1000-7000-8000-000000000003/workspaces/018f3b76-1000-7000-8000-000000000004/artifacts/object.json',
            partNumber,
            uploadId: 'upload-bounded-1',
          });
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          activeUploads -= 1;
          uploadedParts.set(partNumber, {
            checksumSha256: partChecksum,
            etag,
            partNumber,
          });
          return {
            etag,
            checksumSha256: partChecksum,
          };
        },
        completeMultipartUpload(input) {
          completeInputs.push(input);
          return Promise.resolve({ versionId: 'version-multipart-1' });
        },
      }),
    });

    const result = await executor.execute({
      grant: workloadPutGrant(totalBytes, checksum),
      body: singlePassBody(chunks, () => {
        pulls += 1;
      }),
      signal,
      deadline: new Date(Date.now() + SIGNAL_TIMEOUT_MS),
    });

    expect(pulls).toBe(chunks.length);
    expect(partLengths).toEqual([
      PART_BYTES,
      PART_BYTES,
      PART_BYTES,
      PART_BYTES,
      PART_BYTES,
      PART_BYTES,
      17,
    ]);
    expect(maxActiveUploads).toBeLessThanOrEqual(2);
    expect(new Set(primarySignals).size).toBe(1);
    expect(createInputs).toHaveLength(1);
    expect(createInputs[0]).toMatchObject({
      bucket: 'aeostudio-staging-artifacts',
      bucketKeyEnabled: true,
      checksumAlgorithm: 'SHA256',
      checksumType: 'COMPOSITE',
      contentType: 'application/json',
      expectedBucketOwner: '123456789012',
      key: 'tenants/018f3b76-1000-7000-8000-000000000003/workspaces/018f3b76-1000-7000-8000-000000000004/artifacts/object.json',
      metadata: { 'aeostudio-direct-sha256': checksum },
      serverSideEncryption: 'aws:kms',
      sseKmsKeyId:
        'arn:aws:kms:ap-southeast-1:123456789012:key/11111111-1111-4111-8111-111111111111',
    });
    expect(completeInputs).toHaveLength(1);
    expect(completeInputs[0]).toMatchObject({
      bucket: 'aeostudio-staging-artifacts',
      checksumType: 'COMPOSITE',
      expectedBucketOwner: '123456789012',
      ifNoneMatch: '*',
      key: 'tenants/018f3b76-1000-7000-8000-000000000003/workspaces/018f3b76-1000-7000-8000-000000000004/artifacts/object.json',
      mpuObjectSize: totalBytes,
      parts: [...uploadedParts.values()].sort((left, right) => left.partNumber - right.partNumber),
      uploadId: 'upload-bounded-1',
    });
    expect(serializable(completeInputs[0])).not.toContain(checksum);
    expect(serializable(completeInputs[0])).not.toContain(
      Buffer.from(checksum, 'hex').toString('base64'),
    );
    expect(serializable(result)).toContain('version-multipart-1');
    expect(serializable(result)).toContain(checksum);
  });

  test('aborts multipart and never completes when the streamed hash differs from the grant', async () => {
    const payload = new Uint8Array(PART_BYTES + 1).fill(0x7b);
    const aborts: Array<{ input: UnknownRecord; signal: AbortSignal }> = [];
    let completes = 0;
    const executor = await createExecutor({
      s3: cloudPort({
        createMultipartUpload: () => Promise.resolve({ uploadId: 'upload-hash-mismatch' }),
        uploadPart: (input) =>
          Promise.resolve({
            etag: `"etag-${String(input.partNumber)}"`,
          }),
        completeMultipartUpload: () => {
          completes += 1;
          return Promise.resolve({ versionId: 'must-not-exist' });
        },
        abortMultipartUpload(input, signal) {
          aborts.push({ input, signal });
          return Promise.resolve({});
        },
        listParts: () => Promise.resolve({ parts: [] }),
      }),
    });

    await expect(
      executor.execute({
        grant: workloadPutGrant(payload.byteLength, '0'.repeat(64)),
        body: singlePassBody([payload]),
        signal: AbortSignal.timeout(SIGNAL_TIMEOUT_MS),
        deadline: new Date(Date.now() + SIGNAL_TIMEOUT_MS),
      }),
    ).rejects.toThrow();

    expect(completes).toBe(0);
    expect(aborts).toHaveLength(1);
    expect(serializable(aborts[0]?.input)).toContain('upload-hash-mismatch');
    expect(aborts[0]?.signal.aborted).toBe(false);
  });

  test('uses an independent bounded cleanup signal to abort multipart after client cancellation', async () => {
    const payload = new Uint8Array(PART_BYTES + 1).fill(0x41);
    const checksum = sha256(payload);
    const controller = new AbortController();
    const abortSignals: AbortSignal[] = [];
    let uploadSignal: AbortSignal | undefined;
    const executor = await createExecutor({
      s3: cloudPort({
        createMultipartUpload: () => Promise.resolve({ uploadId: 'upload-client-abort' }),
        uploadPart: (_input, signal) =>
          new Promise((_resolve, reject) => {
            uploadSignal = signal;
            signal.addEventListener(
              'abort',
              () => {
                reject(new Error('client aborted'));
              },
              { once: true },
            );
            queueMicrotask(() => {
              controller.abort();
            });
          }),
        abortMultipartUpload(_input, signal) {
          abortSignals.push(signal);
          return Promise.resolve({});
        },
        listParts: () => Promise.resolve({ parts: [] }),
      }),
    });

    await expect(
      executor.execute({
        grant: workloadPutGrant(payload.byteLength, checksum),
        body: singlePassBody([payload]),
        signal: controller.signal,
        deadline: new Date(Date.now() + SIGNAL_TIMEOUT_MS),
      }),
    ).rejects.toThrow();

    expect(abortSignals).toHaveLength(1);
    expect(uploadSignal).toBeInstanceOf(AbortSignal);
    expect(uploadSignal?.aborted).toBe(true);
    expect(abortSignals[0]).not.toBe(uploadSignal);
    expect(abortSignals[0]?.aborted).toBe(false);
  });

  test('repeats AbortMultipart and ListParts until in-flight residue is gone', async () => {
    const payload = new Uint8Array(PART_BYTES + 1).fill(0x52);
    let abortCalls = 0;
    let listCalls = 0;
    const cleanupSignals: AbortSignal[] = [];
    const executor = await createExecutor({
      s3: cloudPort({
        createMultipartUpload: () => Promise.resolve({ uploadId: 'upload-residual-parts' }),
        uploadPart: () => Promise.reject(new Error('upload part failed')),
        abortMultipartUpload: (input, signal) => {
          expect(input).toMatchObject({
            bucket: 'aeostudio-staging-artifacts',
            expectedBucketOwner: '123456789012',
            uploadId: 'upload-residual-parts',
          });
          abortCalls += 1;
          cleanupSignals.push(signal);
          return Promise.resolve({});
        },
        listParts: (input, signal) => {
          expect(input).toMatchObject({
            bucket: 'aeostudio-staging-artifacts',
            expectedBucketOwner: '123456789012',
            uploadId: 'upload-residual-parts',
          });
          listCalls += 1;
          cleanupSignals.push(signal);
          return Promise.resolve(listCalls === 1 ? { parts: [{ partNumber: 1 }] } : { parts: [] });
        },
      }),
    });

    await expect(
      executor.execute({
        grant: workloadPutGrant(payload.byteLength, sha256(payload)),
        body: singlePassBody([payload]),
        signal: AbortSignal.timeout(SIGNAL_TIMEOUT_MS),
        deadline: new Date(Date.now() + SIGNAL_TIMEOUT_MS),
      }),
    ).rejects.toThrow();

    expect(abortCalls).toBe(2);
    expect(listCalls).toBe(2);
    expect(new Set(cleanupSignals).size).toBe(1);
    expect(cleanupSignals[0]?.aborted).toBe(false);
  });

  test('starts backpressured multipart work for a synthetic 2 GiB stream without eagerly draining it', async () => {
    const reusableChunk = new Uint8Array(8 * MEBIBYTE).fill(0x2a);
    let pulls = 0;
    let aborts = 0;
    let completes = 0;
    const controller = new AbortController();
    const executor = await createExecutor({
      s3: cloudPort({
        createMultipartUpload: () => Promise.resolve({ uploadId: 'upload-synthetic-2gib' }),
        uploadPart: () => {
          controller.abort();
          return Promise.reject(new Error('synthetic client abort'));
        },
        completeMultipartUpload: () => {
          completes += 1;
          return Promise.resolve({ versionId: 'must-not-exist' });
        },
        abortMultipartUpload: () => {
          aborts += 1;
          return Promise.resolve({});
        },
        listParts: () => Promise.resolve({ parts: [] }),
      }),
    });
    const body: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        for (let index = 0; index < 256; index += 1) {
          pulls += 1;
          if (pulls > 3) throw new Error('PAYLOAD_EAGERLY_DRAINED');
          yield reusableChunk;
        }
      },
    };

    await expect(
      executor.execute({
        grant: workloadPutGrant(MAX_OBJECT_BYTES, '0'.repeat(64)),
        body,
        signal: controller.signal,
        deadline: new Date(Date.now() + SIGNAL_TIMEOUT_MS),
      }),
    ).rejects.toThrow();

    expect(pulls).toBeLessThanOrEqual(2);
    expect(aborts).toBe(1);
    expect(completes).toBe(0);
  });

  test.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['above 2 GiB', MAX_OBJECT_BYTES + 1],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects a %s declared payload length before body or cloud work', async (_, byteLength) => {
    let pulls = 0;
    let cloudCalls = 0;
    const executor = await createExecutor({
      s3: cloudPort({
        putObject: () => {
          cloudCalls += 1;
          return Promise.reject(new Error('CLOUD_CALL_MUST_NOT_OCCUR'));
        },
        createMultipartUpload: () => {
          cloudCalls += 1;
          return Promise.reject(new Error('CLOUD_CALL_MUST_NOT_OCCUR'));
        },
      }),
    });

    await expect(
      executor.execute({
        grant: workloadPutGrant(byteLength, '0'.repeat(64)),
        body: singlePassBody([new Uint8Array([0x01])], () => {
          pulls += 1;
        }),
        signal: AbortSignal.timeout(SIGNAL_TIMEOUT_MS),
        deadline: new Date(Date.now() + SIGNAL_TIMEOUT_MS),
      }),
    ).rejects.toThrow();

    expect(pulls).toBe(0);
    expect(cloudCalls).toBe(0);
  });

  test.each([
    ['longer', -1],
    ['shorter', 1],
  ])('aborts and never completes when streamed bytes are %s than declared', async (_, delta) => {
    const payload = new Uint8Array(PART_BYTES + 1).fill(0x6c);
    let aborts = 0;
    let completes = 0;
    const executor = await createExecutor({
      s3: cloudPort({
        createMultipartUpload: () =>
          Promise.resolve({ uploadId: `upload-length-${String(delta)}` }),
        async uploadPart(input) {
          const body = await consumeBody(bodyField(input));
          return {
            etag: `"etag-${String(input.partNumber)}"`,
            checksumSha256: Buffer.from(sha256(body), 'hex').toString('base64'),
          };
        },
        completeMultipartUpload: () => {
          completes += 1;
          return Promise.resolve({ versionId: 'must-not-exist' });
        },
        abortMultipartUpload: () => {
          aborts += 1;
          return Promise.resolve({});
        },
        listParts: () => Promise.resolve({ parts: [] }),
      }),
    });

    await expect(
      executor.execute({
        grant: workloadPutGrant(payload.byteLength + delta, sha256(payload)),
        body: singlePassBody([payload]),
        signal: AbortSignal.timeout(SIGNAL_TIMEOUT_MS),
        deadline: new Date(Date.now() + SIGNAL_TIMEOUT_MS),
      }),
    ).rejects.toThrow();

    expect(aborts).toBe(1);
    expect(completes).toBe(0);
  });

  test('returns GET content as an unmaterialized stream bound to the request abort signal', async () => {
    const payload = new Uint8Array([0x10, 0x20, 0x30]);
    const checksum = sha256(payload);
    let bodyPulls = 0;
    let getInput: UnknownRecord | undefined;
    let getSignal: AbortSignal | undefined;
    const controller = new AbortController();
    const compositeChecksum = Buffer.from(
      sha256(new TextEncoder().encode('multipart-composite-checksum')),
      'hex',
    ).toString('base64');
    const executor = await createExecutor({
      s3: cloudPort({
        getObject(input, signal) {
          getInput = input;
          getSignal = signal;
          return Promise.resolve({
            body: singlePassBody([payload], () => {
              bodyPulls += 1;
            }),
            byteLength: payload.byteLength,
            checksumSha256: compositeChecksum,
            contentType: 'application/octet-stream',
            metadata: { 'aeostudio-direct-sha256': checksum },
            versionId: 'version-read-1',
          });
        },
      }),
    });

    const result = await executor.execute({
      grant: workloadReadGrant(payload.byteLength, checksum),
      body: singlePassBody([]),
      signal: controller.signal,
      deadline: new Date(Date.now() + SIGNAL_TIMEOUT_MS),
    });

    expect(bodyPulls).toBe(0);
    expect(getSignal).toBeInstanceOf(AbortSignal);
    expect(getInput).toMatchObject({
      checksumMode: 'ENABLED',
      expectedBucketOwner: '123456789012',
      versionId: 'version-read-1',
    });
    const responseBody = findAsyncBody(result);
    expect(responseBody).not.toBeNull();
    expect(await consumeBody(responseBody)).toEqual(payload);
    expect(bodyPulls).toBe(1);
  });

  test('releases an upstream GET stream when the caller aborts after headers', async () => {
    const payload = new Uint8Array([0x10, 0x20, 0x30]);
    const checksum = sha256(payload);
    const controller = new AbortController();
    let upstreamReturned = false;
    let getSignal: AbortSignal | undefined;
    const upstream: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        let emitted = false;
        return {
          next: () => {
            if (!emitted) {
              emitted = true;
              return Promise.resolve({ done: false as const, value: payload });
            }
            return new Promise<IteratorResult<Uint8Array>>(() => undefined);
          },
          return: () => {
            upstreamReturned = true;
            return Promise.resolve({ done: true as const, value: undefined });
          },
        };
      },
    };
    const executor = await createExecutor({
      s3: cloudPort({
        getObject: (_input, signal) => {
          getSignal = signal;
          return Promise.resolve({
            body: upstream,
            byteLength: payload.byteLength,
            checksumSha256: Buffer.from(
              sha256(new TextEncoder().encode('composite-checksum')),
              'hex',
            ).toString('base64'),
            contentType: 'application/octet-stream',
            metadata: { 'aeostudio-direct-sha256': checksum },
            versionId: 'version-read-1',
          });
        },
      }),
    });
    const result = await executor.execute({
      grant: workloadReadGrant(payload.byteLength, checksum),
      body: singlePassBody([]),
      signal: controller.signal,
      deadline: new Date(Date.now() + SIGNAL_TIMEOUT_MS),
    });
    const responseBody = findAsyncBody(result);
    if (responseBody === null) throw new Error('EXPECTED_STREAMING_GET_BODY');
    const iterator = responseBody[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: false, value: payload });
    controller.abort();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(getSignal?.aborted).toBe(true);
    expect(upstreamReturned).toBe(true);
    await expect(iterator.next()).rejects.toThrow();
  });

  test('rejects incorrect immutable direct-hash metadata before reading a GET body', async () => {
    const payload = new Uint8Array([0x10, 0x20, 0x30]);
    const checksum = sha256(payload);
    let bodyPulls = 0;
    const executor = await createExecutor({
      s3: cloudPort({
        getObject: () =>
          Promise.resolve({
            body: singlePassBody([payload], () => {
              bodyPulls += 1;
            }),
            byteLength: payload.byteLength,
            checksumSha256: Buffer.from(
              sha256(new TextEncoder().encode('composite-checksum')),
              'hex',
            ).toString('base64'),
            contentType: 'application/octet-stream',
            metadata: { 'aeostudio-direct-sha256': 'f'.repeat(64) },
            versionId: 'version-read-1',
          }),
      }),
    });

    await expect(
      executor.execute({
        grant: workloadReadGrant(payload.byteLength, checksum),
        body: singlePassBody([]),
        signal: AbortSignal.timeout(SIGNAL_TIMEOUT_MS),
        deadline: new Date(Date.now() + SIGNAL_TIMEOUT_MS),
      }),
    ).rejects.toThrow();

    expect(bodyPulls).toBe(0);
  });

  test('rejects a cross-class bucket before any cloud call', async () => {
    const payload = new Uint8Array([0x01]);
    let cloudCalls = 0;
    const countCall = () => {
      cloudCalls += 1;
      return Promise.reject(new Error('CLOUD_CALL_MUST_NOT_OCCUR'));
    };
    const executor = await createExecutor({
      s3: cloudPort({
        putObject: countCall,
        createMultipartUpload: countCall,
      }),
    });

    await expect(
      executor.execute({
        grant: auditPutGrantWithWrongBucket(payload.byteLength, sha256(payload)),
        body: singlePassBody([payload]),
        signal: AbortSignal.timeout(SIGNAL_TIMEOUT_MS),
        deadline: new Date(Date.now() + SIGNAL_TIMEOUT_MS),
      }),
    ).rejects.toThrow();

    expect(cloudCalls).toBe(0);
  });

  test('writes Audit Evidence only to the audit bucket with exact compliance retention', async () => {
    const payload = new Uint8Array([0x01]);
    const checksum = sha256(payload);
    let putInput: UnknownRecord | undefined;
    const executor = await createExecutor({
      s3: cloudPort({
        async putObject(input) {
          putInput = input;
          await consumeBody(bodyField(input));
          return { versionId: 'audit-version-1' };
        },
      }),
    });

    await expect(
      executor.execute({
        grant: auditPutGrant(payload.byteLength, checksum),
        body: singlePassBody([payload]),
        signal: AbortSignal.timeout(SIGNAL_TIMEOUT_MS),
        deadline: new Date(Date.now() + SIGNAL_TIMEOUT_MS),
      }),
    ).resolves.toBeDefined();

    expect(putInput).toMatchObject({
      bucket: 'aeostudio-staging-audit-evidence',
      bucketKeyEnabled: true,
      expectedBucketOwner: '123456789012',
      ifNoneMatch: '*',
      objectLockMode: 'COMPLIANCE',
      objectLockRetainUntilDate: '2027-07-23T00:00:00.000Z',
      serverSideEncryption: 'aws:kms',
      sseKmsKeyId:
        'arn:aws:kms:ap-southeast-1:123456789012:key/11111111-1111-4111-8111-111111111111',
    });
    expect(putInput?.metadata).toMatchObject({
      'aeostudio-direct-sha256': checksum,
    });
  });

  test('rejects a cross-Tenant Connector secret ARN before any Secrets Manager call', async () => {
    let secretCalls = 0;
    const rejectSecretCall = () => {
      secretCalls += 1;
      return Promise.reject(new Error('SECRET_CALL_MUST_NOT_OCCUR'));
    };
    const executor = await createExecutor({
      s3: cloudPort({}),
      secrets: {
        describeSecret: rejectSecretCall,
        getSecretValue: rejectSecretCall,
        deleteSecret: rejectSecretCall,
      },
    });

    await expect(
      executor.execute({
        grant: secretReadGrant(
          'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:tenant-018f3b76-1000-7000-8000-000000000099/workspace-018f3b76-1000-7000-8000-000000000004/connector-ABC123',
        ),
        body: singlePassBody([]),
        signal: AbortSignal.timeout(SIGNAL_TIMEOUT_MS),
        deadline: new Date(Date.now() + SIGNAL_TIMEOUT_MS),
      }),
    ).rejects.toThrow();

    expect(secretCalls).toBe(0);
  });

  test('describes a provider-missing Connector secret as an observed absence', async () => {
    const secretArn =
      'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:tenant-018f3b76-1000-7000-8000-000000000003/workspace-018f3b76-1000-7000-8000-000000000004/connector-ABC123';
    const missing = Object.assign(new Error('provider secret is absent'), {
      name: 'ResourceNotFoundException',
    });
    const executor = await createExecutor({
      s3: cloudPort({}),
      secrets: {
        describeSecret: () => Promise.reject(missing),
        getSecretValue: () => Promise.reject(new Error('GET_SECRET_MUST_NOT_OCCUR')),
        deleteSecret: () => Promise.reject(new Error('DELETE_SECRET_MUST_NOT_OCCUR')),
      },
    });

    await expect(
      executor.execute({
        grant: secretDescriptionGrant(secretArn),
        body: singlePassBody([]),
        signal: AbortSignal.timeout(SIGNAL_TIMEOUT_MS),
        deadline: new Date(Date.now() + SIGNAL_TIMEOUT_MS),
      }),
    ).resolves.toEqual({ kind: 'SECRET_DESCRIPTION', exists: false });
  });

  test('verifies Connector secret unreadability as a boolean without returning a readable value', async () => {
    const secretValue = 'SECRET_VALUE_MUST_NOT_ESCAPE_BOOLEAN_PROBE';
    const secretArn =
      'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:tenant-018f3b76-1000-7000-8000-000000000003/workspace-018f3b76-1000-7000-8000-000000000004/connector-ABC123';
    const executor = await createExecutor({
      s3: cloudPort({}),
      secrets: {
        describeSecret: () => Promise.resolve({ exists: true }),
        getSecretValue: () => Promise.resolve({ secretString: secretValue }),
        deleteSecret: () => Promise.reject(new Error('DELETE_SECRET_MUST_NOT_OCCUR')),
      },
    });

    const result = await executor.execute({
      grant: secretUnreadableVerificationGrant(secretArn),
      body: singlePassBody([]),
      signal: AbortSignal.timeout(SIGNAL_TIMEOUT_MS),
      deadline: new Date(Date.now() + SIGNAL_TIMEOUT_MS),
    });

    expect(serializable(result)).toContain('false');
    expect(serializable(result)).not.toContain(secretValue);
  });
});

interface StreamingHttpRequest {
  method: string;
  url: string;
  headers: Record<string, string | readonly string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  signal: AbortSignal;
  deadline: Date;
}

interface StreamingHttpResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: AsyncIterable<Uint8Array>;
}

interface StreamingHttpTransport {
  handle(request: StreamingHttpRequest): Promise<StreamingHttpResponse>;
}

interface BrokerHarnessCalls {
  atomicBegin: number;
  attemptComplete: number;
  attemptFail: number;
  authorizer: number;
  executor: number;
}

interface StreamingSignatureFields {
  audience: string;
  commandLength: string;
  commandSha256: string;
  domain: string;
  keyId: string;
  method: string;
  nonce: string;
  path: string;
  payloadLength: string;
  payloadSha256: string;
  signingKey: string;
  timestamp: string;
  totalContentLength: string;
}

interface SignedStreamingRequest {
  commandBytes: Uint8Array;
  prefixBytes: Buffer;
  pulls: {
    command: number;
    payload: number;
    prefix: number;
  };
  request: StreamingHttpRequest;
  signatureFields: StreamingSignatureFields;
}

interface StreamingHttpClient {
  invoke(
    command: UnknownRecord,
    input: {
      body: AsyncIterable<Uint8Array>;
      deadline: Date;
      payloadLength: number;
      payloadSha256: string;
      signal: AbortSignal;
    },
  ): Promise<unknown>;
}

type StreamingHttpClientConstructor = new (options: {
  clock: { now(): Date };
  endpoint: string;
  nextNonce(): string;
  signingKey: { id: string; value: string };
  transport(request: StreamingHttpRequest): Promise<StreamingHttpResponse>;
}) => StreamingHttpClient;

type StreamingHttpTransportFactory = (options: {
  attempts: {
    beginAuthenticated(input: UnknownRecord): Promise<UnknownRecord>;
    complete(input: UnknownRecord): Promise<void>;
    fail(input: UnknownRecord): Promise<void>;
  };
  audience: string;
  authorizer: {
    authorize(request: UnknownRecord): Promise<UnknownRecord>;
  };
  clock: { now(): Date };
  effectResolver: {
    resolveObjectPut(input: UnknownRecord): Promise<string>;
    resolveLegalHold(input: UnknownRecord): Promise<string>;
    resolveSecretDelete(input: UnknownRecord): Promise<string>;
  };
  executor: {
    execute(input: {
      body: AsyncIterable<Uint8Array>;
      deadline: Date;
      grant: UnknownRecord;
      signal: AbortSignal;
    }): Promise<unknown>;
  };
  logger: {
    info(entry: Readonly<Record<string, unknown>>): void;
    warn(entry: Readonly<Record<string, unknown>>): void;
  };
  signingKeys: {
    current: { id: string; value: string };
    previous: { acceptUntil: string; id: string; value: string };
  };
}) => StreamingHttpTransport;

async function createStreamingHttpHarness(input: { grant?: UnknownRecord } = {}): Promise<{
  attemptBegins: UnknownRecord[];
  attemptCompletions: UnknownRecord[];
  calls: BrokerHarnessCalls;
  executorPayloads: Uint8Array[];
  transport: StreamingHttpTransport;
}> {
  const broker = (await import('@aeostudio/adapters/tenant-data-broker')) as Record<
    string,
    unknown
  >;
  const factory = broker.createTenantDataBrokerStreamingHttpTransport;
  if (typeof factory !== 'function') {
    throw new Error('TENANT_DATA_BROKER_STREAMING_HTTP_TRANSPORT_UNAVAILABLE');
  }
  const calls: BrokerHarnessCalls = {
    atomicBegin: 0,
    attemptComplete: 0,
    attemptFail: 0,
    authorizer: 0,
    executor: 0,
  };
  const attemptBegins: UnknownRecord[] = [];
  const attemptCompletions: UnknownRecord[] = [];
  const executorPayloads: Uint8Array[] = [];
  const defaultGrant = secretReadGrant(
    'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:aeostudio/tenants/018f3b76-1000-7000-8000-000000000003/workspaces/018f3b76-1000-7000-8000-000000000004/connectors/fixture-AbCdEf',
  );
  const grant = input.grant ?? {
    ...defaultGrant,
    expiresAt: '2026-07-23T17:44:00.000Z',
  };
  const transport = (factory as StreamingHttpTransportFactory)({
    audience: BROKER_AUDIENCE,
    signingKeys: {
      current: {
        id: BROKER_KEY_ID,
        value: BROKER_SIGNING_KEY,
      },
      previous: {
        acceptUntil: '2026-07-23T17:44:00.000Z',
        id: BROKER_PREVIOUS_KEY_ID,
        value: BROKER_PREVIOUS_SIGNING_KEY,
      },
    },
    authorizer: {
      authorize() {
        calls.authorizer += 1;
        return Promise.resolve({
          audit: { resourceReferenceSha256: 'a'.repeat(64) },
          grant,
          outcome: 'AUTHORIZED',
        });
      },
    },
    attempts: {
      beginAuthenticated(attempt) {
        calls.atomicBegin += 1;
        attemptBegins.push(attempt);
        return Promise.resolve({
          attemptId: '018f3b76-1000-7000-8000-000000000073',
          outcome: 'STARTED',
        });
      },
      complete(completion) {
        calls.attemptComplete += 1;
        attemptCompletions.push(completion);
        return Promise.resolve();
      },
      fail() {
        calls.attemptFail += 1;
        return Promise.resolve();
      },
    },
    effectResolver: {
      resolveObjectPut: () => Promise.resolve('NOT_RESOLVED'),
      resolveLegalHold: () => Promise.resolve('NOT_RESOLVED'),
      resolveSecretDelete: () => Promise.resolve('NOT_RESOLVED'),
    },
    executor: {
      async execute(execution) {
        calls.executor += 1;
        executorPayloads.push(await consumeBody(execution.body));
        return {
          kind: 'SECRET_VALUE',
          value: 'fixture-connector-secret',
        };
      },
    },
    clock: { now: () => new Date(BROKER_NOW) },
    logger: {
      info: () => undefined,
      warn: () => undefined,
    },
  });
  return {
    attemptBegins,
    attemptCompletions,
    calls,
    executorPayloads,
    transport,
  };
}

function createSignedStreamingRequest(
  input: {
    command?: UnknownRecord;
    payloadChunks?: readonly Uint8Array[];
  } = {},
): SignedStreamingRequest {
  const command = input.command ?? secretReadCommand();
  const payloadChunks = input.payloadChunks ?? [];
  const commandBytes = new TextEncoder().encode(canonicalStreamingJson(command));
  const prefixBytes = Buffer.alloc(4);
  prefixBytes.writeUInt32BE(commandBytes.byteLength, 0);
  const payloadLength = payloadChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const totalContentLength = 4 + commandBytes.byteLength + payloadLength;
  const signatureFields: StreamingSignatureFields = {
    audience: BROKER_AUDIENCE,
    commandLength: String(commandBytes.byteLength),
    commandSha256: sha256(commandBytes),
    domain: BROKER_HMAC_DOMAIN,
    keyId: BROKER_KEY_ID,
    method: 'POST',
    nonce: BROKER_NONCE,
    path: BROKER_PATH,
    payloadLength: String(payloadLength),
    payloadSha256: sha256Chunks(payloadChunks),
    signingKey: BROKER_SIGNING_KEY,
    timestamp: BROKER_TIMESTAMP,
    totalContentLength: String(totalContentLength),
  };
  const pulls = { command: 0, payload: 0, prefix: 0 };
  let consumed = false;
  const body: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      if (consumed) throw new Error('HTTP_REQUEST_BODY_READ_MORE_THAN_ONCE');
      consumed = true;
      pulls.prefix += 1;
      yield prefixBytes;
      pulls.command += 1;
      yield commandBytes;
      for (const chunk of payloadChunks) {
        pulls.payload += 1;
        yield chunk;
      }
    },
  };
  return {
    commandBytes,
    prefixBytes,
    pulls,
    request: {
      method: 'POST',
      url: `https://${BROKER_AUDIENCE}${BROKER_PATH}`,
      headers: {
        authorization: streamingAuthorization(signatureFields),
        'content-length': String(totalContentLength),
        'content-type': BROKER_REQUEST_CONTENT_TYPE,
        'x-aeostudio-command-length': String(commandBytes.byteLength),
        'x-aeostudio-command-sha256': sha256(commandBytes),
        'x-aeostudio-key-id': BROKER_KEY_ID,
        'x-aeostudio-nonce': BROKER_NONCE,
        'x-aeostudio-payload-length': String(payloadLength),
        'x-aeostudio-payload-sha256': sha256Chunks(payloadChunks),
        'x-aeostudio-timestamp': BROKER_TIMESTAMP,
      },
      body,
      signal: AbortSignal.timeout(SIGNAL_TIMEOUT_MS),
      deadline: new Date(BROKER_NOW.getTime() + SIGNAL_TIMEOUT_MS),
    },
    signatureFields,
  };
}

function streamingAuthorization(input: StreamingSignatureFields): string {
  const canonical = [
    input.domain,
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
  ].join('\n');
  const signature = createHmac('sha256', input.signingKey).update(canonical, 'utf8').digest('hex');
  return `AEO-HMAC-SHA256 ${signature}`;
}

function setSignedLengthDeclaration(
  signed: SignedStreamingRequest,
  headerName: 'content-length' | 'x-aeostudio-command-length' | 'x-aeostudio-payload-length',
  value: string,
): void {
  signed.request.headers[headerName] = value;
  const signatureFields = {
    ...signed.signatureFields,
    ...(headerName === 'content-length'
      ? { totalContentLength: value }
      : headerName === 'x-aeostudio-command-length'
        ? { commandLength: value }
        : { payloadLength: value }),
  };
  signed.request.headers.authorization = streamingAuthorization(signatureFields);
}

function streamingJsonResponse(value: unknown): StreamingHttpResponse {
  const body = new TextEncoder().encode(JSON.stringify(value));
  return {
    status: 200,
    headers: {
      'cache-control': 'no-store',
      'content-length': String(body.byteLength),
      'content-type': BROKER_RESPONSE_CONTENT_TYPE,
      pragma: 'no-cache',
      'x-content-type-options': 'nosniff',
    },
    body: singlePassBody([body]),
  };
}

function canonicalStreamingJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalStreamingJson(entry)).join(',')}]`;
  }
  if (typeof value !== 'object') {
    throw new Error('STREAMING_COMMAND_NOT_CANONICAL_JSON');
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalStreamingJson(entry)}`)
    .join(',')}}`;
}

function expectNoBrokerEffects(calls: BrokerHarnessCalls): void {
  expect(calls).toEqual({
    atomicBegin: 0,
    attemptComplete: 0,
    attemptFail: 0,
    authorizer: 0,
    executor: 0,
  });
}

function secretReadCommand(): UnknownRecord {
  return {
    authorityReference: '018f3b76-1000-7000-8000-000000000032',
    capabilityId: '018f3b76-1000-7000-8000-000000000031',
    leaseToken: '018f3b76-1000-7000-8000-000000000033',
    operation: 'READ_CONNECTOR_SECRET',
    scopeKind: 'WORKSPACE',
    tenantId: '018f3b76-1000-7000-8000-000000000003',
    workspaceId: '018f3b76-1000-7000-8000-000000000004',
  };
}

function workloadPutCommand(): UnknownRecord {
  return {
    authorityReference: '018f3b76-1000-7000-8000-000000000002',
    capabilityId: '018f3b76-1000-7000-8000-000000000001',
    leaseToken: '018f3b76-1000-7000-8000-000000000005',
    operation: 'PUT_WORKLOAD_OBJECT',
    scopeKind: 'WORKSPACE',
    tenantId: '018f3b76-1000-7000-8000-000000000003',
    workspaceId: '018f3b76-1000-7000-8000-000000000004',
  };
}

type UnknownRecord = Record<string, unknown>;

interface NamedCloudPort {
  putObject(input: UnknownRecord, signal: AbortSignal): Promise<UnknownRecord>;
  createMultipartUpload(input: UnknownRecord, signal: AbortSignal): Promise<UnknownRecord>;
  uploadPart(input: UnknownRecord, signal: AbortSignal): Promise<UnknownRecord>;
  completeMultipartUpload(input: UnknownRecord, signal: AbortSignal): Promise<UnknownRecord>;
  abortMultipartUpload(input: UnknownRecord, signal: AbortSignal): Promise<UnknownRecord>;
  listParts(input: UnknownRecord, signal: AbortSignal): Promise<UnknownRecord>;
  getObject(input: UnknownRecord, signal: AbortSignal): Promise<UnknownRecord>;
  headObject(input: UnknownRecord, signal: AbortSignal): Promise<UnknownRecord>;
  deleteObject(input: UnknownRecord, signal: AbortSignal): Promise<UnknownRecord>;
  listObjectVersions(input: UnknownRecord, signal: AbortSignal): Promise<UnknownRecord>;
  getObjectLegalHold(input: UnknownRecord, signal: AbortSignal): Promise<UnknownRecord>;
  putObjectLegalHold(input: UnknownRecord, signal: AbortSignal): Promise<UnknownRecord>;
}

interface NamedSecretsPort {
  describeSecret(input: UnknownRecord, signal: AbortSignal): Promise<UnknownRecord>;
  getSecretValue(input: UnknownRecord, signal: AbortSignal): Promise<UnknownRecord>;
  deleteSecret(input: UnknownRecord, signal: AbortSignal): Promise<UnknownRecord>;
}

interface StreamingExecutor {
  execute(input: {
    grant: UnknownRecord;
    body: AsyncIterable<Uint8Array>;
    signal: AbortSignal;
    deadline: Date;
  }): Promise<unknown>;
}

type ExecutorFactory = (options: {
  artifactBucket: string;
  auditEvidenceBucket: string;
  expectedBucketOwner: string;
  kmsKeyArn: string;
  multipartPartBytes: number;
  s3: NamedCloudPort;
  secrets: NamedSecretsPort;
}) => StreamingExecutor;

async function createExecutor(input: {
  s3: NamedCloudPort;
  secrets?: NamedSecretsPort;
}): Promise<StreamingExecutor> {
  const broker = (await import('@aeostudio/adapters/tenant-data-broker')) as Record<
    string,
    unknown
  >;
  const factory = broker.createAwsTenantDataBrokerExecutor;
  if (typeof factory !== 'function') {
    throw new Error('TENANT_DATA_BROKER_AWS_EXECUTOR_UNAVAILABLE');
  }
  return (factory as ExecutorFactory)({
    artifactBucket: 'aeostudio-staging-artifacts',
    auditEvidenceBucket: 'aeostudio-staging-audit-evidence',
    expectedBucketOwner: '123456789012',
    kmsKeyArn: 'arn:aws:kms:ap-southeast-1:123456789012:key/11111111-1111-4111-8111-111111111111',
    multipartPartBytes: PART_BYTES,
    s3: input.s3,
    secrets: input.secrets ?? secretsPort(),
  });
}

function cloudPort(overrides: Partial<NamedCloudPort>): NamedCloudPort {
  const unavailable = (operation: string) => () =>
    Promise.reject(new Error(`UNEXPECTED_CLOUD_OPERATION:${operation}`));
  return {
    putObject: unavailable('putObject'),
    createMultipartUpload: unavailable('createMultipartUpload'),
    uploadPart: unavailable('uploadPart'),
    completeMultipartUpload: unavailable('completeMultipartUpload'),
    abortMultipartUpload: unavailable('abortMultipartUpload'),
    listParts: unavailable('listParts'),
    getObject: unavailable('getObject'),
    headObject: unavailable('headObject'),
    deleteObject: unavailable('deleteObject'),
    listObjectVersions: unavailable('listObjectVersions'),
    getObjectLegalHold: unavailable('getObjectLegalHold'),
    putObjectLegalHold: unavailable('putObjectLegalHold'),
    ...overrides,
  };
}

function secretsPort(): NamedSecretsPort {
  const unavailable = () => Promise.reject(new Error('UNEXPECTED_SECRET_OPERATION'));
  return {
    describeSecret: unavailable,
    getSecretValue: unavailable,
    deleteSecret: unavailable,
  };
}

function workloadPutGrant(byteLength: number, checksumSha256: string): UnknownRecord {
  return {
    capabilityId: '018f3b76-1000-7000-8000-000000000001',
    authorityKind: 'WORKLOAD_WRITE_INTENT',
    authorityReference: '018f3b76-1000-7000-8000-000000000002',
    scopeKind: 'WORKSPACE',
    tenantId: '018f3b76-1000-7000-8000-000000000003',
    workspaceId: '018f3b76-1000-7000-8000-000000000004',
    operation: 'PUT_WORKLOAD_OBJECT',
    resource: {
      kind: 'WORKLOAD_OBJECT_PUT',
      objectClass: 'WORKLOAD_OBJECTS',
      bucket: 'aeostudio-staging-artifacts',
      key: 'tenants/018f3b76-1000-7000-8000-000000000003/workspaces/018f3b76-1000-7000-8000-000000000004/artifacts/object.json',
      checksumSha256,
      contentType: 'application/json',
      byteLength,
      lockedUntil: null,
      sealedAt: null,
    },
    expiresAt: '2026-07-23T17:40:00.000Z',
  };
}

function workloadReadGrant(byteLength: number, checksumSha256: string): UnknownRecord {
  return {
    capabilityId: '018f3b76-1000-7000-8000-000000000011',
    authorityKind: 'ACTIVE_JOB_OBJECT_READ',
    authorityReference: '018f3b76-1000-7000-8000-000000000012',
    scopeKind: 'WORKSPACE',
    tenantId: '018f3b76-1000-7000-8000-000000000003',
    workspaceId: '018f3b76-1000-7000-8000-000000000004',
    operation: 'READ_WORKLOAD_OBJECT',
    resource: {
      kind: 'OBJECT_VERSION',
      objectClass: 'WORKLOAD_OBJECTS',
      bucket: 'aeostudio-staging-artifacts',
      key: 'tenants/018f3b76-1000-7000-8000-000000000003/workspaces/018f3b76-1000-7000-8000-000000000004/artifacts/object.json',
      versionId: 'version-read-1',
      checksumSha256,
      contentType: 'application/octet-stream',
      byteLength,
    },
    expiresAt: '2026-07-23T17:40:00.000Z',
  };
}

function workloadRecoveryHeadGrant(
  expectedByteLength: number,
  expectedChecksumSha256: string,
): UnknownRecord {
  return {
    capabilityId: '018f3b76-1000-7000-8000-000000000013',
    authorityKind: 'WORKLOAD_WRITE_INTENT',
    authorityReference: '018f3b76-1000-7000-8000-000000000014',
    scopeKind: 'WORKSPACE',
    tenantId: '018f3b76-1000-7000-8000-000000000003',
    workspaceId: '018f3b76-1000-7000-8000-000000000004',
    operation: 'HEAD_WORKLOAD_OBJECT',
    resource: {
      kind: 'WORKLOAD_OBJECT_WRITE_RECOVERY_HEAD',
      objectClass: 'WORKLOAD_OBJECTS',
      bucket: 'aeostudio-staging-artifacts',
      key: 'tenants/018f3b76-1000-7000-8000-000000000003/workspaces/018f3b76-1000-7000-8000-000000000004/artifacts/object.json',
      expectedChecksumSha256,
      expectedContentType: 'application/json',
      expectedByteLength,
      lockedUntil: null,
      sealedAt: null,
    },
    expiresAt: '2026-07-23T17:40:00.000Z',
  };
}

function auditPutGrantWithWrongBucket(byteLength: number, checksumSha256: string): UnknownRecord {
  return {
    capabilityId: '018f3b76-1000-7000-8000-000000000021',
    authorityKind: 'PRIVACY_WRITE_INTENT',
    authorityReference: '018f3b76-1000-7000-8000-000000000022',
    scopeKind: 'TENANT',
    tenantId: '018f3b76-1000-7000-8000-000000000003',
    workspaceId: null,
    operation: 'PUT_PRIVACY_OBJECT',
    resource: {
      kind: 'PRIVACY_OBJECT_PUT',
      objectClass: 'AUDIT_EVIDENCE',
      bucket: 'aeostudio-staging-artifacts',
      key: 'tenants/018f3b76-1000-7000-8000-000000000003/audit-digests/digest.json',
      checksumSha256,
      contentType: 'application/json',
      byteLength,
      sealedAt: '2026-07-23T00:00:00.000Z',
      lockedUntil: '2027-07-23T00:00:00.000Z',
    },
    expiresAt: '2026-07-23T17:40:00.000Z',
  };
}

function auditPutGrant(byteLength: number, checksumSha256: string): UnknownRecord {
  const grant = auditPutGrantWithWrongBucket(byteLength, checksumSha256);
  const resource = grant.resource as UnknownRecord;
  return {
    ...grant,
    resource: {
      ...resource,
      bucket: 'aeostudio-staging-audit-evidence',
    },
  };
}

function secretReadGrant(secretArn: string): UnknownRecord {
  return {
    capabilityId: '018f3b76-1000-7000-8000-000000000031',
    authorityKind: 'ACTIVE_PUBLICATION_JOB',
    authorityReference: '018f3b76-1000-7000-8000-000000000032',
    scopeKind: 'WORKSPACE',
    tenantId: '018f3b76-1000-7000-8000-000000000003',
    workspaceId: '018f3b76-1000-7000-8000-000000000004',
    operation: 'READ_CONNECTOR_SECRET',
    resource: {
      kind: 'CONNECTOR_SECRET',
      secretArn,
    },
    expiresAt: '2026-07-23T17:40:00.000Z',
  };
}

function secretDescriptionGrant(secretArn: string): UnknownRecord {
  return {
    ...secretReadGrant(secretArn),
    authorityKind: 'CONNECTOR_DELETION_INTENT',
    authorityReference: '018f3b76-1000-7000-8000-000000000042',
    operation: 'DESCRIBE_CONNECTOR_SECRET',
  };
}

function secretUnreadableVerificationGrant(secretArn: string): UnknownRecord {
  return {
    capabilityId: '018f3b76-1000-7000-8000-000000000041',
    authorityKind: 'CONNECTOR_DELETION_INTENT',
    authorityReference: '018f3b76-1000-7000-8000-000000000042',
    scopeKind: 'WORKSPACE',
    tenantId: '018f3b76-1000-7000-8000-000000000003',
    workspaceId: '018f3b76-1000-7000-8000-000000000004',
    operation: 'VERIFY_CONNECTOR_SECRET_UNREADABLE',
    resource: {
      kind: 'CONNECTOR_SECRET_UNREADABLE_VERIFICATION',
      resultKind: 'BOOLEAN_ONLY',
      secretArn,
    },
    expiresAt: '2026-07-23T17:40:00.000Z',
  };
}

function singlePassBody(
  chunks: readonly Uint8Array[],
  onPull: () => void = () => undefined,
): AsyncIterable<Uint8Array> {
  let consumed = false;
  return {
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      if (consumed) throw new Error('PAYLOAD_READ_MORE_THAN_ONCE');
      consumed = true;
      for (const chunk of chunks) {
        onPull();
        yield chunk;
      }
    },
  };
}

function bodyField(input: UnknownRecord): unknown {
  return input.body;
}

async function consumeBody(value: unknown): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (value === null || typeof value !== 'object' || !(Symbol.asyncIterator in value)) {
    throw new Error('EXPECTED_ASYNC_ITERABLE_BODY');
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of value as AsyncIterable<Uint8Array>) {
    if (!(chunk instanceof Uint8Array)) throw new Error('EXPECTED_BYTE_CHUNK');
    chunks.push(Uint8Array.from(chunk));
    length += chunk.byteLength;
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256Chunks(chunks: readonly Uint8Array[]): string {
  const hash = createHash('sha256');
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest('hex');
}

function serializable(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry instanceof Uint8Array) return `<Uint8Array:${String(entry.byteLength)}>`;
    if (entry !== null && typeof entry === 'object' && Symbol.asyncIterator in entry) {
      return '<AsyncIterable>';
    }
    return entry;
  });
}

function findAsyncBody(value: unknown): AsyncIterable<Uint8Array> | null {
  if (value !== null && typeof value === 'object' && Symbol.asyncIterator in value) {
    return value as AsyncIterable<Uint8Array>;
  }
  if (value === null || typeof value !== 'object') return null;
  for (const entry of Object.values(value)) {
    const found = findAsyncBody(entry);
    if (found !== null) return found;
  }
  return null;
}
