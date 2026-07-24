export interface AuthorizationRequest {
  client_id: string;
  code_challenge: string;
  code_challenge_method: 'S256';
  nonce: string;
  redirect_uri: string;
  response_type: 'code';
  scope: string;
  state: string;
  login_hint?: string;
}

export interface OidcIdentity {
  subject: string;
  email: string;
  emailVerified: boolean;
}

export interface ExchangeCodeInput {
  code: string;
  codeVerifier: string;
  expectedNonce: string;
  redirectUri: string;
}

export interface OidcClient {
  createAuthorizationUrl(input: AuthorizationRequest): string;
  exchangeCode(input: ExchangeCodeInput): Promise<OidcIdentity>;
}

export interface LoginAttempt {
  tokenDigest: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: Date;
}

export interface ServerSession {
  tokenDigest: string;
  subject: string;
  email: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface AuthStore {
  saveLoginAttempt(attempt: LoginAttempt): Promise<void>;
  consumeLoginAttempt(tokenDigest: string, now: Date): Promise<LoginAttempt | null>;
  saveSession(session: ServerSession): Promise<void>;
  findSession(tokenDigest: string, now: Date, idleCutoff: Date): Promise<ServerSession | null>;
  revokeSession(tokenDigest: string, now: Date): Promise<void>;
}

export interface AuthClock {
  now(): Date;
}

export interface AuthTokenGenerator {
  next(): string;
}
