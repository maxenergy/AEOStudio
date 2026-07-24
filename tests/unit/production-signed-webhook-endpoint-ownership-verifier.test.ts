import * as PublicationRuntime from '@aeostudio/adapters/publication';
import type { SignedWebhookEndpointOwnershipVerifier } from '@aeostudio/application/channels-publishing';
import { describe, expect, test, vi } from 'vitest';

type VerifierConstructor = new (input: {
  resolver: { resolve(hostname: string): Promise<string[]> };
  transport: {
    post(input: {
      url: string;
      address: string;
      headers: Record<string, string>;
      body: Uint8Array;
      timeoutMs: number;
      maxResponseBytes: number;
    }): Promise<{
      status: number;
      headers: Record<string, string>;
      body: Uint8Array;
      location: string | null;
      connectedAddress: string;
    }>;
  };
  timeoutMs?: number;
}) => SignedWebhookEndpointOwnershipVerifier;

interface OwnershipProofRequest {
  url: string;
  address: string;
  headers: Record<string, string>;
  body: Uint8Array;
  timeoutMs: number;
  maxResponseBytes: number;
}

describe('production signed-webhook endpoint ownership verifier', () => {
  test('marks ownership verified only after an exact HTTPS challenge response', async () => {
    const Verifier = (
      PublicationRuntime as unknown as {
        HttpsSignedWebhookEndpointOwnershipVerifier?: VerifierConstructor;
      }
    ).HttpsSignedWebhookEndpointOwnershipVerifier;
    expect(Verifier, 'expected production endpoint ownership verifier').toBeTypeOf('function');
    if (Verifier === undefined) throw new Error('ENDPOINT_OWNERSHIP_VERIFIER_REQUIRED');
    const transport = {
      post: vi.fn(
        (
          input: OwnershipProofRequest,
        ): Promise<{
          status: number;
          headers: Record<string, string>;
          body: Uint8Array;
          location: null;
          connectedAddress: string;
        }> => {
          const request = JSON.parse(new TextDecoder().decode(input.body)) as {
            verificationId: string;
            purpose: 'DELIVERY' | 'RECEIPT' | 'DELIVERY_AND_RECEIPT';
            exactUrl: string;
            challenge: string;
          };
          return Promise.resolve({
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: new TextEncoder().encode(
              JSON.stringify({
                schemaVersion: 'aeostudio.signed-webhook-endpoint-challenge-response.v1',
                verificationId: request.verificationId,
                purpose: request.purpose,
                exactUrl: request.exactUrl,
                challenge: request.challenge,
              }),
            ),
            location: null,
            connectedAddress: '93.184.216.34',
          });
        },
      ),
    };
    const verifier = new Verifier({
      resolver: { resolve: () => Promise.resolve(['93.184.216.34']) },
      transport,
    });
    const input = {
      verificationId: '00000000-0000-7000-8000-000000009001',
      purpose: 'DELIVERY' as const,
      exactUrl: 'https://receiver.example.test/hooks/aeostudio',
      challenge: 'challenge_token_that_is_long_enough_000000000001',
    };

    await expect(verifier.verifyOwnership(input)).resolves.toEqual({ outcome: 'VERIFIED' });
    const request = transport.post.mock.calls[0]?.[0];
    expect(request?.url).toBe(input.exactUrl);
    expect(request?.address).toBe('93.184.216.34');
    expect(request?.headers['content-type']).toBe('application/json');
  });

  test('rejects a proof bound to another same-origin path and never connects to a private endpoint', async () => {
    const Verifier = (
      PublicationRuntime as unknown as {
        HttpsSignedWebhookEndpointOwnershipVerifier?: VerifierConstructor;
      }
    ).HttpsSignedWebhookEndpointOwnershipVerifier;
    if (Verifier === undefined) throw new Error('ENDPOINT_OWNERSHIP_VERIFIER_REQUIRED');
    const mismatchTransport = {
      post: vi.fn(() =>
        Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: new TextEncoder().encode(
            JSON.stringify({
              schemaVersion: 'aeostudio.signed-webhook-endpoint-challenge-response.v1',
              verificationId: '00000000-0000-7000-8000-000000009001',
              purpose: 'DELIVERY',
              exactUrl: 'https://receiver.example.test/hooks/aeostudio',
              challenge: 'challenge_token_that_is_long_enough_000000000001',
            }),
          ),
          location: null,
          connectedAddress: '93.184.216.34',
        }),
      ),
    };
    const input = {
      verificationId: '00000000-0000-7000-8000-000000009001',
      purpose: 'RECEIPT' as const,
      exactUrl: 'https://receiver.example.test/hooks/aeostudio/receipts',
      challenge: 'challenge_token_that_is_long_enough_000000000001',
    };

    await expect(
      new Verifier({
        resolver: { resolve: () => Promise.resolve(['93.184.216.34']) },
        transport: mismatchTransport,
      }).verifyOwnership(input),
    ).resolves.toEqual({ outcome: 'FAILED', reason: 'CHALLENGE_MISMATCH' });

    const blockedTransport = { post: vi.fn() };
    await expect(
      new Verifier({
        resolver: { resolve: () => Promise.resolve(['127.0.0.1']) },
        transport: blockedTransport,
      }).verifyOwnership(input),
    ).resolves.toEqual({ outcome: 'FAILED', reason: 'SSRF_BLOCKED' });
    expect(blockedTransport.post).not.toHaveBeenCalled();
  });
});
