import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DescribeSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { Client } from 'pg';

import { runSerializedBootstrap } from './bootstrap-coordinator.js';

interface RdsMasterSecret {
  host: string;
  password: string;
  port: number;
  username: string;
}

interface DatabaseSecretSpec {
  environmentName: string;
  roleName: string;
  secretId: string;
}

interface KeySecretSpec {
  environmentName: string;
  kind: 'raw' | 'tenant-data-broker-hmac-key-ring';
  secretId: string;
}

interface BootstrapState {
  databasePasswords: ReadonlyMap<string, string>;
  databaseSecretValues: ReadonlyMap<string, string>;
  existingDatabaseSecrets: readonly {
    spec: DatabaseSecretSpec;
    value: string | undefined;
  }[];
  existingKeySecrets: readonly {
    spec: KeySecretSpec;
    value: string | undefined;
  }[];
  keySecretValues: ReadonlyMap<string, string>;
}

const databasePasswordPattern = /^[A-Za-z0-9_-]{43}$/u;
const environmentPattern = /^(?:staging|production)$/u;
const identifierPattern = /^[a-z_][a-z0-9_]{0,62}$/u;
const hmacKeyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error('BOOTSTRAP_CONFIGURATION_INVALID');
  }
  return value;
}

function parseMasterSecret(secret: string): RdsMasterSecret {
  const candidate: unknown = JSON.parse(secret);
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error('BOOTSTRAP_MASTER_SECRET_INVALID');
  }

  const value = candidate as Record<string, unknown>;
  const port = typeof value.port === 'string' ? Number(value.port) : value.port;
  if (
    typeof value.host !== 'string' ||
    value.host.length === 0 ||
    typeof value.username !== 'string' ||
    !identifierPattern.test(value.username) ||
    typeof value.password !== 'string' ||
    value.password.length === 0 ||
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error('BOOTSTRAP_MASTER_SECRET_INVALID');
  }

  return {
    host: value.host,
    password: value.password,
    port,
    username: value.username,
  };
}

function generateSecretValue(excluded: ReadonlySet<string>): string {
  let value: string;
  do {
    value = randomBytes(32).toString('base64url');
  } while (excluded.has(value));
  return value;
}

export function createInitialTenantDataBrokerKeyRing(
  environment: string,
  excluded: ReadonlySet<string>,
): string {
  if (!environmentPattern.test(environment)) {
    throw new Error('BOOTSTRAP_CONFIGURATION_INVALID');
  }
  return JSON.stringify({
    schemaVersion: 'aeostudio.tenant-data-broker-key-ring.v1',
    current: {
      id: `broker-${environment}-v1`,
      value: generateSecretValue(excluded),
    },
  });
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function parseTenantDataBrokerKeyRing(secret: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new Error('BOOTSTRAP_KEY_SECRET_INVALID');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !(
      hasExactKeys(parsed as Record<string, unknown>, ['schemaVersion', 'current']) ||
      hasExactKeys(parsed as Record<string, unknown>, ['schemaVersion', 'current', 'previous'])
    )
  ) {
    throw new Error('BOOTSTRAP_KEY_SECRET_INVALID');
  }
  const ring = parsed as Record<string, unknown>;
  const current = ring.current;
  if (
    ring.schemaVersion !== 'aeostudio.tenant-data-broker-key-ring.v1' ||
    current === null ||
    typeof current !== 'object' ||
    Array.isArray(current) ||
    !hasExactKeys(current as Record<string, unknown>, ['id', 'value'])
  ) {
    throw new Error('BOOTSTRAP_KEY_SECRET_INVALID');
  }
  const currentKey = current as Record<string, unknown>;
  if (
    typeof currentKey.id !== 'string' ||
    !hmacKeyIdPattern.test(currentKey.id) ||
    typeof currentKey.value !== 'string' ||
    !databasePasswordPattern.test(currentKey.value)
  ) {
    throw new Error('BOOTSTRAP_KEY_SECRET_INVALID');
  }

  const values = [currentKey.value];
  if (ring.previous !== undefined) {
    const previous = ring.previous;
    if (
      previous === null ||
      typeof previous !== 'object' ||
      Array.isArray(previous) ||
      !hasExactKeys(previous as Record<string, unknown>, ['id', 'value', 'acceptUntil'])
    ) {
      throw new Error('BOOTSTRAP_KEY_SECRET_INVALID');
    }
    const previousKey = previous as Record<string, unknown>;
    if (
      typeof previousKey.id !== 'string' ||
      !hmacKeyIdPattern.test(previousKey.id) ||
      previousKey.id === currentKey.id ||
      typeof previousKey.value !== 'string' ||
      !databasePasswordPattern.test(previousKey.value) ||
      previousKey.value === currentKey.value ||
      typeof previousKey.acceptUntil !== 'string' ||
      !Number.isFinite(Date.parse(previousKey.acceptUntil))
    ) {
      throw new Error('BOOTSTRAP_KEY_SECRET_INVALID');
    }
    values.push(previousKey.value);
  }
  return values;
}

