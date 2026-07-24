import { createHash } from 'node:crypto';

import type {
  AuthClock,
  AuthStore,
  AuthTokenGenerator,
  OidcClient,
  ServerSession,
} from './ports.js';

export interface AuthConfiguration {
  clientId: string;
  redirectUri: string;
  scope: string;
}

export interface StartLoginResult {
  authorizationUrl: string;
  loginToken: string;
  expiresAt: Date;
}

export interface CompleteLoginInput {
  code: string;
  loginToken: string;
  state: string;
}

export interface CompleteLoginResult {
  email: string;
  expiresAt: Date;
  sessionToken: string;
}

const LOGIN_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

export class AuthService {
  constructor(
    private readonly oidcClient: OidcClient,
    private readonly store: AuthStore,
    private readonly clock: AuthClock,
    private readonly tokenGenerator: AuthTokenGenerator,
    private readonly config: AuthConfiguration,
  ) {}

  async startLogin(input: { loginHint?: string } = {}): Promise<StartLoginResult> {
    const loginToken = this.tokenGenerator.next();
    const state = this.tokenGenerator.next();
    const nonce = this.tokenGenerator.next();
    const codeVerifier = this.tokenGenerator.next();
    const expiresAt = new Date(this.clock.now().getTime() + LOGIN_TTL_MS);

    await this.store.saveLoginAttempt({
      tokenDigest: sha256Base64Url(loginToken),
      state,
      nonce,
      codeVerifier,
      expiresAt,
    });

    return {
      authorizationUrl: this.oidcClient.createAuthorizationUrl({
        client_id: this.config.clientId,
        code_challenge: sha256Base64Url(codeVerifier),
        code_challenge_method: 'S256',
        nonce,
        redirect_uri: this.config.redirectUri,
        response_type: 'code',
        scope: this.config.scope,
        state,
        ...(input.loginHint === undefined ? {} : { login_hint: input.loginHint }),
      }),
      loginToken,
      expiresAt,
    };
  }

  async completeLogin(input: CompleteLoginInput): Promise<CompleteLoginResult> {
    const now = this.clock.now();
    const attempt = await this.store.consumeLoginAttempt(sha256Base64Url(input.loginToken), now);
    if (attempt === null || attempt.state !== input.state) {
      throw new AuthFlowError(
        'LOGIN_TRANSACTION_INVALID',
        'The login transaction is invalid or expired.',
      );
    }

    const identity = await this.oidcClient.exchangeCode({
      code: input.code,
      codeVerifier: attempt.codeVerifier,
      expectedNonce: attempt.nonce,
      redirectUri: this.config.redirectUri,
    });
    if (!identity.emailVerified) {
      throw new AuthFlowError('EMAIL_NOT_VERIFIED', 'The identity email must be verified.');
    }

    const sessionToken = this.tokenGenerator.next();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await this.store.saveSession({
      tokenDigest: sha256Base64Url(sessionToken),
      subject: identity.subject,
      email: identity.email,
      createdAt: now,
      expiresAt,
      revokedAt: null,
    });

    return { email: identity.email, expiresAt, sessionToken };
  }

  async getSession(sessionToken: string): Promise<ServerSession | null> {
    const now = this.clock.now();
    return this.store.findSession(
      sha256Base64Url(sessionToken),
      now,
      new Date(now.getTime() - SESSION_IDLE_TTL_MS),
    );
  }

  async revokeSession(sessionToken: string): Promise<void> {
    await this.store.revokeSession(sha256Base64Url(sessionToken), this.clock.now());
  }
}

export class AuthFlowError extends Error {
  constructor(
    public readonly code: 'LOGIN_TRANSACTION_INVALID' | 'EMAIL_NOT_VERIFIED',
    message: string,
  ) {
    super(message);
    this.name = 'AuthFlowError';
  }
}
