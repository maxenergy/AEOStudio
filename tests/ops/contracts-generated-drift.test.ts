import { execFile } from 'node:child_process';
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';

import * as contracts from '@aeostudio/contracts';
import { describe, expect, test } from 'vitest';

const root = process.cwd();
const execFileAsync = promisify(execFile);
const generatedFiles = [
  'packages/contracts/generated/json-schema-2020-12.json',
  'packages/contracts/generated/openapi-3.1.json',
  'apps/web/src/generated/openapi-types.ts',
];

interface OpenApiDocument {
  openapi?: unknown;
  jsonSchemaDialect?: unknown;
  paths?: Record<string, Record<string, unknown>>;
  components?: {
    schemas?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
}

interface JsonSchemaBundle {
  $schema?: unknown;
  $defs?: Record<string, unknown>;
}

describe('generated HTTP and schema contract drift gate', () => {
  test('checks committed OpenAPI 3.1, JSON Schema 2020-12 and generated Web types', async () => {
    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.['contracts:generate'] ?? '').toContain(
      'scripts/contracts/generate-contracts.mjs',
    );
    expect(packageJson.scripts?.['contracts:check'] ?? '').toContain(
      'scripts/contracts/generate-contracts.mjs --check',
    );
    expect(packageJson.scripts?.['contracts:check'] ?? '').not.toMatch(
      /^pnpm --filter @aeostudio\/contracts typecheck$/u,
    );

    const openApi = JSON.parse(
      await readFile(join(root, 'packages/contracts/generated/openapi-3.1.json'), 'utf8'),
    ) as OpenApiDocument;
    expect(openApi.openapi).toBe('3.1.0');
    expect(openApi.jsonSchemaDialect).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(Object.keys(openApi.components?.schemas ?? {}).length).toBeGreaterThanOrEqual(150);

    const expected = await controllerOperations();
    const documentedOperations = new Set<string>();
    const documentedRequestBodies = new Set<string>();
    const documented = new Map<
      string,
      {
        requestBody?: unknown;
        responses?: Record<string, unknown>;
        security?: unknown;
        'x-aeostudio-success-response-contract'?: unknown;
      }
    >();
    const operationIds: string[] = [];
    for (const [path, item] of Object.entries(openApi.paths ?? {})) {
      for (const [method, operation] of Object.entries(item)) {
        if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
          const operationKey = `${method.toUpperCase()} ${path}`;
          const typedOperation = operation as {
            operationId?: string;
            requestBody?: unknown;
            responses?: Record<string, unknown>;
            security?: unknown;
            'x-aeostudio-success-response-contract'?: unknown;
          };
          documentedOperations.add(operationKey);
          documented.set(operationKey, typedOperation);
          if (typedOperation.requestBody !== undefined) {
            documentedRequestBodies.add(operationKey);
          }
          operationIds.push(typedOperation.operationId ?? 'MISSING_OPERATION_ID');
        }
      }
    }
    expect(
      [...expected.operations].filter((operation) => !documentedOperations.has(operation)),
      'every Nest HTTP route must be present in the generated OpenAPI document',
    ).toEqual([]);
    expect(
      [...expected.bodyOperations].filter((operation) => !documentedRequestBodies.has(operation)),
      'every Nest @Body route must reference its exported Zod request schema',
    ).toEqual([]);
    expect(expected.bodyOperations.size).toBeGreaterThanOrEqual(40);
    expect(new Set(operationIds).size).toBe(operationIds.length);
    expect(operationIds).not.toContain('MISSING_OPERATION_ID');
    expect(openApi.components?.securitySchemes).toMatchObject({
      deletionReceiptCookie: {
        type: 'apiKey',
        in: 'cookie',
        name: '__Host-aeo_deletion_receipt',
      },
      sessionCookie: { type: 'apiKey', in: 'cookie', name: '__Host-aeo_session' },
    });
    expect(documented.get('GET /health')?.security).toEqual([]);
    expect(documented.get('GET /api/v1/auth/session')?.security).toEqual([{ sessionCookie: [] }]);
    expect(documented.get('GET /api/v1/privacy/deletion-receipts/current')?.security).toEqual([
      { deletionReceiptCookie: [] },
    ]);
    const exceptionalSuccessContracts = new Map<string, string>([
      ['GET /__test/oidc/authorize', 'REDIRECT'],
      ['GET /api/v1/auth/login', 'REDIRECT'],
      ['GET /api/v1/auth/callback', 'REDIRECT'],
      ['POST /api/v1/auth/logout', 'NO_CONTENT'],
      [
        'GET /api/v1/tenants/{tenantId}/workspaces/{workspaceId}/privacy/exports/{exportId}/download',
        'BINARY',
      ],
    ]);
    const incorrectSuccessContracts = [...documented.entries()]
      .filter(([operationKey, operation]) => {
        const expectedContract = exceptionalSuccessContracts.get(operationKey) ?? 'ZOD_SCHEMA';
        return operation['x-aeostudio-success-response-contract'] !== expectedContract;
      })
      .map(([operationKey, operation]) => ({
        operationKey,
        actual: operation['x-aeostudio-success-response-contract'],
        expected: exceptionalSuccessContracts.get(operationKey) ?? 'ZOD_SCHEMA',
      }));
    expect(
      incorrectSuccessContracts,
      'every HTTP success response must have an exported Zod schema or an explicit non-JSON contract',
    ).toEqual([]);
    const privacyExportDownload = documented.get(
      'GET /api/v1/tenants/{tenantId}/workspaces/{workspaceId}/privacy/exports/{exportId}/download',
    )?.responses?.['200'];
    expect(
      privacyExportDownload,
      'the downloadable tenant export is a canonical JSON archive and must preserve its explicit media type',
    ).toMatchObject({
      content: {
        'application/json': {
          schema: { type: 'string', format: 'binary' },
        },
      },
    });
    expect(
      (privacyExportDownload as { content?: Record<string, unknown> } | undefined)?.content?.[
        'application/octet-stream'
      ],
    ).toBeUndefined();
    const channelPackageExport = documented.get(
      'GET /api/v1/tenants/{tenantId}/workspaces/{workspaceId}/channel-packages/{packageId}/export',
    )?.responses?.['200'];
    expect(channelPackageExport).toMatchObject({
      content: {
        'application/vnd.aeostudio.channel-package+json': {
          schema: { $ref: '#/components/schemas/ChannelPackageExportSchema' },
        },
      },
    });
    expect(
      (channelPackageExport as { content?: Record<string, unknown> } | undefined)?.content?.[
        'application/json'
      ],
    ).toBeUndefined();
    expect(
      documented.get(
        'GET /api/v1/tenants/{tenantId}/workspaces/{workspaceId}/experiments/{experimentId}',
      )?.['x-aeostudio-success-response-contract'],
      'controller responses parsed through an exported Zod schema are typed',
    ).toBe('ZOD_SCHEMA');
    expect(
      successResponseStatuses(
        documented.get('POST /api/v1/tenants/{tenantId}/workspaces/{workspaceId}/channel-packages'),
      ),
      'idempotent Channel Package creation returns either the existing or newly created resource',
    ).toEqual(['200', '201']);
    expect(
      successResponseStatuses(
        documented.get('POST /api/v1/tenants/{tenantId}/workspaces/{workspaceId}/experiments'),
      ),
      'idempotent Experiment creation returns either the existing or newly created resource',
    ).toEqual(['200', '201']);
    expect(
      successResponseStatuses(
        documented.get('POST /api/v1/tenants/{tenantId}/workspaces/{workspaceId}/publications'),
      ),
      'idempotent Publication requests return an existing command or a newly accepted command',
    ).toEqual(['200', '202']);

    const schemaBundle = JSON.parse(
      await readFile(join(root, 'packages/contracts/generated/json-schema-2020-12.json'), 'utf8'),
    ) as JsonSchemaBundle;
    expect(schemaBundle.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(Object.keys(schemaBundle.$defs ?? {}).length).toBeGreaterThanOrEqual(150);
    const exportedSchemaNames = Object.entries(contracts)
      .filter(([, value]) => isZodSchema(value))
      .map(([name]) => name)
      .sort();
    expect(exportedSchemaNames.length).toBeGreaterThanOrEqual(150);
    expect(
      exportedSchemaNames.filter((name) => schemaBundle.$defs?.[name] === undefined),
      'every exported Zod schema must be in the JSON Schema bundle',
    ).toEqual([]);
    expect(
      exportedSchemaNames.filter((name) => openApi.components?.schemas?.[name] === undefined),
      'every exported Zod schema must be in OpenAPI components',
    ).toEqual([]);
    for (const requiredSchema of [
      'JobSchema',
      'PublicationRemoteStateSchema',
      'ChannelPackageEnvelopeSchema',
      'ArtifactBundleEnvelopeSchema',
      'MeasurementRunEnvelopeSchema',
      'ExperimentEnvelopeSchema',
    ]) {
      expect(schemaBundle.$defs, requiredSchema).toHaveProperty(requiredSchema);
      expect(openApi.components?.schemas, requiredSchema).toHaveProperty(requiredSchema);
    }

    const webTypes = await readFile(join(root, 'apps/web/src/generated/openapi-types.ts'), 'utf8');
    expect(webTypes).toContain('export interface paths');
    expect(webTypes).toContain('AUTO-GENERATED');
    expect(webTypes).toContain('DO NOT EDIT');
  });

  test('documents every controller-declared error status with a Zod problem schema', async () => {
    const openApi = JSON.parse(
      await readFile(join(root, 'packages/contracts/generated/openapi-3.1.json'), 'utf8'),
    ) as OpenApiDocument;
    const documented = new Map<
      string,
      {
        responses?: Record<string, unknown>;
        security?: unknown;
      }
    >();
    for (const [path, pathItem] of Object.entries(openApi.paths ?? {})) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
        documented.set(
          `${method.toUpperCase()} ${path}`,
          operation as {
            responses?: Record<string, unknown>;
            security?: unknown;
          },
        );
      }
    }
    const undocumentedProblemResponses = Object.entries(openApi.paths ?? {}).flatMap(
      ([path, pathItem]) =>
        Object.entries(pathItem).flatMap(([method, operation]) => {
          if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) return [];
          const responses =
            operation !== null && typeof operation === 'object'
              ? ((operation as { responses?: Record<string, unknown> }).responses ?? {})
              : {};
          return Object.entries(responses)
            .filter(([status]) => status === 'default' || /^[45][0-9]{2}$/u.test(status))
            .filter(([, response]) => !hasProblemJsonSchema(response))
            .map(([status]) => `${method.toUpperCase()} ${path} -> ${status}`);
        }),
    );