function postgresScramSha256Verifier(password: string): string {
  const iterations = 4096;
  const salt = randomBytes(16);
  const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest();
  const verifier = `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
  saltedPassword.fill(0);
  clientKey.fill(0);
  return verifier;
}

function databaseUrl(
  master: RdsMasterSecret,
  databaseName: string,
  roleName: string,
  password: string,
): string {
  return `postgresql://${encodeURIComponent(roleName)}:${encodeURIComponent(password)}@${master.host}:${master.port}/${encodeURIComponent(databaseName)}?sslmode=require`;
}

function passwordFromDatabaseUrl(
  secret: string,
  master: RdsMasterSecret,
  databaseName: string,
  expectedRole: string,
): string {
  const url = new URL(secret);
  const password = decodeURIComponent(url.password);
  const port = url.port.length === 0 ? 5432 : Number(url.port);
  if (
    url.protocol !== 'postgresql:' ||
    decodeURIComponent(url.username) !== expectedRole ||
    url.hostname.toLowerCase() !== master.host.toLowerCase() ||
    port !== master.port ||
    decodeURIComponent(url.pathname.slice(1)) !== databaseName ||
    url.searchParams.size !== 1 ||
    url.searchParams.get('sslmode') !== 'require' ||
    !databasePasswordPattern.test(password)
  ) {
    throw new Error('BOOTSTRAP_TARGET_SECRET_INVALID');
  }
  return password;
}

async function optionalSecretValue(
  client: SecretsManagerClient,
  secretId: string,
): Promise<string | undefined> {
  await client.send(new DescribeSecretCommand({ SecretId: secretId }));
  try {
    const result = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    if (result.SecretString === undefined) {
      throw new Error('BOOTSTRAP_TARGET_SECRET_INVALID');
    }
    return result.SecretString;
  } catch (error) {
    if (error instanceof Error && error.name === 'ResourceNotFoundException') {
      return undefined;
    }
    throw error;
  }
}

