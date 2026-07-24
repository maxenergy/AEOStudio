import { Controller, Get, Inject, Param, Req, Res } from '@nestjs/common';
import type { AuthService } from '@aeostudio/application/auth';
import type { ChannelRegistryService } from '@aeostudio/application/channels-publishing';
import { ProblemDetailsSchema, SCHEMA_VERSION } from '@aeostudio/contracts/auth';
import { ChannelRegistryEnvelopeSchema } from '@aeostudio/contracts/channels';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AUTH_SERVICE } from '../auth/auth.tokens.js';
import { CHANNEL_REGISTRY_SERVICE } from './channels.tokens.js';

@Controller('api/v1/tenants/:tenantId/workspaces/:workspaceId/channels')
export class ChannelsController {
  constructor(
    @Inject(AUTH_SERVICE) private readonly authService: AuthService,
    @Inject(CHANNEL_REGISTRY_SERVICE) private readonly registry: ChannelRegistryService,
  ) {}

  @Get()
  async list(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const token = request.cookies['__Host-aeo_session'];
    const session = token === undefined ? null : await this.authService.getSession(token);
    if (session === null) {
      reply.code(401);
      return this.problem(request, 401, 'UNAUTHENTICATED', 'A valid session is required.');
    }

    const entries = await this.registry.listRegistry({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
    });
    if (entries === null) {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    return ChannelRegistryEnvelopeSchema.parse({
      data: { entries },
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
      title: status === 401 ? 'Authentication required' : 'Request rejected',
      status,
      code,
      detail,
      requestId: request.id,
      retryable: false,
    });
  }
}
