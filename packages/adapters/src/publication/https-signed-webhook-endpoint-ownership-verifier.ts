import type { SignedWebhookEndpointOwnershipVerifier } from '@aeostudio/application/channels-publishing';

import type {
  SignedWebhookDnsResolver,
  SignedWebhookHttpTransport,
} from './signed-webhook-http-client.js';
import { SafeSignedWebhookHttpClient } from './signed-webhook-http-client.js';

const REQUEST_SCHEMA = 'aeostudio.signed-webhook-endpoint-challenge.v1';
const RESPONSE_SCHEMA = 'aeostudio.signed-webhook-endpoint-challenge-response.v1';

export class HttpsSignedWebhookEndpointOwnershipVerifier implements SignedWebhookEndpointOwnershipVerifier {
  private readonly client: SafeSignedWebhookHttpClient;
  private readonly timeoutMs: number;

  constructor(input: {
    resolver: SignedWebhookDnsResolver;
    transport: SignedWebhookHttpTransport;
    timeoutMs?: number;
  }) {
    this.client = new SafeSignedWebhookHttpClient(input.resolver, input.transport);
    this.timeoutMs = input.timeoutMs ?? 5_000;
  }

  async verifyOwnership(
    input: Parameters<SignedWebhookEndpointOwnershipVerifier['verifyOwnership']>[0],
  ): ReturnType<SignedWebhookEndpointOwnershipVerifier['verifyOwnership']> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        input.verificationId,
      ) ||
      !/^[A-Za-z0-9_-]{32,128}$/u.test(input.challenge)
    ) {
      return { outcome: 'FAILED', reason: 'INVALID_RESPONSE' };
    }
    const body = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: REQUEST_SCHEMA,
        verificationId: input.verificationId,
        purpose: input.purpose,
        exactUrl: input.exactUrl,
        challenge: input.challenge,
      }),
    );
    const posted = await this.client.post({
      url: input.exactUrl,
      verifiedUrl: input.exactUrl,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'AEOStudio-Endpoint-Verification/1.0',
      },
      body,
      timeoutMs: this.timeoutMs,
      maxResponseBytes: 4_096,
    });
    if (posted.outcome !== 'SUCCEEDED') {
      return {
        outcome: 'FAILED',
        reason: posted.outcome === 'SSRF_BLOCKED' ? 'SSRF_BLOCKED' : 'TRANSPORT_FAILED',
      };
    }
    const contentType = posted.response.headers['content-type']?.split(';', 1)[0]?.trim();
    if (posted.response.status !== 200 || contentType !== 'application/json') {
      return { outcome: 'FAILED', reason: 'INVALID_RESPONSE' };
    }
    let response: unknown;
    try {
      response = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(posted.response.body),
      ) as unknown;
    } catch {
      return { outcome: 'FAILED', reason: 'INVALID_RESPONSE' };
    }
    if (
      !isRecord(response) ||
      Object.keys(response).sort().join('\u0000') !==
        ['challenge', 'exactUrl', 'purpose', 'schemaVersion', 'verificationId'].join('\u0000') ||
      response.schemaVersion !== RESPONSE_SCHEMA ||
      response.verificationId !== input.verificationId ||
      response.purpose !== input.purpose ||
      response.exactUrl !== input.exactUrl ||
      response.challenge !== input.challenge
    ) {
      return { outcome: 'FAILED', reason: 'CHALLENGE_MISMATCH' };
    }
    return { outcome: 'VERIFIED' };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
