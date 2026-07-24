import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { AuthService, ServerSession } from '@aeostudio/application/auth';
import type { ChannelPackageService } from '@aeostudio/application/channels-publishing';
import { ProblemDetailsSchema, SCHEMA_VERSION } from '@aeostudio/contracts/auth';
import {
  BuildChannelPackageRequestSchema,
  ChannelPackageEnvelopeSchema,
  ChannelPackageExportSchema,
} from '@aeostudio/contracts/channels';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AUTH_SERVICE, AUTH_WEB_ORIGIN } from '../auth/auth.tokens.js';
import { CHANNEL_PACKAGE_SERVICE } from './channels.tokens.js';

@Controller('api/v1/tenants/:tenantId/workspaces/:workspaceId/channel-packages')
export class ChannelPackagesController {
  constructor(
    @Inject(AUTH_SERVICE) private readonly authService: AuthService,
    @Inject(AUTH_WEB_ORIGIN) private readonly webOrigin: string,
    @Inject(CHANNEL_PACKAGE_SERVICE) private readonly packages: ChannelPackageService,
  ) {}

  @Post()
  async build(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const authentication = await this.authenticatedMutation(request, reply);
    if (authentication === null) return this.authenticationProblem(request, reply);
    const parsed = BuildChannelPackageRequestSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return this.problem(request, 400, 'VALIDATION_ERROR', 'Channel Package input is invalid.');
    }
    const result = await this.packages.build({
      actorSubject: authentication.session.subject,
      sessionToken: authentication.sessionToken,
      tenantId,
      workspaceId,
      ...parsed.data,
    });
    if (result.outcome === 'NOT_FOUND') return this.notFoundProblem(request, reply);
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot build packages.');
    }
    if (result.outcome !== 'SUCCEEDED') {
      const code =
        result.outcome === 'APPROVAL_REQUIRED'
          ? 'APPROVAL_REQUIRED'
          : result.outcome === 'APPROVAL_STALE'
            ? 'APPROVAL_STALE'
            : result.outcome === 'HASH_MISMATCH'
              ? 'ARTIFACT_HASH_MISMATCH'
              : result.outcome === 'PAYLOAD_INTEGRITY_INVALID'
                ? 'ARTIFACT_PAYLOAD_INTEGRITY'
                : result.outcome;
      reply.code(409);
      return this.problem(
        request,
        409,
        code,
        'The exact approved Artifact cannot be transformed into this Channel Package.',
      );
    }
    reply.code(result.created ? 201 : 200);
    return ChannelPackageEnvelopeSchema.parse({
      data: { package: result.package },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Get(':packageId/export')
  async export(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('packageId') packageId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const token = request.cookies['__Host-aeo_session'];
    if (token === undefined) return this.authenticationProblem(request, reply);
    const session = await this.authService.getSession(token);
    if (session === null) return this.authenticationProblem(request, reply);
    const result = await this.packages.export({
      actorSubject: session.subject,
      sessionToken: token,
      tenantId,
      workspaceId,
      packageId,
    });
    if (result.outcome === 'NOT_FOUND') return this.notFoundProblem(request, reply);
    if (result.outcome === 'PAYLOAD_INTEGRITY_INVALID') {
      reply.code(409);
      return this.problem(
        request,
        409,
        'CHANNEL_PACKAGE_INTEGRITY_INVALID',
        'The immutable package payload failed integrity verification.',
      );
    }
    reply.header('content-type', 'application/vnd.aeostudio.channel-package+json');
    reply.header('content-disposition', `attachment; filename="channel-package-${packageId}.json"`);
    return ChannelPackageExportSchema.parse(result.package);
  }

  @Get(':packageId')
  async getPreview(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('packageId') packageId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const token = request.cookies['__Host-aeo_session'];
    if (token === undefined) return this.authenticationProblem(request, reply);
    const session = await this.authService.getSession(token);
    if (session === null) return this.authenticationProblem(request, reply);
    const result = await this.packages.getPreview({
      actorSubject: session.subject,
      sessionToken: token,
      tenantId,
      workspaceId,
      packageId,
    });
    if (result.outcome === 'NOT_FOUND') return this.notFoundProblem(request, reply);
    if (result.outcome === 'PAYLOAD_INTEGRITY_INVALID') {
      reply.code(409);
      return this.problem(
        request,
        409,
        'CHANNEL_PACKAGE_INTEGRITY_INVALID',
        'The immutable package payload failed integrity verification.',
      );
    }
    return ChannelPackageEnvelopeSchema.parse({
      data: { package: result.package },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  private async authenticatedMutation(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ session: ServerSession; sessionToken: string } | null> {
    if (request.headers.origin !== new URL(this.webOrigin).origin) {
      reply.code(403);
      return null;
    }
    const token = request.cookies['__Host-aeo_session'];
    if (token === undefined) return null;
    const session = await this.authService.getSession(token);
    return session === null ? null : { session, sessionToken: token };
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
