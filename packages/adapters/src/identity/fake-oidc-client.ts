import type {
  AuthorizationRequest,
  ExchangeCodeInput,
  OidcClient,
  OidcIdentity,
} from '@aeostudio/application/auth';

export class FakeOidcClient implements OidcClient {
  constructor(private readonly authorizationEndpoint: string) {}

  createAuthorizationUrl(input: AuthorizationRequest): string {
    const url = new URL(this.authorizationEndpoint);
    url.searchParams.set('client_id', input.client_id);
    url.searchParams.set('code_challenge', input.code_challenge);
    url.searchParams.set('code_challenge_method', input.code_challenge_method);
    url.searchParams.set('nonce', input.nonce);
    url.searchParams.set('redirect_uri', input.redirect_uri);
    url.searchParams.set('response_type', input.response_type);
    url.searchParams.set('scope', input.scope);
    url.searchParams.set('state', input.state);
    if (input.login_hint !== undefined) url.searchParams.set('login_hint', input.login_hint);
    return url.toString();
  }

  exchangeCode(input: ExchangeCodeInput): Promise<OidcIdentity> {
    if (
      input.codeVerifier.length === 0 ||
      input.expectedNonce.length === 0 ||
      input.redirectUri.length === 0
    ) {
      return Promise.reject(new Error('The deterministic fake OIDC exchange was rejected.'));
    }
    const identity =
      input.code === 'fake-code-editor'
        ? { subject: 'fake-editor-subject', email: 'editor@example.test' }
        : input.code === 'fake-code-reviewer'
          ? { subject: 'fake-reviewer-subject', email: 'reviewer@example.test' }
          : input.code === 'fake-code-publisher'
            ? { subject: 'fake-publisher-subject', email: 'publisher@example.test' }
            : input.code === 'fake-code-brief-reviewer'
              ? { subject: 'fake-brief-reviewer-subject', email: 'brief-reviewer@example.test' }
              : input.code === 'fake-code'
                ? { subject: 'fake-cognito-subject', email: 'owner@example.test' }
                : null;
    if (identity === null) {
      return Promise.reject(new Error('The deterministic fake OIDC exchange was rejected.'));
    }
    return Promise.resolve({ ...identity, emailVerified: true });
  }
}
