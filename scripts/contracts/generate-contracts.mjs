import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import openapiTS, { astToString } from 'openapi-typescript';
import { format as formatWithPrettier, resolveConfig as resolvePrettierConfig } from 'prettier';
import ts from 'typescript';

const ROOT = resolve(import.meta.dirname, '..', '..');
const CONTRACTS_PACKAGE = join(ROOT, 'packages', 'contracts');
const GENERATED_FILES = [
  'packages/contracts/generated/json-schema-2020-12.json',
  'packages/contracts/generated/openapi-3.1.json',
  'apps/web/src/generated/openapi-types.ts',
];
const HTTP_DECORATORS = new Map([
  ['Delete', 'delete'],
  ['Get', 'get'],
  ['Patch', 'patch'],
  ['Post', 'post'],
  ['Put', 'put'],
]);

const checkOnly = process.argv.slice(2).includes('--check');
const unsupportedArguments = process.argv.slice(2).filter((argument) => argument !== '--check');
if (unsupportedArguments.length > 0) {
  throw new Error(`UNSUPPORTED_ARGUMENTS:${unsupportedArguments.join(',')}`);
}

const artifacts = await generateArtifacts();
if (checkOnly) {
  await checkGeneratedArtifacts(artifacts);
} else {
  await writeArtifacts(ROOT, artifacts);
  process.stdout.write(`Generated ${GENERATED_FILES.length} contract artifacts.\n`);
}

async function generateArtifacts() {
  const contracts = await loadContracts();
  const zod = await loadContractsZod();
  const schemaEntries = Object.entries(contracts)
    .filter(([, value]) => isZodSchema(value))
    .sort(([left], [right]) => compareStrings(left, right));

  if (schemaEntries.length === 0) {
    throw new Error('NO_EXPORTED_ZOD_SCHEMAS');
  }

  const registry = zod.registry();
  for (const [name, schema] of schemaEntries) {
    registry.add(schema, { id: name });
  }

  const converted = zod.toJSONSchema(registry, {
    cycles: 'ref',
    reused: 'ref',
    target: 'draft-2020-12',
    uri: (id) => (id === '__shared' ? '' : `#/$defs/${id}`),
  });
  const definitions = collectDefinitions(converted.schemas, schemaEntries);
  const jsonSchemaBundle = sortObject({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://aeostudio.local/contracts/json-schema-2020-12.json',
    $comment:
      'AUTO-GENERATED from the exported Zod 4 schemas in @aeostudio/contracts. DO NOT EDIT.',
    $defs: definitions,
  });

  const routes = await discoverControllerRoutes(new Set(schemaEntries.map(([name]) => name)));
  const openApiDocument = sortObject({
    openapi: '3.1.0',
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: {
      title: 'AEOStudio API',
      version: '1.0.0',
      description:
        'AUTO-GENERATED from Nest controller routes and @aeostudio/contracts Zod 4 schemas.',
    },
    paths: buildOpenApiPaths(routes),
    components: {
      securitySchemes: {
        deletionReceiptCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: '__Host-aeo_deletion_receipt',
        },
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: '__Host-aeo_session',
        },
      },
      schemas: openApiSchemas(definitions),
    },
  });

  const typeAst = await openapiTS(openApiDocument, {
    alphabetize: true,
    pathParamsAsTypes: false,
  });
  const webTypes =
    [
      '/* AUTO-GENERATED from packages/contracts/generated/openapi-3.1.json. */',
      '/* DO NOT EDIT. Run `pnpm contracts:generate` instead. */',
      '',
      astToString(typeAst).trimEnd(),
      '',
    ].join('\n') + '\n';
  const prettierConfig = (await resolvePrettierConfig(join(ROOT, 'package.json'))) ?? {};

  return new Map([
    [
      GENERATED_FILES[0],
      await formatWithPrettier(stableJson(jsonSchemaBundle), {
        ...prettierConfig,
        parser: 'json',
      }),
    ],
    [
      GENERATED_FILES[1],
      await formatWithPrettier(stableJson(openApiDocument), {
        ...prettierConfig,
        parser: 'json',
      }),
    ],
    [
      GENERATED_FILES[2],
      await formatWithPrettier(webTypes, {
        ...prettierConfig,
        parser: 'typescript',
      }),
    ],
  ]);
}

