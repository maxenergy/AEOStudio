import { describe, expect, it } from 'vitest';

import {
  BingWebmasterAdapter,
  createProductionMeasurementAdapterRegistry,
  GoogleSearchConsoleAdapter,
} from '@aeostudio/adapters/measurement';
import type { MeasurementSurfaceExecutionCommand } from '@aeostudio/application/measurement';

function createCommand(overrides: Partial<MeasurementSurfaceExecutionCommand> = {}) {
  return {
    measurementRunId: 'run-1',
    tenantId: 'tenant-1',
    workspaceId: 'workspace-1',
    idempotencyKey: 'key-1',
    signal: new AbortController().signal,
    scenario: {
      id: 'scenario-1',
      version: 1,
      contentHash: 'hash-1',
      promptRevisionId: 'revision-1',
      providerKey: 'google',
      surfaceKey: 'search-console',
      model: 'gsc',
      modelVersion: 'v1',
      account: 'test-account',
      acquisitionClass: 'SEARCH_DATA_API' as const,
      acquisitionMethod: 'GOOGLE_SEARCH_CONSOLE_API',
      registryStatus: 'AVAILABLE' as const,
      manualImport: null,
      freshSession: false,
      searchEnabled: false,
      parameters: {},
      repetitions: 1,
      scopes: [{ market: 'US', locale: 'en', region: 'us' }],
    },
    prompt: { id: 'prompt-1', ordinal: 1, text: 'Test prompt' },
    scope: { market: 'US', locale: 'en', region: 'us' },
    repetition: 1,
    ...overrides,
  };
}

describe('C04 Production Measurement Adapters', () => {
  describe('GoogleSearchConsoleAdapter', () => {
    it('fails closed when transport is not configured', async () => {
      const adapter = new GoogleSearchConsoleAdapter();
      const result = await adapter.executeScenario(createCommand());

      expect(result.status).toBe('NOT_CHECKED');
      expect(result.rawEvidence.error?.code).toBe('GSC_TRANSPORT_NOT_CONFIGURED');
    });

    it('fails closed when credential resolver is not configured', async () => {
      const adapter = new GoogleSearchConsoleAdapter({
        transport: {
          querySearchAnalytics: () => Promise.resolve({ rows: [], rowCount: 0 }),
        },
      });
      const result = await adapter.executeScenario(createCommand());

      expect(result.status).toBe('NOT_CHECKED');
      expect(result.rawEvidence.error?.code).toBe('GSC_CREDENTIAL_RESOLVER_NOT_CONFIGURED');
    });

    it('fails closed when authorization is not available', async () => {
      const adapter = new GoogleSearchConsoleAdapter({
        transport: {
          querySearchAnalytics: () => Promise.resolve({ rows: [], rowCount: 0 }),
        },
        credentialResolver: () => Promise.resolve(null),
      });
      const result = await adapter.executeScenario(createCommand());

      expect(result.status).toBe('NOT_CHECKED');
      expect(result.rawEvidence.error?.code).toBe('GSC_AUTHORIZATION_NOT_AVAILABLE');
    });

    it('returns PASS when API returns data', async () => {
      const adapter = new GoogleSearchConsoleAdapter({
        transport: {
          querySearchAnalytics: () => Promise.resolve({ rows: [{ query: 'test' }], rowCount: 1 }),
        },
        credentialResolver: () =>
          Promise.resolve({ accessToken: 'token', siteUrl: 'https://example.com' }),
      });
      const result = await adapter.executeScenario(createCommand());

      expect(result.status).toBe('PASS');
      expect(result.observation.mention).toBe(true);
      expect(result.providerKey).toBe('google');
      expect(result.surfaceKey).toBe('search-console');
    });

    it('returns ERROR when API fails', async () => {
      const adapter = new GoogleSearchConsoleAdapter({
        transport: {
          querySearchAnalytics: () => Promise.reject(new Error('API_ERROR')),
        },
        credentialResolver: () =>
          Promise.resolve({ accessToken: 'token', siteUrl: 'https://example.com' }),
      });
      const result = await adapter.executeScenario(createCommand());

      expect(result.status).toBe('ERROR');
      expect(result.rawEvidence.error?.code).toBe('GSC_API_ERROR');
    });
  });

  describe('BingWebmasterAdapter', () => {
    it('fails closed when transport is not configured', async () => {
      const adapter = new BingWebmasterAdapter();
      const result = await adapter.executeScenario(createCommand());

      expect(result.status).toBe('NOT_CHECKED');
      expect(result.rawEvidence.error?.code).toBe('BING_TRANSPORT_NOT_CONFIGURED');
    });

    it('fails closed when authorization is not available', async () => {
      const adapter = new BingWebmasterAdapter({
        transport: {
          querySearchAnalytics: () => Promise.resolve({ rows: [], rowCount: 0 }),
        },
        credentialResolver: () => Promise.resolve(null),
      });
      const result = await adapter.executeScenario(createCommand());

      expect(result.status).toBe('NOT_CHECKED');
      expect(result.rawEvidence.error?.code).toBe('BING_AUTHORIZATION_NOT_AVAILABLE');
    });

    it('returns PASS when API returns data', async () => {
      const adapter = new BingWebmasterAdapter({
        transport: {
          querySearchAnalytics: () => Promise.resolve({ rows: [{ query: 'test' }], rowCount: 1 }),
        },
        credentialResolver: () =>
          Promise.resolve({ apiKey: 'key', siteUrl: 'https://example.com' }),
      });
      const result = await adapter.executeScenario(createCommand());

      expect(result.status).toBe('PASS');
      expect(result.providerKey).toBe('bing');
      expect(result.surfaceKey).toBe('webmaster-tools');
    });
  });

  describe('createProductionMeasurementAdapterRegistry', () => {
    it('resolves GSC adapter by provider/surface', () => {
      const registry = createProductionMeasurementAdapterRegistry();
      const adapter = registry.resolve('google', 'search-console', '1.0.0');

      expect(adapter).not.toBeNull();
      expect(adapter?.adapterKey).toBe('google-search-console');
    });

    it('resolves Bing adapter by provider/surface', () => {
      const registry = createProductionMeasurementAdapterRegistry();
      const adapter = registry.resolve('bing', 'webmaster-tools', '1.0.0');

      expect(adapter).not.toBeNull();
      expect(adapter?.adapterKey).toBe('bing-webmaster');
    });

    it('returns null for unknown provider/surface', () => {
      const registry = createProductionMeasurementAdapterRegistry();
      const adapter = registry.resolve('unknown', 'unknown', '1.0.0');

      expect(adapter).toBeNull();
    });

    it('returns null for wrong adapter version', () => {
      const registry = createProductionMeasurementAdapterRegistry();
      const adapter = registry.resolve('google', 'search-console', '9.9.9');

      expect(adapter).toBeNull();
    });

    it('does not include fake adapters', () => {
      const registry = createProductionMeasurementAdapterRegistry();
      const fakeAdapter = registry.resolve('fake', 'fake-surface', '1.0.0');

      expect(fakeAdapter).toBeNull();
    });
  });
});