export async function reconcileDatabasePrincipals(
  connection: Client,
  databaseName: string,
  passwords: ReadonlyMap<string, string>,
): Promise<void> {
  try {
    await connection.query('BEGIN');
    await connection.query(`
      DO $bootstrap$
      DECLARE
        group_role record;
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'aeostudio_runtime') THEN
          CREATE ROLE aeostudio_runtime;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'aeostudio_lifecycle_worker'
        ) THEN
          CREATE ROLE aeostudio_lifecycle_worker;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'aeostudio_tenant_data_broker'
        ) THEN
          CREATE ROLE aeostudio_tenant_data_broker;
        END IF;

        FOR group_role IN
          SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
            rolreplication, rolbypassrls
          FROM pg_catalog.pg_roles
          WHERE rolname IN (
            'aeostudio_runtime',
            'aeostudio_lifecycle_worker',
            'aeostudio_tenant_data_broker'
          )
        LOOP
          IF group_role.rolcanlogin OR group_role.rolsuper OR group_role.rolcreatedb
             OR group_role.rolcreaterole OR group_role.rolreplication
             OR group_role.rolbypassrls THEN
            RAISE EXCEPTION 'BOOTSTRAP_GROUP_ROLE_PRIVILEGE_INVALID'
              USING ERRCODE = '42501';
          END IF;
        END LOOP;

        ALTER ROLE aeostudio_runtime NOLOGIN INHERIT;
        ALTER ROLE aeostudio_lifecycle_worker NOLOGIN INHERIT;
        ALTER ROLE aeostudio_tenant_data_broker NOLOGIN INHERIT;
      END
      $bootstrap$;
    `);
    await connection.query(`
      CREATE OR REPLACE FUNCTION pg_temp.aeostudio_ensure_login(
        p_role_name text,
        p_password_verifier text,
        p_create_role boolean,
        p_inherit boolean,
        p_connection_limit integer
      )
      RETURNS void
      LANGUAGE plpgsql
      SET search_path = pg_catalog
      AS $function$
      DECLARE
        v_create_role text := CASE WHEN p_create_role THEN 'CREATEROLE' ELSE 'NOCREATEROLE' END;
        v_inherit text := CASE WHEN p_inherit THEN 'INHERIT' ELSE 'NOINHERIT' END;
        v_role record;
      BEGIN
        IF p_role_name NOT IN (
          'aeostudio_app_login',
          'aeostudio_lifecycle_login',
          'aeostudio_migration_login',
          'aeostudio_tenant_data_broker_login'
        ) OR p_password_verifier !~
          '^SCRAM-SHA-256[$]4096:[A-Za-z0-9+/]{22}==[$][A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$'
          OR p_connection_limit < 1 THEN
          RAISE EXCEPTION 'BOOTSTRAP_LOGIN_INPUT_INVALID';
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = p_role_name) THEN
          EXECUTE format('CREATE ROLE %I', p_role_name);
        END IF;

        SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
          rolreplication, rolbypassrls INTO STRICT v_role
        FROM pg_catalog.pg_roles
        WHERE rolname = p_role_name;
        IF v_role.rolsuper OR v_role.rolcreatedb OR v_role.rolreplication
           OR v_role.rolbypassrls
           OR (NOT p_create_role AND v_role.rolcreaterole) THEN
          RAISE EXCEPTION 'BOOTSTRAP_LOGIN_ROLE_PRIVILEGE_INVALID'
            USING ERRCODE = '42501';
        END IF;

        EXECUTE format(
          'ALTER ROLE %I LOGIN %s %s CONNECTION LIMIT %s PASSWORD %L',
          p_role_name,
          v_create_role,
          v_inherit,
          p_connection_limit,
          p_password_verifier
        );
      END
      $function$;
    `);

    const loginSpecs = [
      ['aeostudio_app_login', false, true, 100],
      ['aeostudio_lifecycle_login', false, true, 25],
      ['aeostudio_migration_login', true, false, 5],
      ['aeostudio_tenant_data_broker_login', false, true, 50],
    ] as const;
    for (const [roleName, canCreateRoles, inherit, connectionLimit] of loginSpecs) {
      const password = passwords.get(roleName);
      if (password === undefined) {
        throw new Error('BOOTSTRAP_PASSWORD_MISSING');
      }
      await connection.query('SELECT pg_temp.aeostudio_ensure_login($1, $2, $3, $4, $5)', [
        roleName,
        postgresScramSha256Verifier(password),
        canCreateRoles,
        inherit,
        connectionLimit,
      ]);
    }

    await connection.query(`
      CREATE OR REPLACE FUNCTION pg_temp.aeostudio_reconcile_memberships(
        p_member_name text,
        p_allowed_roles text[]
      )
      RETURNS void
      LANGUAGE plpgsql
      SET search_path = pg_catalog
      AS $function$
      DECLARE
        membership record;
      BEGIN
        IF p_member_name NOT IN (
          'aeostudio_app_login',
          'aeostudio_lifecycle_login',
          'aeostudio_tenant_data_broker',
          'aeostudio_tenant_data_broker_login'
        ) OR p_allowed_roles IS NULL THEN
          RAISE EXCEPTION 'BOOTSTRAP_MEMBERSHIP_INPUT_INVALID';
        END IF;

        FOR membership IN
          SELECT granted.rolname
          FROM pg_catalog.pg_auth_members granted_membership
          JOIN pg_catalog.pg_roles granted ON granted.oid = granted_membership.roleid
          JOIN pg_catalog.pg_roles member ON member.oid = granted_membership.member
          WHERE member.rolname = p_member_name
            AND NOT (granted.rolname = ANY(p_allowed_roles))
        LOOP
          EXECUTE format('REVOKE %I FROM %I', membership.rolname, p_member_name);
        END LOOP;
      END
      $function$;
    `);
    const membershipSpecs = [
      ['aeostudio_app_login', ['aeostudio_runtime']],
      ['aeostudio_lifecycle_login', ['aeostudio_lifecycle_worker']],
      ['aeostudio_tenant_data_broker', []],
      ['aeostudio_tenant_data_broker_login', ['aeostudio_tenant_data_broker']],
    ] as const;
    for (const [memberName, allowedRoles] of membershipSpecs) {
      await connection.query('SELECT pg_temp.aeostudio_reconcile_memberships($1, $2)', [
        memberName,
        allowedRoles,
      ]);
    }

    const quotedDatabaseName = `"${databaseName.replaceAll('"', '""')}"`;
    await connection.query(`REVOKE ALL ON DATABASE ${quotedDatabaseName} FROM PUBLIC`);
    await connection.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await connection.query(
      `GRANT CONNECT ON DATABASE ${quotedDatabaseName} TO aeostudio_runtime, aeostudio_lifecycle_worker, aeostudio_tenant_data_broker`,
    );
    await connection.query(
      `GRANT CONNECT, TEMPORARY ON DATABASE ${quotedDatabaseName} TO aeostudio_migration_login`,
    );
    await connection.query('GRANT USAGE, CREATE ON SCHEMA public TO aeostudio_migration_login');
    await connection.query('GRANT aeostudio_runtime TO aeostudio_app_login');
    await connection.query('GRANT aeostudio_lifecycle_worker TO aeostudio_lifecycle_login');
    await connection.query(
      'GRANT aeostudio_tenant_data_broker TO aeostudio_tenant_data_broker_login',
    );
    await connection.query(
      'GRANT aeostudio_runtime, aeostudio_lifecycle_worker, aeostudio_tenant_data_broker TO aeostudio_migration_login WITH ADMIN OPTION',
    );
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  }
}