async function loadContracts() {
  const entry = join(CONTRACTS_PACKAGE, 'dist', 'index.js');
  try {
    return await import(`${pathToFileURL(entry).href}?generated=${Date.now()}`);
  } catch (error) {
    throw new Error(
      'CONTRACTS_BUILD_REQUIRED: run `pnpm --filter @aeostudio/contracts build` first',
      { cause: error },
    );
  }
}

async function loadContractsZod() {
  const requireFromContracts = createRequire(join(CONTRACTS_PACKAGE, 'package.json'));
  const zodEntry = requireFromContracts.resolve('zod');
  return import(pathToFileURL(zodEntry).href);
}

function isZodSchema(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    '_zod' in value &&
    typeof value.safeParse === 'function'
  );
}

function collectDefinitions(convertedSchemas, schemaEntries) {
  const shared = convertedSchemas.__shared?.$defs ?? {};
  const definitions = {};

  for (const [name] of schemaEntries) {
    const converted = convertedSchemas[name];
    if (converted === undefined) {
      throw new Error(`ZOD_SCHEMA_NOT_GENERATED:${name}`);
    }
    definitions[name] = withoutRootSchemaMetadata(converted);
  }
  for (const [name, schema] of Object.entries(shared).sort(([left], [right]) =>
    compareStrings(left, right),
  )) {
    if (definitions[name] !== undefined) {
      throw new Error(`GENERATED_SCHEMA_NAME_COLLISION:${name}`);
    }
    definitions[name] = schema;
  }

  return sortObject(definitions);
}

function withoutRootSchemaMetadata(schema) {
  const body = { ...schema };
  delete body.$id;
  delete body.$schema;
  return body;
}

async function discoverControllerRoutes(schemaNames) {
  const apiRoot = join(ROOT, 'apps', 'api', 'src');
  const controllerFiles = (await readdir(apiRoot, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.controller.ts'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort(compareStrings);
  const routes = [];

  for (const file of controllerFiles) {
    const sourceText = await readFile(file, 'utf8');
    const sourceFile = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const statement of sourceFile.statements) {
      if (!ts.isClassDeclaration(statement)) continue;
      const controller = findDecoratorCall(statement, 'Controller');
      if (controller === undefined) continue;
      const prefix = stringDecoratorArgument(controller, file);
      const controllerName = statement.name?.text ?? 'AnonymousController';

      for (const member of statement.members) {
        if (!ts.isMethodDeclaration(member)) continue;
        const httpDecorator = findHttpDecorator(member);
        if (httpDecorator === undefined) continue;
        const suffix = stringDecoratorArgument(httpDecorator.call, file);
        const methodName = propertyNameText(member.name, file);
        const path = openApiPath(prefix, suffix);
        const operationId = `${controllerName.replace(/Controller$/u, '')}_${methodName}`;
        const requestSchema = requestBodySchema(member, schemaNames, operationId);
        const responseSchemas = returnedSchemas(member, schemaNames, statement);
        const responseStatuses = discoverResponseStatuses(
          member,
          httpDecorator.httpMethod,
          statement,
        );
        const binaryResponse = sendsBufferResponse(member);
        const successMediaType = explicitSuccessMediaType(member);
        const parameters = routeParameters(member, path, file);

        routes.push({
          controllerName,
          httpMethod: httpDecorator.httpMethod,
          methodName,
          operationId,
          parameters,
          path,
          requestSchema,
          responseSchemas,
          responseStatuses,
          binaryResponse,
          successMediaType,
          security: securityForPath(path),
          source: relative(ROOT, file).replaceAll('\\', '/'),
        });
      }
    }
  }

  const routeKeys = new Set();
  const operationIds = new Set();
  for (const route of routes) {
    const routeKey = `${route.httpMethod.toUpperCase()} ${route.path}`;
    if (routeKeys.has(routeKey)) throw new Error(`DUPLICATE_HTTP_ROUTE:${routeKey}`);
    if (operationIds.has(route.operationId)) {
      throw new Error(`DUPLICATE_OPERATION_ID:${route.operationId}`);
    }
    routeKeys.add(routeKey);
    operationIds.add(route.operationId);
  }

  return routes.sort((left, right) => {
    const byPath = compareStrings(left.path, right.path);
    return byPath === 0 ? compareStrings(left.httpMethod, right.httpMethod) : byPath;
  });
}

function findDecoratorCall(node, expectedName) {
  const decorators = ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
  for (const decorator of decorators) {
    if (
      ts.isCallExpression(decorator.expression) &&
      ts.isIdentifier(decorator.expression.expression) &&
      decorator.expression.expression.text === expectedName
    ) {
      return decorator.expression;
    }
  }
  return undefined;
}

function findHttpDecorator(node) {
  for (const [decoratorName, httpMethod] of HTTP_DECORATORS) {
    const call = findDecoratorCall(node, decoratorName);
    if (call !== undefined) return { call, httpMethod };
  }
  return undefined;
}

function stringDecoratorArgument(call, file) {
  const argument = call.arguments[0];
  if (argument === undefined) return '';
  if (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument)) {
    throw new Error(`NON_LITERAL_ROUTE:${relative(ROOT, file)}`);
  }
  return argument.text;
}

