/**
 * Production Measurement Surface Adapter Registry.
 *
 * Provides real provider adapters (GSC, Bing) that fail closed when
 * credentials are unavailable, plus reviewed manual import fallback.
 */

import type {
  MeasurementSurfaceAdapter,
  MeasurementSurfaceAdapterDescriptor,
  MeasurementSurfaceAdapterRegistry,
  MeasurementSurfaceExecutionCommand,
  MeasurementSurfaceExecutionResult,
} from '@aeostudio/application/measurement';

// ============================================================================
// Adapter Descriptors
// ============================================================================

export const GSC_ADAPTER_DESCRIPTOR: MeasurementSurfaceAdapterDescriptor = {
  adapterKey: 'google-search-console',
  adapterVersion: '1.0.0',
  providerKey: 'google',
  surfaceKey: 'search-console',
  surfaceKind: 'SEARCH_DATA',
  acquisitionClass: 'SEARCH_DATA_API',
  acquisitionMethod: 'GOOGLE_SEARCH_CONSOLE_API',
  termsVersion: 'google-api-terms-2026-07',
  processingRegion: 'Google-controlled; tenant authorization required.',
  storageRegion: 'Tenant database; raw response reference only.',
  retentionPolicy: 'Immutable raw response reference retained per tenant policy.',
  trainingPolicy: 'No training is permitted.',
  subprocessors: ['Google Cloud'],
  requiresAuthorization: true,
};

export const BING_ADAPTER_DESCRIPTOR: MeasurementSurfaceAdapterDescriptor = {
  adapterKey: 'bing-webmaster',
  adapterVersion: '1.0.0',
  providerKey: 'bing',
  surfaceKey: 'webmaster-tools',
  surfaceKind: 'SEARCH_DATA',
  acquisitionClass: 'SEARCH_DATA_API',
  acquisitionMethod: 'BING_WEBMASTER_API',
  termsVersion: 'bing-api-terms-2026-07',
  processingRegion: 'Microsoft-controlled; tenant authorization required.',
  storageRegion: 'Tenant database; raw response reference only.',
  retentionPolicy: 'Immutable raw response reference retained per tenant policy.',
  trainingPolicy: 'No training is permitted.',
  subprocessors: ['Microsoft Azure'],
  requiresAuthorization: true,
};

// ============================================================================
// Shared Types
// ============================================================================

interface ResultBase {
  providerKey: string;
  surfaceKey: string;
  acquisitionMethod: string;
  adapterVersion: string;
  methodVersion: string;
  observedAt: string;
}

function notCheckedResult(base: ResultBase, reason: string): MeasurementSurfaceExecutionResult {
  return {
    ...base,
    status: 'NOT_CHECKED',
    observation: { mention: null, citation: null, accuracy: null, coverage: null },
    cost: { amount: '0.000000', currency: 'USD' },
    rawEvidence: {
      responseText: null,
      citations: [],
      error: { code: reason, message: reason },
    },
  };
}

