import { Controller, Get, Inject, Query, Req, Res } from '@nestjs/common';
import { ProblemDetailsSchema } from '@aeostudio/contracts/auth';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AUTH_REDIRECT_URI } from './auth.tokens.js';

@Controller('__test/oidc')
export class FakeOidcController {
  constructor(@Inject(AUTH_REDIRECT_URI) private readonly allowedRedirectUri: string) {}

  @Get('authorize')
  async authorize(
    @Query('redirect_uri') redirectUri: string | undefined,
    @Query('state') state: string | undefined,
    @Query('login_hint') loginHint: string | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (redirectUri !== this.allowedRedirectUri || state === undefined) {
      reply.code(400).send(
        ProblemDetailsSchema.parse({
          type: 'https://aeostudio.local/problems/fake-oidc-request-invalid',
          title: 'Request rejected',
          status: 400,
          code: 'FAKE_OIDC_REQUEST_INVALID',
          detail: 'The local OIDC fixture request is invalid.',
          requestId: request.id,
          retryable: false,
        }),
      );
      return;
    }
    const callback = new URL(redirectUri);
    const code =
      loginHint === 'editor@example.test'
        ? 'fake-code-editor'
        : loginHint === 'reviewer@example.test'
          ? 'fake-code-reviewer'
          : loginHint === 'publisher@example.test'
            ? 'fake-code-publisher'
            : 'fake-code';
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', state);
    await reply.redirect(callback.toString(), 302);
  }
}