function propertyNameText(name, file) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  throw new Error(`UNSUPPORTED_CONTROLLER_METHOD_NAME:${relative(ROOT, file)}`);
}

function openApiPath(prefix, suffix) {
  const segments = [prefix, suffix]
    .filter((part) => part.length > 0)
    .join('/')
    .replaceAll(/^\/+|\/+$/gu, '');
  return `/${segments.replaceAll(/:([A-Za-z][A-Za-z0-9_]*)/gu, '{$1}')}`;
}

function requestBodySchema(method, schemaNames, operationId) {
  const bodyNames = new Set();
  for (const parameter of method.parameters) {
    if (findDecoratorCall(parameter, 'Body') === undefined || !ts.isIdentifier(parameter.name)) {
      continue;
    }
    bodyNames.add(parameter.name.text);
  }
  if (bodyNames.size === 0) return undefined;

  const candidates = new Set();
  walk(method.body, (node) => {
    if (!ts.isCallExpression(node) || node.arguments.length === 0) return;
    if (
      !ts.isPropertyAccessExpression(node.expression) ||
      !['parse', 'safeParse'].includes(node.expression.name.text) ||
      !ts.isIdentifier(node.expression.expression)
    ) {
      return;
    }
    const argument = node.arguments[0];
    const schemaName = node.expression.expression.text;
    if (ts.isIdentifier(argument) && bodyNames.has(argument.text) && schemaNames.has(schemaName)) {
      candidates.add(schemaName);
    }
  });

  if (candidates.size > 1) {
    throw new Error(`AMBIGUOUS_REQUEST_SCHEMA:${[...candidates].sort(compareStrings).join(',')}`);
  }
  const requestSchema = [...candidates][0];
  if (requestSchema === undefined) {
    throw new Error(`UNBOUND_REQUEST_BODY_SCHEMA:${operationId}`);
  }
  return requestSchema;
}

