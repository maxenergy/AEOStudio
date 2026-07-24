import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { AuthService, ServerSession } from '@aeostudio/application/auth';
import type { ChannelAuthorizationService } from '@aeostudio/application/channels-publishing';
import { ProblemDetailsSchema, SCHEMA_VERSION } from '@aeostudio/contracts/auth';
import {
  ChannelAuthorizationEnvelopeSchema,
  ChannelAuthorizationPathParamsSchema,
  ChannelAuthorizationListEnvelopeSchema,
  CreateChannelAuthorizationRequestSchema,
  RevokeChannelAuthorizationRequestSchema,
} from '@aeostudio/contracts/channels';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AUTH_SERVICE, AUTH_WEB_ORIGIN } from '../auth/auth.tokens.js';
import { CHANNEL_AUTHORIZATION_SERVICE } from './channels.tokens.js';

@Controller('api/v1/tenants/:tenantId/workspaces/:workspaceId/channel-authorizations')
export class ChannelAuthorizationsController {
  constructor(
    @Inject(AUTH_SERVICE) private readonly authService: AuthService,
    @Inject(AUTH_WEB_ORIGIN) private readonly webOrigin: string,
    @Inject(CHANNEL_AUTHORIZATION_SERVICE)
    private readonly authorizations: ChannelAuthorizationService,
  ) {}

  @Post()
  async create(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const session = await this.authenticatedMutation(request, reply);
    if (session === null) return this.authenticationProblem(request, reply);
    const parsed = CreateChannelAuthorizationRequestSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return this.problem(
        request,
        400,
        'VALIDATION_ERROR',
        'Channel authorization input is invalid.',
      );
    }
    const { expiresAt, ...authorizationInput } = parsed.data;
    const result = await this.authorizations.create({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
      ...authorizationInput,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
    if (result.outcome === 'NOT_FOUND') return this.notFoundProblem(request, reply);
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(
        request,
        403,
        'FORBIDDEN',
        'The active role cannot manage Channel authorizations.',
      );
    }
    if (result.outcome === 'ADAPTER_NOT_FOUND') {
      reply.code(404);
      return this.problem(request, 404, 'ADAPTER_NOT_FOUND', 'Adapter version not found.');
    }
    reply.code(201);
    return ChannelAuthorizationEnvelopeSchema.parse({
      data: { authorization: toContract(result.authorization) },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Get()
  async list(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const token = request.cookies['__Host-aeo_session'];
    const session = token === undefined ? null : await this.authService.getSession(token);
    if (session === null) return this.authenticationProblem(request, reply);
    const result = await this.authorizations.list({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
    });
    if (result.outcome === 'NOT_FOUND') return this.notFoundProblem(request, reply);
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(
        request,
        403,
        'FORBIDDEN',
        'The active role cannot view Channel authorizations.',
      );
    }
    return ChannelAuthorizationListEnvelopeSchema.parse({
      data: { authorizations: result.authorizations.map(toContract) },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post(':authorizationId/revoke')
  async revoke(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('authorizationId') authorizationId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const session = await this.authenticatedMutation(request, reply);
    if (session === null) return this.authenticationProblem(request, reply);
    const parsedPath = ChannelAuthorizationPathParamsSchema.safeParse({ authorizationId });
    if (!parsedPath.success) return this.notFoundProblem(request, reply);
    const parsed = RevokeChannelAuthorizationRequestSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return this.problem(
        request,
        400,
        'VALIDATION_ERROR',
        'Channel authorization revoke input is invalid.',
      );
    }
    const result = await this.authorizations.revoke({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
      authorizationId: parsedPath.data.authorizationId,
    });
    if (result.outcome === 'NOT_FOUND') return this.notFoundProblem(request, reply);
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(
        request,
        403,
        'FORBIDDEN',
        'The active role cannot manage Channel authorizations.',
      );
    }
    reply.code(200);
    return ChannelAuthorizationEnvelopeSchema.parse({
      data: { authorization: toContract(result.authorization) },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  private async authenticatedMutation(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<ServerSession | null> {
    if (request.headers.origin !== new URL(this.webOrigin).origin) {
      reply.code(403);
      return null;
    }
    const token = request.cookies['__Host-aeo_session'];
    return token === undefined ? null : this.authService.getSession(token);
  }

  private authenticationProblem(request: FastifyRequest, reply: FastifyReply) {
    if (reply.statusCode === 403) {
      return this.problem(request, 403, 'CSRF_REJECTED', 'The request origin is not allowed.');
    }
    reply.code(401);
    return this.problem(request, 401, 'UNAUTHENTICATED', 'A valid session is required.');
  }

  private notFoundProblem(request: FastifyRequest, reply: FastifyReply) {
    reply.code(404);
    return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
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

function toContract(input: {
  id: string;
  adapterVersionId: string;
  status: 'ACTIVE' | 'REVOKED';
  target: string;
  grantedScopes: string[];
  acceptedTermsVersion: string;
  expiresAt: string | null;
  validationStatus: 'PENDING_VALIDATION' | 'VERIFIED' | 'INVALID';
  validationSnapshot: {
    actualTarget: string;
    actualScopes: string[];
    acceptedTermsVersion: string;
    validatedAt: string;
    validUntil: string;
  } | null;
  validationFailureCode: string | null;
  secretConfigured: true;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    id: input.id,
    adapterVersionId: input.adapterVersionId,
    status: input.status,
    target: input.target,
    grantedScopes: input.grantedScopes,
    acceptedTermsVersion: input.acceptedTermsVersion,
    expiresAt: input.expiresAt,
    validationStatus: input.validationStatus,
    validationSnapshot: input.validationSnapshot,
    validationFailureCode: input.validationFailureCode,
    secretConfigured: input.secretConfigured,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}
