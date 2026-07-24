import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AesGcmSessionCipher, PostgresAuthStore, runMigrations } from '@aeostudio/db';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

describe('Task 1 PostgreSQL auth repository', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.3-alpine3.23').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  test('login attempts are consumed once and revoked sessions cannot be read', async () => {
    const migrationsDirectory = fileURLToPath(
      new URL('../../packages/db/migrations', import.meta.url),
    );
    await runMigrations(pool, migrationsDirectory);
    const store = new PostgresAuthStore(pool, new AesGcmSessionCipher(Buffer.alloc(32, 7)));
    const now = new Date('2026-07-20T10:00:00.000Z');

    await store.saveLoginAttempt({
      tokenDigest: 'login-digest',
      state: 'state',
      nonce: 'nonce',
      codeVerifier: 'verifier',
      expiresAt: new Date('2026-07-20T10:10:00.000Z'),
    });
    await expect(store.consumeLoginAttempt('login-digest', now)).resolves.toMatchObject({
      state: 'state',
      nonce: 'nonce',
      codeVerifier: 'verifier',
    });
    await expect(store.consumeLoginAttempt('login-digest', now)).resolves.toBeNull();

    await store.saveSession({
      tokenDigest: 'session-digest',
      subject: 'encrypted-at-adapter-boundary',
      email: 'owner@example.test',
      createdAt: now,
      expiresAt: new Date('2026-07-20T18:00:00.000Z'),
      revokedAt: null,
    });
    await expect(
      store.findSession('session-digest', now, new Date('2026-07-20T09:30:00.000Z')),
    ).resolves.toMatchObject({
      email: 'owner@example.test',
      revokedAt: null,
    });
    const stored = await pool.query<{ identity_ciphertext: string }>(
      'SELECT identity_ciphertext FROM auth_sessions WHERE token_digest = $1',
      ['session-digest'],
    );
    expect(stored.rows[0]?.identity_ciphertext).not.toContain('owner@example.test');
    expect(stored.rows[0]?.identity_ciphertext).not.toContain('oidc-subject');
    await store.revokeSession('session-digest', new Date('2026-07-20T10:01:00.000Z'));
    await expect(
      store.findSession('session-digest', now, new Date('2026-07-20T09:30:00.000Z')),
    ).resolves.toBeNull();
  });

  test('idle lookup atomically touches active sessions and revokes stale ones', async () => {
    const store = new PostgresAuthStore(pool, new AesGcmSessionCipher(Buffer.alloc(32, 9)));
    const createdAt = new Date('2026-07-20T10:00:00.000Z');
    await store.saveSession({
      tokenDigest: 'sliding-session-digest',
      subject: 'sliding-subject',
      email: 'sliding@example.test',
      createdAt,
      expiresAt: new Date('2026-07-20T18:00:00.000Z'),
      revokedAt: null,
    });

    const firstActivity = new Date('2026-07-20T10:29:00.000Z');
    await expect(
      store.findSession(
        'sliding-session-digest',
        firstActivity,
        new Date('2026-07-20T09:59:00.000Z'),
      ),
    ).resolves.toMatchObject({ email: 'sliding@example.test' });
    await expect(
      pool.query<{ last_seen_at: Date }>(
        'SELECT last_seen_at FROM auth_sessions WHERE token_digest = $1',
        ['sliding-session-digest'],
      ),
    ).resolves.toMatchObject({
      rows: [{ last_seen_at: firstActivity }],
    });

    await expect(
      store.findSession(
        'sliding-session-digest',
        new Date('2026-07-20T11:00:00.000Z'),
        new Date('2026-07-20T10:30:00.000Z'),
      ),
    ).resolves.toBeNull();
    await expect(
      pool.query<{ revoked_at: Date | null }>(
        'SELECT revoked_at FROM auth_sessions WHERE token_digest = $1',
        ['sliding-session-digest'],
      ),
    ).resolves.toMatchObject({
      rows: [{ revoked_at: new Date('2026-07-20T11:00:00.000Z') }],
    });
  });
});