function returnedSchemas(method, schemaNames, controller) {
  const schemas = new Set();
  const methods = new Map();
  for (const member of controller.members) {
    if (
      ts.isMethodDeclaration(member) &&
      (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
    ) {
      methods.set(member.name.text, member);
    }
  }
  const visited = new Set();

  const collectFromMethod = (current) => {
    if (visited.has(current)) return;
    visited.add(current);
    walk(current.body, (node) => {
      if (ts.isReturnStatement(node) && node.expression !== undefined) {
        collectSchemaParses(node.expression, schemas, schemaNames);
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'send'
      ) {
        for (const argument of node.arguments) {
          collectSchemaParses(argument, schemas, schemaNames);
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        const called = methods.get(node.expression.name.text);
        if (called !== undefined) collectFromMethod(called);
      }
    });
  };

  collectFromMethod(method);
  return [...schemas].sort(compareStrings);
}

function collectSchemaParses(node, schemas, schemaNames) {
  walk(node, (candidate) => {
    if (
      ts.isCallExpression(candidate) &&
      ts.isPropertyAccessExpression(candidate.expression) &&
      candidate.expression.name.text === 'parse' &&
      ts.isIdentifier(candidate.expression.expression) &&
      schemaNames.has(candidate.expression.expression.text)
    ) {
      schemas.add(candidate.expression.expression.text);
    }
  });
}

function sendsBufferResponse(method) {
  let found = false;
  walk(method.body, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'send' &&
      node.arguments.some(
        (argument) =>
          ts.isCallExpression(argument) &&
          ts.isPropertyAccessExpression(argument.expression) &&
          ts.isIdentifier(argument.expression.expression) &&
          argument.expression.expression.text === 'Buffer' &&
          argument.expression.name.text === 'from',
      )
    ) {
      found = true;
    }
  });
  return found;
}

function explicitSuccessMediaType(method) {
  const mediaTypes = new Set();
  walk(method.body, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== 'header'
    ) {
      return;
    }
    const headerName = node.arguments[0];
    const headerValue = node.arguments[1];
    if (
      (ts.isStringLiteral(headerName) || ts.isNoSubstitutionTemplateLiteral(headerName)) &&
      headerName.text.toLowerCase() === 'content-type' &&
      (ts.isStringLiteral(headerValue) || ts.isNoSubstitutionTemplateLiteral(headerValue))
    ) {
      const mediaType = headerValue.text.split(';', 1)[0]?.trim().toLowerCase();
      if (mediaType !== undefined && mediaType.length > 0) mediaTypes.add(mediaType);
    }
  });
  if (mediaTypes.size > 1) {
    throw new Error(
      `AMBIGUOUS_SUCCESS_MEDIA_TYPE:${[...mediaTypes].sort(compareStrings).join(',')}`,
    );
  }
  return [...mediaTypes][0];
}

function discoverResponseStatuses(method, httpMethod, controller) {
  const explicitSuccess = new Set();
  const explicitErrors = new Set();
  const redirects = new Set();
  const methods = new Map();
  for (const member of controller.members) {
    if (
      ts.isMethodDeclaration(member) &&
      (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
    ) {
      methods.set(member.name.text, member);
    }
  }
  const visited = new Set();
  const collectFromMethod = (current) => {
    if (visited.has(current)) return;
    visited.add(current);
    const httpCode = findDecoratorCall(current, 'HttpCode');
    if (httpCode !== undefined) {
      const statuses = numericArguments(httpCode.arguments[0]);
      if (statuses.length === 0) throw new Error('NON_LITERAL_HTTP_STATUS');
      for (const status of statuses) {
        addStatus(status, explicitSuccess, explicitErrors, redirects);
      }
    }
    walk(current.body, (node) => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      const callName = node.expression.name.text;
      if (callName === 'code' || callName === 'status') {
        for (const status of numericArguments(node.arguments[0])) {
          addStatus(status, explicitSuccess, explicitErrors, redirects);
        }
      }
      if (callName === 'redirect') {
        for (const argument of node.arguments) {
          for (const status of numericArguments(argument)) {
            if (status >= 300 && status < 400) redirects.add(status);
          }
        }
      }
      if (node.expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
        const called = methods.get(callName);
        if (called !== undefined) collectFromMethod(called);
      }
    });
  };
  collectFromMethod(method);

  if (explicitSuccess.size === 0 && redirects.size === 0) {
    explicitSuccess.add(httpMethod === 'post' ? 201 : 200);
  }
  return {
    errors: [...explicitErrors].sort((left, right) => left - right),
    success: [...explicitSuccess, ...redirects].sort((left, right) => left - right),
  };
}

