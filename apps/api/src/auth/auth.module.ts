import { randomBytes } from 'node:crypto';

import { Module, type DynamicModule } from '@nestjs/common';
import {
  AuthService,
  type AuthConfiguration,
  type AuthStore,
  type OidcClient,
} from '@aeostudio/application/auth';
import { FakeOidcClient } from '@aeostudio/adapters/identity';

import { AuthController } from './auth.controller.js';
import { InMemoryAuthStore } from './auth-store.memory.js';
import { AUTH_REDIRECT_URI, AUTH_SERVICE, AUTH_WEB_ORIGIN } from './auth.tokens.js';
import { FakeOidcController } from './fake-oidc.controller.js';

export interface AuthModuleOptions {
  authConfig?: Partial<AuthConfiguration>;
  now?: () => Date;
  oidcClient?: OidcClient;
  randomToken?: () => string;
  store?: AuthStore;
  webOrigin?: string;
}

class MissingOidcClient implements OidcClient {
  createAuthorizationUrl(): string {
    throw new Error('OIDC client is not configured');
  }

  exchangeCode(): Promise<never> {
    return Promise.reject(new Error('OIDC client is not configured'));
  }
}

@Module({})
export class AuthModule {
  static register(options: AuthModuleOptions = {}): DynamicModule {
    const fakeMode = options.oidcClient === undefined && process.env.AEOSTUDIO_AUTH_MODE === 'fake';
    const oidcClient =
      options.oidcClient ??
      (fakeMode
        ? new FakeOidcClient('http://127.0.0.1:3200/__test/oidc/authorize')
        : new MissingOidcClient());
    const store = options.store ?? new InMemoryAuthStore();
    const clock = { now: options.now ?? (() => new Date()) };
    const tokenGenerator = {
      next: options.randomToken ?? (() => randomBytes(32).toString('base64url')),
    };
    const config: AuthConfiguration = {
      clientId: options.authConfig?.clientId ?? process.env.OIDC_CLIENT_ID ?? 'aeostudio-web',
      redirectUri:
        options.authConfig?.redirectUri ??
        process.env.OIDC_REDIRECT_URI ??
        'http://127.0.0.1:3200/api/v1/auth/callback',
      scope: options.authConfig?.scope ?? 'openid email profile',
    };

    return {
      global: true,
      module: AuthModule,
      controllers: fakeMode ? [AuthController, FakeOidcController] : [AuthController],
      providers: [
        {
          provide: AUTH_SERVICE,
          useValue: new AuthService(oidcClient, store, clock, tokenGenerator, config),
        },
        {
          provide: AUTH_WEB_ORIGIN,
          useValue: options.webOrigin ?? process.env.WEB_ORIGIN ?? 'http://127.0.0.1:3100',
        },
        {
          provide: AUTH_REDIRECT_URI,
          useValue: config.redirectUri,
        },
      ],
      exports: [AUTH_SERVICE, AUTH_WEB_ORIGIN],
    };
  }
}