    expect(
      undocumentedProblemResponses,
      'every controller-declared and unhandled HTTP error status must reference a Zod problem-details schema',
    ).toEqual([]);

    const sessionProtectedOperations = [...documented.entries()].filter(([, operation]) =>
      Array.isArray(operation.security)
        ? operation.security.some(
            (requirement) =>
              requirement !== null &&
              typeof requirement === 'object' &&
              'sessionCookie' in requirement,
          )
        : false,
    );
    expect(
      sessionProtectedOperations
        .filter(([, operation]) => operation.responses?.['401'] === undefined)
        .map(([operationKey]) => operationKey),
      'every session-cookie protected operation must document its authentication rejection',
    ).toEqual([]);
    expect(
      sessionProtectedOperations
        .filter(([operationKey]) => /^(POST|PUT|PATCH|DELETE) /u.test(operationKey))
        .filter(([, operation]) => operation.responses?.['403'] === undefined)
        .map(([operationKey]) => operationKey),
      'every state-changing session-cookie operation must document its CSRF rejection',
    ).toEqual([]);
    const exportOnlyConflict = (
      documented.get('POST /api/v1/tenants/{tenantId}/workspaces/{workspaceId}/publications')
        ?.responses?.['409'] as
        | {
            content?: {
              'application/problem+json'?: {
                schema?: { anyOf?: unknown; oneOf?: unknown };
              };
            };
          }
        | undefined
    )?.content?.['application/problem+json']?.schema;
    expect(
      exportOnlyConflict?.anyOf,
      'a specialized Problem Details schema overlaps the extensible base schema and must use anyOf',
    ).toBeDefined();
    expect(exportOnlyConflict?.oneOf).toBeUndefined();
  });

  test('check mode compares through a temporary directory without rewriting committed artifacts', async () => {
    const before = await Promise.all(
      generatedFiles.map(async (file) => ({
        contents: await readFile(join(root, file), 'utf8'),
        mtimeNs: (await stat(join(root, file), { bigint: true })).mtimeNs,
      })),
    );
    await execFileAsync(
      process.execPath,
      [
        join(root, 'node_modules/typescript/bin/tsc'),
        '-p',
        join(root, 'packages/contracts/tsconfig.build.json'),
      ],
      {
        cwd: root,
        timeout: 30_000,
        windowsHide: true,
      },
    );
    await execFileAsync(
      process.execPath,
      [join(root, 'scripts/contracts/generate-contracts.mjs'), '--check'],
      {
        cwd: root,
        timeout: 30_000,
        windowsHide: true,
      },
    );
    const after = await Promise.all(
      generatedFiles.map(async (file) => ({
        contents: await readFile(join(root, file), 'utf8'),
        mtimeNs: (await stat(join(root, file), { bigint: true })).mtimeNs,
      })),
    );
    expect(after).toEqual(before);
  }, 35_000);

  test('check mode exits non-zero when an isolated committed artifact drifts', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'aeostudio-contract-drift-'));
    try {
      await copyContractFixture(fixtureRoot);
      const driftedFile = join(fixtureRoot, 'packages/contracts/generated/openapi-3.1.json');
      const original = await readFile(driftedFile, 'utf8');
      await writeFile(driftedFile, `${original}\n`, 'utf8');

      let checkError: unknown;
      try {
        await execFileAsync(
          process.execPath,
          [join(fixtureRoot, 'scripts/contracts/generate-contracts.mjs'), '--check'],
          {
            cwd: fixtureRoot,
            timeout: 30_000,
            windowsHide: true,
          },
        );
      } catch (error) {
        checkError = error;
      }
      expect(checkError).toBeInstanceOf(Error);
      expect((checkError as Error & { stderr?: string }).stderr).toContain(
        'CONTRACT_DRIFT:packages/contracts/generated/openapi-3.1.json',
      );
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 35_000);
});

