import type {
  AuthorizationRequest,
  ExchangeCodeInput,
  OidcClient,
  OidcIdentity,
} from '@aeostudio/application/auth';
import * as client from 'openid-client';

export interface OpenIdClientAdapterConfiguration {
  issuerUrl: string;
  clientId: string;
  clientSecret?: string;
}

export class OpenIdClientAdapter implements OidcClient {
  private constructor(private readonly configuration: client.Configuration) {}

  static async discover(input: OpenIdClientAdapterConfiguration): Promise<OpenIdClientAdapter> {
    const configuration = await client.discovery(
      new URL(input.issuerUrl),
      input.clientId,
      input.clientSecret,
    );
    return new OpenIdClientAdapter(configuration);
  }

  createAuthorizationUrl(input: AuthorizationRequest): string {
    return client
      .buildAuthorizationUrl(this.configuration, new URLSearchParams(Object.entries(input)))
      .toString();
  }

  async exchangeCode(input: ExchangeCodeInput): Promise<OidcIdentity> {
    const callbackUrl = new URL(input.redirectUri);
    callbackUrl.searchParams.set('code', input.code);
    const tokens = await client.authorizationCodeGrant(this.configuration, callbackUrl, {
      expectedNonce: input.expectedNonce,
      pkceCodeVerifier: input.codeVerifier,
    });
    const claims = tokens.claims();
    if (
      claims === undefined ||
      typeof claims.sub !== 'string' ||
      typeof claims.email !== 'string' ||
      claims.email_verified !== true
    ) {
      throw new Error('OIDC_IDENTITY_CLAIMS_INVALID');
    }
    return {
      subject: claims.sub,
      email: claims.email,
      emailVerified: true,
    };
  }
}
