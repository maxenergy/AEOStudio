import { Controller, Get, Inject, Post, Query, Req, Res } from '@nestjs/common';
import { AuthFlowError, type AuthService } from '@aeostudio/application/auth';
import {
  ProblemDetailsSchema,
  SCHEMA_VERSION,
  SessionEnvelopeSchema,
} from '@aeostudio/contracts/auth';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AUTH_SERVICE, AUTH_WEB_ORIGIN } from './auth.tokens.js';

@Controller('api/v1/auth')
export class AuthController {
  constructor(
    @Inject(AUTH_SERVICE) private readonly authService: AuthService,
    @Inject(AUTH_WEB_ORIGIN) private readonly webOrigin: string,
  ) {}

  @Get('login')
  async login(
    @Query('login_hint') loginHint: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const normalizedHint =
      loginHint === undefined || loginHint.trim().length === 0 || loginHint.length > 254
        ? undefined
        : loginHint.trim();
    const result = await this.authService.startLogin({
      ...(normalizedHint === undefined ? {} : { loginHint: normalizedHint }),
    });
    reply.setCookie('__Host-aeo_login', result.loginToken, {
      expires: result.expiresAt,
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      secure: true,
    });
    await reply.redirect(result.authorizationUrl, 302);
  }

  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const loginToken = request.cookies['__Host-aeo_login'];
    if (loginToken === undefined || code === undefined || state === undefined) {
      this.sendLoginProblem(request, reply, 'LOGIN_TRANSACTION_INVALID');
      return;
    }

    try {
      const result = await this.authService.completeLogin({ code, loginToken, state });
      reply.clearCookie('__Host-aeo_login', {
        httpOnly: true,
        path: '/',
        sameSite: 'lax',
        secure: true,
      });
      reply.setCookie('__Host-aeo_session', result.sessionToken, {
        expires: result.expiresAt,
        httpOnly: true,
        path: '/',
        sameSite: 'lax',
        secure: true,
      });
      await reply.redirect(new URL('/app', this.webOrigin).toString(), 302);
    } catch (error) {
      if (error instanceof AuthFlowError) {
        this.sendLoginProblem(request, reply, error.code);
        return;
      }
      throw error;
    }
  }

  @Get('session')
  async getSession(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const token = request.cookies['__Host-aeo_session'];
    const session = token === undefined ? null : await this.authService.getSession(token);
    if (session === null) {
      reply.code(401);
      return this.problem(request, 401, 'UNAUTHENTICATED', 'A valid server session is required.');
    }

    return SessionEnvelopeSchema.parse({
      data: {
        email: session.email,
        expiresAt: session.expiresAt.toISOString(),
      },
      meta: {
        requestId: request.id,
        schemaVersion: SCHEMA_VERSION,
      },
    });
  }

  @Post('logout')
  async logout(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    if (request.headers.origin !== new URL(this.webOrigin).origin) {
      reply
        .code(403)
        .send(this.problem(request, 403, 'CSRF_REJECTED', 'The request origin is not allowed.'));
      return;
    }
    const token = request.cookies['__Host-aeo_session'];
    if (token !== undefined) {
      await this.authService.revokeSession(token);
    }
    reply.clearCookie('__Host-aeo_session', {
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      secure: true,
    });
    reply.code(204).send();
  }

  private sendLoginProblem(request: FastifyRequest, reply: FastifyReply, code: string): void {
    reply.code(400).send(this.problem(request, 400, code, 'The login transaction is invalid.'));
  }

  private problem(
    request: FastifyRequest,
    status: number,
    code: string,
    detail: string,
  ): Record<string, unknown> {
    return ProblemDetailsSchema.parse({
      type: `https://aeostudio.local/problems/${code.toLowerCase().replaceAll('_', '-')}`,
      title: status === 401 ? 'Authentication required' : 'Login failed',
      status,
      code,
      detail,
      requestId: request.id,
      retryable: false,
    });
  }
}