function isZodSchema(value: unknown): value is {
  _zod: object;
  safeParse(input: unknown): unknown;
} {
  return (
    value !== null &&
    typeof value === 'object' &&
    '_zod' in value &&
    'safeParse' in value &&
    typeof value.safeParse === 'function'
  );
}

function successResponseStatuses(
  operation:
    | {
        responses?: Record<string, unknown>;
      }
    | undefined,
): string[] {
  return Object.keys(operation?.responses ?? {})
    .filter((status) => /^2[0-9]{2}$/u.test(status))
    .sort();
}

function hasProblemJsonSchema(response: unknown): boolean {
  if (response === null || typeof response !== 'object') return false;
  const content = (response as { content?: unknown }).content;
  if (content === null || typeof content !== 'object') return false;
  const problem = (content as Record<string, unknown>)['application/problem+json'];
  if (problem === null || typeof problem !== 'object') return false;
  return 'schema' in problem && (problem as { schema?: unknown }).schema !== undefined;
}

async function copyContractFixture(fixtureRoot: string): Promise<void> {
  for (const file of [
    '.prettierrc.json',
    'package.json',
    'packages/contracts/package.json',
    'scripts/contracts/generate-contracts.mjs',
    ...generatedFiles,
  ]) {
    const target = join(fixtureRoot, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(root, file), target);
  }
  for (const directory of ['apps/api/src', 'packages/contracts/dist']) {
    await cp(join(root, directory), join(fixtureRoot, directory), { recursive: true });
  }
  await symlink(join(root, 'node_modules'), join(fixtureRoot, 'node_modules'), 'junction');
  await symlink(
    join(root, 'packages/contracts/node_modules'),
    join(fixtureRoot, 'packages/contracts/node_modules'),
    'junction',
  );
}

