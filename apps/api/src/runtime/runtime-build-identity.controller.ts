import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import type { RuntimeBuildIdentity } from '@aeostudio/adapters';
import type { AuthService } from '@aeostudio/application/auth';
import {
  ProblemDetailsSchema,
  RuntimeBuildIdentityEnvelopeSchema,
  SCHEMA_VERSION,
} from '@aeostudio/contracts/auth';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AUTH_SERVICE } from '../auth/auth.tokens.js';
import { RUNTIME_BUILD_IDENTITY } from './runtime.tokens.js';

@Controller('api/v1/runtime')
export class RuntimeBuildIdentityController {
  constructor(
    @Inject(AUTH_SERVICE) private readonly authService: AuthService,
    @Inject(RUNTIME_BUILD_IDENTITY)
    private readonly identity: RuntimeBuildIdentity | null,
  ) {}

  @Get('build-identity')
  async get(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const token = request.cookies['__Host-aeo_session'];
    const session = token === undefined ? null : await this.authService.getSession(token);
    if (session === null) {
      reply.code(401);
      return this.problem(request, 401, 'UNAUTHENTICATED', 'A valid server session is required.');
    }
    if (this.identity === null) {
      reply.code(503);
      return this.problem(
        request,
        503,
        'RUNTIME_BUILD_IDENTITY_UNAVAILABLE',
        'Task-local runtime build identity is unavailable.',
      );
    }
    return RuntimeBuildIdentityEnvelopeSchema.parse({
      data: { identity: this.identity },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  private problem(
    request: FastifyRequest,
    status: number,
    code: string,
    detail: string,
  ): Record<string, unknown> {
    return ProblemDetailsSchema.parse({
      type: `https://aeostudio.local/problems/${code.toLowerCase().replaceAll('_', '-')}`,
      title: status === 401 ? 'Authentication required' : 'Runtime identity unavailable',
      status,
      code,
      detail,
      requestId: request.id,
      retryable: status === 503,
    });
  }
}