function numericArguments(argument) {
  if (argument === undefined) return [];
  if (ts.isNumericLiteral(argument)) {
    const value = Number(argument.text);
    return Number.isSafeInteger(value) ? [value] : [];
  }
  if (ts.isParenthesizedExpression(argument)) {
    return numericArguments(argument.expression);
  }
  if (ts.isConditionalExpression(argument)) {
    return [...numericArguments(argument.whenTrue), ...numericArguments(argument.whenFalse)];
  }
  return [];
}

function addStatus(status, success, errors, redirects) {
  if (status >= 200 && status < 300) success.add(status);
  else if (status >= 300 && status < 400) redirects.add(status);
  else if (status >= 400 && status < 600) errors.add(status);
}

function securityForPath(path) {
  if (path === '/api/v1/privacy/deletion-receipts/current') {
    return [{ deletionReceiptCookie: [] }];
  }
  if (
    path === '/api/v1/auth/session' ||
    path === '/api/v1/runtime/build-identity' ||
    path === '/api/v1/tenants' ||
    path.startsWith('/api/v1/tenants/')
  ) {
    return [{ sessionCookie: [] }];
  }
  return [];
}

function routeParameters(method, path, file) {
  const parameters = [];
  const pathNames = new Set([...path.matchAll(/\{([^}]+)\}/gu)].map((match) => match[1]));
  for (const parameter of method.parameters) {
    if (!ts.isIdentifier(parameter.name)) continue;
    for (const descriptor of [
      { decorator: 'Param', location: 'path' },
      { decorator: 'Query', location: 'query' },
    ]) {
      const call = findDecoratorCall(parameter, descriptor.decorator);
      if (call === undefined) continue;
      const name = stringDecoratorArgument(call, file);
      if (name.length === 0) continue;
      if (descriptor.location === 'path') pathNames.delete(name);
      parameters.push({
        in: descriptor.location,
        name,
        required: descriptor.location === 'path' || parameterIsRequired(parameter),
        schema: { type: 'string' },
      });
    }
  }
  if (pathNames.size > 0) {
    throw new Error(`UNDOCUMENTED_PATH_PARAMETERS:${[...pathNames].join(',')}`);
  }
  return parameters.sort((left, right) => {
    const byLocation = compareStrings(left.in, right.in);
    return byLocation === 0 ? compareStrings(left.name, right.name) : byLocation;
  });
}

function parameterIsRequired(parameter) {
  if (parameter.questionToken !== undefined || parameter.initializer !== undefined) return false;
  if (parameter.type === undefined) return true;
  if (ts.isUnionTypeNode(parameter.type)) {
    return !parameter.type.types.some(
      (part) =>
        part.kind === ts.SyntaxKind.UndefinedKeyword ||
        (ts.isLiteralTypeNode(part) && part.literal.kind === ts.SyntaxKind.NullKeyword),
    );
  }
  return parameter.type.kind !== ts.SyntaxKind.UndefinedKeyword;
}

function walk(node, visitor) {
  if (node === undefined) return;
  visitor(node);
  ts.forEachChild(node, (child) => walk(child, visitor));
}

function buildOpenApiPaths(routes) {
  const paths = {};
  for (const route of routes) {
    const successSchemas = route.responseSchemas.filter(
      (schemaName) => !schemaName.includes('Problem'),
    );
    const problemSchemas = route.responseSchemas.filter((schemaName) =>
      schemaName.includes('Problem'),
    );
    const successResponseContract =
      successSchemas.length > 0
        ? 'ZOD_SCHEMA'
        : route.binaryResponse
          ? 'BINARY'
          : route.responseStatuses.success.every((status) => status >= 300 && status < 400)
            ? 'REDIRECT'
            : route.responseStatuses.success.every((status) => status === 204)
              ? 'NO_CONTENT'
              : 'UNSPECIFIED';
    const operation = {
      operationId: route.operationId,
      summary: route.methodName,
      tags: [route.controllerName.replace(/Controller$/u, '')],
      security: route.security,
      'x-aeostudio-source': route.source,
      'x-aeostudio-success-response-contract': successResponseContract,
      responses: buildResponses(
        route.responseStatuses,
        successSchemas,
        problemSchemas,
        successResponseContract,
        route.successMediaType,
      ),
    };
    if (route.parameters.length > 0) operation.parameters = route.parameters;
    if (route.requestSchema !== undefined) {
      operation.requestBody = {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: `#/components/schemas/${route.requestSchema}` },
          },
        },
      };
    }
    paths[route.path] ??= {};
    paths[route.path][route.httpMethod] = operation;
  }
  return paths;
}