function getDateRange(): { startDate: string; endDate: string } {
  const end = new Date();
  end.setDate(end.getDate() - 2); // Data APIs have ~2-day delay
  const start = new Date(end);
  start.setDate(start.getDate() - 28); // 28-day window
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

// ============================================================================
// Google Search Console Adapter
// ============================================================================

export interface GoogleSearchConsoleTransport {
  querySearchAnalytics(input: {
    siteUrl: string;
    startDate: string;
    endDate: string;
    dimensions: string[];
    rowLimit: number;
    accessToken: string;
    signal: AbortSignal;
  }): Promise<{ rows: unknown[]; rowCount: number }>;
}

export interface GoogleSearchConsoleAdapterOptions {
  transport?: GoogleSearchConsoleTransport;
  credentialResolver?: (input: {
    tenantId: string;
    workspaceId: string;
  }) => Promise<{ accessToken: string; siteUrl: string } | null>;
}

/**
 * Production Google Search Console adapter.
 * Fails closed (NOT_CHECKED) when credentials are unavailable.
 */
export class GoogleSearchConsoleAdapter implements MeasurementSurfaceAdapter {
  readonly adapterKey = GSC_ADAPTER_DESCRIPTOR.adapterKey;
  readonly adapterVersion = GSC_ADAPTER_DESCRIPTOR.adapterVersion;

  private readonly transport: GoogleSearchConsoleTransport | null;
  private readonly credentialResolver: GoogleSearchConsoleAdapterOptions['credentialResolver'];

  constructor(options: GoogleSearchConsoleAdapterOptions = {}) {
    this.transport = options.transport ?? null;
    this.credentialResolver = options.credentialResolver;
  }

  describe(): MeasurementSurfaceAdapterDescriptor {
    return structuredClone(GSC_ADAPTER_DESCRIPTOR);
  }

  async executeScenario(
    command: MeasurementSurfaceExecutionCommand,
  ): Promise<MeasurementSurfaceExecutionResult> {
    const base: ResultBase = {
      providerKey: GSC_ADAPTER_DESCRIPTOR.providerKey,
      surfaceKey: GSC_ADAPTER_DESCRIPTOR.surfaceKey,
      acquisitionMethod: GSC_ADAPTER_DESCRIPTOR.acquisitionMethod,
      adapterVersion: this.adapterVersion,
      methodVersion: 'gsc-search-analytics-v1',
      observedAt: new Date().toISOString(),
    };

    if (this.transport === null) {
      return notCheckedResult(base, 'GSC_TRANSPORT_NOT_CONFIGURED');
    }
    if (this.credentialResolver === undefined) {
      return notCheckedResult(base, 'GSC_CREDENTIAL_RESOLVER_NOT_CONFIGURED');
    }

    const credentials = await this.credentialResolver({
      tenantId: command.tenantId,
      workspaceId: command.workspaceId,
    });
    if (credentials === null) {
      return notCheckedResult(base, 'GSC_AUTHORIZATION_NOT_AVAILABLE');
    }

    try {
      const range = getDateRange();
      const result = await this.transport.querySearchAnalytics({
        siteUrl: credentials.siteUrl,
        startDate: range.startDate,
        endDate: range.endDate,
        dimensions: ['query', 'page', 'country', 'device'],
        rowLimit: 1000,
        accessToken: credentials.accessToken,
        signal: command.signal,
      });

      return {
        ...base,
        status: 'PASS',
        observation: {
          mention: result.rowCount > 0,
          citation: null,
          accuracy: 'NOT_APPLICABLE',
          coverage: result.rowCount > 0,
        },
        cost: { amount: '0.000000', currency: 'USD' },
        rawEvidence: {
          responseText: `GSC query returned ${result.rowCount} rows`,
          citations: [],
          error: null,
        },
      };
    } catch (error: unknown) {
      return {
        ...base,
        status: 'ERROR',
        observation: { mention: null, citation: null, accuracy: null, coverage: null },
        cost: { amount: '0.000000', currency: 'USD' },
        rawEvidence: {
          responseText: null,
          citations: [],
          error: {
            code: command.signal.aborted ? 'REQUEST_ABORTED' : 'GSC_API_ERROR',
            message: error instanceof Error ? error.message : 'UNKNOWN',
          },
        },
      };
    }
  }
}

// ============================================================================
// Bing Webmaster Adapter
// ============================================================================

export interface BingWebmasterTransport {
  querySearchAnalytics(input: {
    siteUrl: string;
    startDate: string;
    endDate: string;
    dimensions: string[];
    rowLimit: number;
    apiKey: string;
    signal: AbortSignal;
  }): Promise<{ rows: unknown[]; rowCount: number }>;
}

export interface BingWebmasterAdapterOptions {
  transport?: BingWebmasterTransport;
  credentialResolver?: (input: {
    tenantId: string;
    workspaceId: string;
  }) => Promise<{ apiKey: string; siteUrl: string } | null>;
}

/**
 * Production Bing Webmaster adapter.
 * Fails closed (NOT_CHECKED) when credentials are unavailable.
 */
export class BingWebmasterAdapter implements MeasurementSurfaceAdapter {
  readonly adapterKey = BING_ADAPTER_DESCRIPTOR.adapterKey;
  readonly adapterVersion = BING_ADAPTER_DESCRIPTOR.adapterVersion;

  private readonly transport: BingWebmasterTransport | null;
  private readonly credentialResolver: BingWebmasterAdapterOptions['credentialResolver'];

  constructor(options: BingWebmasterAdapterOptions = {}) {
    this.transport = options.transport ?? null;
    this.credentialResolver = options.credentialResolver;
  }

  describe(): MeasurementSurfaceAdapterDescriptor {
    return structuredClone(BING_ADAPTER_DESCRIPTOR);
  }

  async executeScenario(
    command: MeasurementSurfaceExecutionCommand,
  ): Promise<MeasurementSurfaceExecutionResult> {
    const base: ResultBase = {
      providerKey: BING_ADAPTER_DESCRIPTOR.providerKey,
      surfaceKey: BING_ADAPTER_DESCRIPTOR.surfaceKey,
      acquisitionMethod: BING_ADAPTER_DESCRIPTOR.acquisitionMethod,
      adapterVersion: this.adapterVersion,
      methodVersion: 'bing-search-analytics-v1',
      observedAt: new Date().toISOString(),
    };

    if (this.transport === null) {
      return notCheckedResult(base, 'BING_TRANSPORT_NOT_CONFIGURED');
    }
    if (this.credentialResolver === undefined) {
      return notCheckedResult(base, 'BING_CREDENTIAL_RESOLVER_NOT_CONFIGURED');
    }

    const credentials = await this.credentialResolver({
      tenantId: command.tenantId,
      workspaceId: command.workspaceId,
    });
    if (credentials === null) {
      return notCheckedResult(base, 'BING_AUTHORIZATION_NOT_AVAILABLE');
    }

    try {
      const range = getDateRange();
      const result = await this.transport.querySearchAnalytics({
        siteUrl: credentials.siteUrl,
        startDate: range.startDate,
        endDate: range.endDate,
        dimensions: ['query', 'page', 'country', 'device'],
        rowLimit: 1000,
        apiKey: credentials.apiKey,
        signal: command.signal,
      });

      return {
        ...base,
        status: 'PASS',
        observation: {
          mention: result.rowCount > 0,
          citation: null,
          accuracy: 'NOT_APPLICABLE',
          coverage: result.rowCount > 0,
        },
        cost: { amount: '0.000000', currency: 'USD' },
        rawEvidence: {
          responseText: `Bing query returned ${result.rowCount} rows`,
          citations: [],
          error: null,
        },
      };
    } catch (error: unknown) {
      return {
        ...base,
        status: 'ERROR',
        observation: { mention: null, citation: null, accuracy: null, coverage: null },
        cost: { amount: '0.000000', currency: 'USD' },
        rawEvidence: {
          responseText: null,
          citations: [],
          error: {
            code: command.signal.aborted ? 'REQUEST_ABORTED' : 'BING_API_ERROR',
            message: error instanceof Error ? error.message : 'UNKNOWN',
          },
        },
      };
    }
  }
}

// ============================================================================
// Production Adapter Registry
// ============================================================================

export interface ProductionMeasurementAdapterRegistryOptions {
  gsc?: GoogleSearchConsoleAdapterOptions;
  bing?: BingWebmasterAdapterOptions;
  additional?: MeasurementSurfaceAdapter[];
}

/**
 * Create the production measurement adapter registry.
 * Registers GSC and Bing adapters that fail closed without credentials.
 */
export function createProductionMeasurementAdapterRegistry(
  options: ProductionMeasurementAdapterRegistryOptions = {},
): MeasurementSurfaceAdapterRegistry {
  const adapters = new Map<string, MeasurementSurfaceAdapter>();

  const gscAdapter = new GoogleSearchConsoleAdapter(options.gsc);
  adapters.set(`${gscAdapter.adapterKey}\u0000${gscAdapter.adapterVersion}`, gscAdapter);

  const bingAdapter = new BingWebmasterAdapter(options.bing);
  adapters.set(`${bingAdapter.adapterKey}\u0000${bingAdapter.adapterVersion}`, bingAdapter);

  for (const adapter of options.additional ?? []) {
    adapters.set(`${adapter.adapterKey}\u0000${adapter.adapterVersion}`, adapter);
  }

  return {
    resolve(providerKey, surfaceKey, adapterVersion) {
      const adapterKey = resolveAdapterKey(providerKey, surfaceKey);
      if (adapterKey === null) return null;
      return adapters.get(`${adapterKey}\u0000${adapterVersion}`) ?? null;
    },
  };
}

function resolveAdapterKey(providerKey: string, surfaceKey: string): string | null {
  if (providerKey === 'google' && surfaceKey === 'search-console') {
    return 'google-search-console';
  }
  if (providerKey === 'bing' && surfaceKey === 'webmaster-tools') {
    return 'bing-webmaster';
  }
  return null;
}
