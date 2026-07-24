import type { AuthStore, LoginAttempt, ServerSession } from '@aeostudio/application/auth';

import type { InMemoryAuditSink } from '../privacy/in-memory-audit-sink.js';

export class InMemoryAuthStore implements AuthStore {
  private readonly loginAttempts = new Map<string, LoginAttempt>();
  private readonly sessions = new Map<string, ServerSession & { lastSeenAt: Date }>();

  public constructor(private readonly audit?: InMemoryAuditSink) {}

  saveLoginAttempt(attempt: LoginAttempt): Promise<void> {
    this.loginAttempts.set(attempt.tokenDigest, structuredClone(attempt));
    return Promise.resolve();
  }

  consumeLoginAttempt(tokenDigest: string, now: Date): Promise<LoginAttempt | null> {
    const attempt = this.loginAttempts.get(tokenDigest);
    this.loginAttempts.delete(tokenDigest);
    if (attempt === undefined || attempt.expiresAt <= now) {
      return Promise.resolve(null);
    }
    return Promise.resolve(structuredClone(attempt));
  }

  saveSession(session: ServerSession): Promise<void> {
    const created = !this.sessions.has(session.tokenDigest);
    this.sessions.set(
      session.tokenDigest,
      structuredClone({ ...session, lastSeenAt: session.createdAt }),
    );
    if (created) {
      this.audit?.appendForSubject({
        actorSubject: session.subject,
        actorKind: 'USER',
        action: 'AUTH_SESSION_STARTED',
        resourceType: 'AUTH_SESSION',
        resourceId: null,
        outcome: 'SUCCEEDED',
        occurredAt: session.createdAt,
      });
    }
    return Promise.resolve();
  }

  findSession(tokenDigest: string, now: Date, idleCutoff: Date): Promise<ServerSession | null> {
    const session = this.sessions.get(tokenDigest);
    if (session === undefined || session.revokedAt !== null || session.expiresAt <= now) {
      return Promise.resolve(null);
    }
    if (session.lastSeenAt <= idleCutoff) {
      this.sessions.set(tokenDigest, { ...session, revokedAt: now });
      this.appendSessionRevoked(session.subject, now);
      return Promise.resolve(null);
    }
    this.sessions.set(tokenDigest, { ...session, lastSeenAt: now });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructuring to omit lastSeenAt
    const { lastSeenAt: _lastSeenAt, ...publicSession } = session;
    return Promise.resolve(structuredClone(publicSession));
  }

  revokeSession(tokenDigest: string, now: Date): Promise<void> {
    const session = this.sessions.get(tokenDigest);
    if (session !== undefined && session.revokedAt === null) {
      this.sessions.set(tokenDigest, { ...session, revokedAt: now });
      this.appendSessionRevoked(session.subject, now);
    }
    return Promise.resolve();
  }

  /** Tenant lifecycle administration boundary; never returns session payloads. */
  revokeSessionsForSubjects(subjects: readonly string[], now: Date): Promise<number> {
    const subjectSet = new Set(subjects);
    let revoked = 0;
    for (const [tokenDigest, session] of this.sessions) {
      if (subjectSet.has(session.subject) && session.revokedAt === null) {
        this.sessions.set(tokenDigest, { ...session, revokedAt: now });
        this.appendSessionRevoked(session.subject, now);
        revoked += 1;
      }
    }
    return Promise.resolve(revoked);
  }

  private appendSessionRevoked(actorSubject: string, revokedAt: Date): void {
    this.audit?.appendForSubject({
      actorSubject,
      actorKind: 'USER',
      action: 'AUTH_SESSION_REVOKED',
      resourceType: 'AUTH_SESSION',
      resourceId: null,
      outcome: 'SUCCEEDED',
      occurredAt: revokedAt,
    });
  }
}