async function main(): Promise<void> {
  const environment = requiredEnvironment('AEO_ENVIRONMENT');
  const databaseName = requiredEnvironment('AEO_DATABASE_NAME');
  const confirmation = requiredEnvironment('BOOTSTRAP_CONFIRMATION');
  if (
    !environmentPattern.test(environment) ||
    !identifierPattern.test(databaseName) ||
    confirmation !== `bootstrap:${environment}`
  ) {
    throw new Error('BOOTSTRAP_CONFIRMATION_INVALID');
  }

  const secretClient = new SecretsManagerClient({});
  const masterSecretId = requiredEnvironment('RDS_MASTER_SECRET_ARN');
  const masterResult = await secretClient.send(
    new GetSecretValueCommand({ SecretId: masterSecretId }),
  );
  if (masterResult.SecretString === undefined) {
    throw new Error('BOOTSTRAP_MASTER_SECRET_INVALID');
  }
  const master = parseMasterSecret(masterResult.SecretString);

  const databaseSecretSpecs: readonly DatabaseSecretSpec[] = [
    {
      environmentName: 'RUNTIME_DATABASE_URL_SECRET_ARN',
      roleName: 'aeostudio_app_login',
      secretId: requiredEnvironment('RUNTIME_DATABASE_URL_SECRET_ARN'),
    },
    {
      environmentName: 'LIFECYCLE_DATABASE_URL_SECRET_ARN',
      roleName: 'aeostudio_lifecycle_login',
      secretId: requiredEnvironment('LIFECYCLE_DATABASE_URL_SECRET_ARN'),
    },
    {
      environmentName: 'ADMIN_DATABASE_URL_SECRET_ARN',
      roleName: 'aeostudio_migration_login',
      secretId: requiredEnvironment('ADMIN_DATABASE_URL_SECRET_ARN'),
    },
    {
      environmentName: 'TENANT_DATA_BROKER_DATABASE_URL_SECRET_ARN',
      roleName: 'aeostudio_tenant_data_broker_login',
      secretId: requiredEnvironment('TENANT_DATA_BROKER_DATABASE_URL_SECRET_ARN'),
    },
  ];
  const keySecretSpecs: readonly KeySecretSpec[] = [
    {
      environmentName: 'SESSION_ENCRYPTION_KEY_SECRET_ARN',
      kind: 'raw',
      secretId: requiredEnvironment('SESSION_ENCRYPTION_KEY_SECRET_ARN'),
    },
    {
      environmentName: 'DELETION_RECEIPT_SIGNING_KEY_SECRET_ARN',
      kind: 'raw',
      secretId: requiredEnvironment('DELETION_RECEIPT_SIGNING_KEY_SECRET_ARN'),
    },
    {
      environmentName: 'TENANT_DATA_BROKER_HMAC_KEY_RING_SECRET_ARN',
      kind: 'tenant-data-broker-hmac-key-ring',
      secretId: requiredEnvironment('TENANT_DATA_BROKER_HMAC_KEY_RING_SECRET_ARN'),
    },
  ];

  const connection = new Client({
    connectionString: databaseUrl(master, databaseName, master.username, master.password),
  });
  await runSerializedBootstrap<BootstrapState>({
    withDatabaseSessionLock: async (operation) => {
      await connection.connect();
      let lockAcquired = false;
      try {
        await connection.query('SELECT pg_advisory_lock(hashtext($1))', [
          'aeostudio-principal-bootstrap',
        ]);
        lockAcquired = true;
        return await operation();
      } finally {
        try {
          if (lockAcquired) {
            await connection.query('SELECT pg_advisory_unlock(hashtext($1))', [
              'aeostudio-principal-bootstrap',
            ]);
          }
        } finally {
          await connection.end();
        }
      }
    },
    readTargetSecrets: async () => {
      const existingDatabaseSecrets = await Promise.all(
        databaseSecretSpecs.map(async (spec) => ({
          spec,
          value: await optionalSecretValue(secretClient, spec.secretId),
        })),
      );
      const existingKeySecrets = await Promise.all(
        keySecretSpecs.map(async (spec) => ({
          spec,
          value: await optionalSecretValue(secretClient, spec.secretId),
        })),
      );

      const usedValues = new Set<string>();
      const databasePasswords = new Map<string, string>();
      const databaseSecretValues = new Map<string, string>();
      for (const { spec, value } of existingDatabaseSecrets) {
        const password =
          value === undefined
            ? generateSecretValue(usedValues)
            : passwordFromDatabaseUrl(value, master, databaseName, spec.roleName);
        if (usedValues.has(password)) {
          throw new Error('BOOTSTRAP_PASSWORDS_MUST_BE_DISTINCT');
        }
        usedValues.add(password);
        databasePasswords.set(spec.roleName, password);
        databaseSecretValues.set(
          spec.environmentName,
          value ?? databaseUrl(master, databaseName, spec.roleName, password),
        );
      }

      const keySecretValues = new Map<string, string>();
      for (const { spec, value } of existingKeySecrets) {
        if (spec.kind === 'tenant-data-broker-hmac-key-ring') {
          const keyRing = value ?? createInitialTenantDataBrokerKeyRing(environment, usedValues);
          for (const key of parseTenantDataBrokerKeyRing(keyRing)) {
            if (usedValues.has(key)) {
              throw new Error('BOOTSTRAP_KEY_SECRET_INVALID');
            }
            usedValues.add(key);
          }
          keySecretValues.set(spec.environmentName, keyRing);
        } else {
          const key = value ?? generateSecretValue(usedValues);
          if (!databasePasswordPattern.test(key) || usedValues.has(key)) {
            throw new Error('BOOTSTRAP_KEY_SECRET_INVALID');
          }
          usedValues.add(key);
          keySecretValues.set(spec.environmentName, key);
        }
      }
      return {
        databasePasswords,
        databaseSecretValues,
        existingDatabaseSecrets,
        existingKeySecrets,
        keySecretValues,
      };
    },
    reconcileDatabase: async (state) => {
      await reconcileDatabasePrincipals(connection, databaseName, state.databasePasswords);
    },
    writeTargetSecrets: async (state) => {
      for (const { spec, value } of state.existingDatabaseSecrets) {
        if (value === undefined) {
          const secretString = state.databaseSecretValues.get(spec.environmentName);
          if (secretString === undefined) {
            throw new Error('BOOTSTRAP_SECRET_VALUE_MISSING');
          }
          await secretClient.send(
            new PutSecretValueCommand({ SecretId: spec.secretId, SecretString: secretString }),
          );
        }
      }
      for (const { spec, value } of state.existingKeySecrets) {
        if (value === undefined) {
          const secretString = state.keySecretValues.get(spec.environmentName);
          if (secretString === undefined) {
            throw new Error('BOOTSTRAP_SECRET_VALUE_MISSING');
          }
          await secretClient.send(
            new PutSecretValueCommand({ SecretId: spec.secretId, SecretString: secretString }),
          );
        }
      }
    },
  });

  process.stdout.write('BOOTSTRAP_COMPLETE\n');
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  try {
    await main();
  } catch {
    process.stderr.write('BOOTSTRAP_FAILED\n');
    process.exitCode = 1;
  }
}
