import { createHash } from 'node:crypto';

import type { AuthStore, LoginAttempt, ServerSession } from '@aeostudio/application/auth';
import type { Pool } from 'pg';

import type { SessionCipher } from '../session-cipher.js';

interface LoginAttemptRow {
  payload_ciphertext: string;
  expires_at: Date;
}

interface SessionRow {
  token_digest: string;
  identity_ciphertext: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  last_seen_at: Date;
}

export class PostgresAuthStore implements AuthStore {
  constructor(
    private readonly pool: Pool,
    private readonly cipher: SessionCipher,
  ) {}

  async saveLoginAttempt(attempt: LoginAttempt): Promise<void> {
    const payload = this.cipher.protect(
      JSON.stringify({
        state: attempt.state,
        nonce: attempt.nonce,
        codeVerifier: attempt.codeVerifier,
      }),
    );
    await this.pool.query(
      `INSERT INTO auth_login_attempts (token_digest, payload_ciphertext, expires_at)
       VALUES ($1, $2, $3)`,
      [attempt.tokenDigest, payload, attempt.expiresAt],
    );
  }

  async consumeLoginAttempt(tokenDigest: string, now: Date): Promise<LoginAttempt | null> {
    const result = await this.pool.query<LoginAttemptRow>(
      `DELETE FROM auth_login_attempts
       WHERE token_digest = $1 AND expires_at > $2
       RETURNING payload_ciphertext, expires_at`,
      [tokenDigest, now],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    const payload = JSON.parse(this.cipher.unprotect(row.payload_ciphertext)) as {
      state: string;
      nonce: string;
      codeVerifier: string;
    };
    return {
      tokenDigest,
      state: payload.state,
      nonce: payload.nonce,
      codeVerifier: payload.codeVerifier,
      expiresAt: row.expires_at,
    };
  }

  async saveSession(session: ServerSession): Promise<void> {
    const identity = this.cipher.protect(
      JSON.stringify({ subject: session.subject, email: session.email }),
    );
    const subjectDigest = createHash('sha256').update(session.subject, 'utf8').digest('hex');
    await this.pool.query(
      `INSERT INTO auth_sessions
         (token_digest, subject_digest, identity_ciphertext, created_at, expires_at, revoked_at,
           last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $4)`,
      [
        session.tokenDigest,
        subjectDigest,
        identity,
        session.createdAt,
        session.expiresAt,
        session.revokedAt,
      ],
    );
  }

  async findSession(
    tokenDigest: string,
    now: Date,
    idleCutoff: Date,
  ): Promise<ServerSession | null> {
    const result = await this.pool.query<SessionRow>(
      `UPDATE auth_sessions
       SET last_seen_at = CASE WHEN last_seen_at > $3 THEN $2 ELSE last_seen_at END,
           revoked_at = CASE
             WHEN last_seen_at <= $3 THEN COALESCE(revoked_at, $2)
             ELSE revoked_at
           END
       WHERE token_digest = $1
         AND revoked_at IS NULL
         AND expires_at > $2
       RETURNING token_digest, identity_ciphertext, created_at, expires_at, revoked_at,
         last_seen_at`,
      [tokenDigest, now, idleCutoff],
    );
    const row = result.rows[0];
    if (row === undefined || row.revoked_at !== null) {
      return null;
    }
    const identity = JSON.parse(this.cipher.unprotect(row.identity_ciphertext)) as {
      subject: string;
      email: string;
    };
    return {
      tokenDigest: row.token_digest,
      subject: identity.subject,
      email: identity.email,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
    };
  }

  async revokeSession(tokenDigest: string, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE auth_sessions
       SET revoked_at = COALESCE(revoked_at, $2)
       WHERE token_digest = $1`,
      [tokenDigest, now],
    );
  }
}