function buildResponses(
  responseStatuses,
  successSchemas,
  problemSchemas,
  successResponseContract,
  successMediaType,
) {
  const responses = {};
  for (const status of responseStatuses.success) {
    const response = {
      description:
        status >= 300
          ? 'Redirect'
          : successSchemas.length === 0
            ? 'Success response is not yet represented by an exported Zod schema'
            : 'Success',
    };
    if (status !== 204 && status < 300 && successSchemas.length > 0) {
      response.content = {
        [successMediaType ?? 'application/json']: {
          schema: schemaReferences(successSchemas),
        },
      };
    } else if (status < 300 && successResponseContract === 'BINARY') {
      response.content = {
        [successMediaType ?? 'application/octet-stream']: {
          schema: { type: 'string', format: 'binary' },
        },
      };
    }
    responses[String(status)] = response;
  }
  for (const status of responseStatuses.errors) {
    const response = { description: 'Request rejected' };
    if (problemSchemas.length > 0) {
      response.content = {
        'application/problem+json': {
          schema: schemaReferences(problemSchemas, 'anyOf'),
        },
      };
    }
    responses[String(status)] = response;
  }
  responses.default = {
    description: 'Unhandled error',
    content: {
      'application/problem+json': {
        schema: { $ref: '#/components/schemas/ProblemDetailsSchema' },
      },
    },
  };
  return responses;
}

function schemaReferences(schemaNames, composition = 'oneOf') {
  const refs = schemaNames.map((name) => ({ $ref: `#/components/schemas/${name}` }));
  return refs.length === 1 ? refs[0] : { [composition]: refs };
}

function openApiSchemas(definitions) {
  return sortObject(
    Object.fromEntries(
      Object.entries(definitions).map(([name, schema]) => [
        name,
        rewriteReferences(schema, '#/$defs/', '#/components/schemas/'),
      ]),
    ),
  );
}

function rewriteReferences(value, from, to) {
  if (Array.isArray(value)) return value.map((entry) => rewriteReferences(entry, from, to));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === '$ref' && typeof entry === 'string' && entry.startsWith(from)
        ? `${to}${entry.slice(from.length)}`
        : rewriteReferences(entry, from, to),
    ]),
  );
}

async function checkGeneratedArtifacts(expectedArtifacts) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'aeostudio-contracts-'));
  try {
    await writeArtifacts(temporaryRoot, expectedArtifacts);
    const drift = [];
    for (const generatedFile of GENERATED_FILES) {
      const expected = await readFile(join(temporaryRoot, generatedFile), 'utf8');
      let actual;
      try {
        actual = await readFile(join(ROOT, generatedFile), 'utf8');
      } catch {
        drift.push(generatedFile);
        continue;
      }
      if (actual !== expected) drift.push(generatedFile);
    }
    if (drift.length > 0) {
      throw new Error(
        `CONTRACT_DRIFT:${drift.join(',')}\nRun \`pnpm contracts:generate\` and commit the results.`,
      );
    }
    process.stdout.write(`Contract drift check passed (${GENERATED_FILES.length} files).\n`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function writeArtifacts(root, generatedArtifacts) {
  for (const [generatedFile, contents] of generatedArtifacts) {
    const target = join(root, generatedFile);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }
}

function stableJson(value) {
  return `${JSON.stringify(sortObject(value), null, 2)}\n`;
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, entry]) => [key, sortObject(entry)]),
  );
}

function compareStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