async function controllerOperations(): Promise<{
  operations: Set<string>;
  bodyOperations: Set<string>;
}> {
  const apiRoot = join(root, 'apps/api/src');
  const files = (await readdir(apiRoot, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.controller.ts'))
    .map((entry) => join(entry.parentPath, entry.name));
  const operations = new Set<string>();
  const bodyOperations = new Set<string>();
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const controller = /@Controller\(\s*(?:'([^']*)'|"([^"]*)")?\s*,?\s*\)/u.exec(source);
    if (controller === null) {
      throw new Error(`CONTROLLER_PREFIX_UNSUPPORTED:${relative(root, file)}`);
    }
    const prefix = controller[1] ?? controller[2] ?? '';
    const routePattern = /@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)'|"([^"]*)")?\s*,?\s*\)/gu;
    const routeMatches = [...source.matchAll(routePattern)];
    for (const [index, match] of routeMatches.entries()) {
      const method = match[1];
      if (method === undefined) throw new Error('HTTP_METHOD_REQUIRED');
      const suffix = match[2] ?? match[3] ?? '';
      const joined = `/${[prefix, suffix]
        .filter((part) => part.length > 0)
        .join('/')
        .replaceAll(/:([A-Za-z][A-Za-z0-9_]*)/gu, '{$1}')}`;
      const operation = `${method.toUpperCase()} ${joined}`;
      operations.add(operation);
      const nextRouteIndex = routeMatches[index + 1]?.index ?? source.length;
      const methodSource = source.slice(match.index, nextRouteIndex);
      if (methodSource.includes('@Body()')) bodyOperations.add(operation);
    }
  }
  expect(operations.size).toBeGreaterThanOrEqual(50);
  return { operations, bodyOperations };
}
