import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { AuthService } from '@aeostudio/application/auth';
import type { WebsiteImportService } from '@aeostudio/application/import';
import { ProblemDetailsSchema, SCHEMA_VERSION } from '@aeostudio/contracts/auth';
import {
  WebsiteImportConfirmEnvelopeSchema,
  WebsiteImportConfirmRequestSchema,
  WebsiteImportEnvelopeSchema,
  WebsiteImportRequestSchema,
} from '@aeostudio/contracts/import';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AUTH_SERVICE, AUTH_WEB_ORIGIN } from '../auth/auth.tokens.js';
import { WEBSITE_IMPORT_SERVICE } from './import-website.tokens.js';

@Controller('api/v1/tenants/:tenantId/workspaces/:workspaceId')
export class ImportWebsiteController {
  constructor(
    @Inject(AUTH_SERVICE) private readonly authService: AuthService,
    @Inject(AUTH_WEB_ORIGIN) private readonly webOrigin: string,
    @Inject(WEBSITE_IMPORT_SERVICE) private readonly importService: WebsiteImportService,
  ) {}

  @Post('import/website')
  async startImport(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    if (request.headers.origin !== new URL(this.webOrigin).origin) {
      reply.code(403);
      return this.problem(request, 403, 'CSRF_REJECTED', 'The request origin is not allowed.');
    }
    const token = request.cookies['__Host-aeo_session'];
    const session = token === undefined ? null : await this.authService.getSession(token);
    if (session === null) {
      reply.code(401);
      return this.problem(request, 401, 'UNAUTHENTICATED', 'A valid server session is required.');
    }
    const parsed = WebsiteImportRequestSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return {
        ...this.problem(request, 400, 'VALIDATION_ERROR', 'Website import request is invalid.'),
        errors: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
          message: issue.message,
        })),
      };
    }

    const result = await this.importService.startImport({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
      url: parsed.data.url,
    });
    if (result.outcome === 'NOT_FOUND') {
      reply.code(404);
      return this.problem(
        request,
        404,
        'NOT_FOUND_OR_FORBIDDEN',
        'The requested resource was not found.',
      );
    }
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot import website data.');
    }
    if (result.outcome === 'INVALID_URL') {
      reply.code(400);
      return this.problem(request, 400, 'INVALID_URL', 'The provided URL is not valid.');
    }

    reply.code(201);
    return WebsiteImportEnvelopeSchema.parse({
      data: { websiteImport: result.session },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Get('import/website/:importId')
  async getImport(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('importId') importId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const token = request.cookies['__Host-aeo_session'];
    const session = token === undefined ? null : await this.authService.getSession(token);
    if (session === null) {
      reply.code(401);
      return this.problem(request, 401, 'UNAUTHENTICATED', 'A valid server session is required.');
    }
    const result = await this.importService.getSession({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
      importId,
    });
    if (result.outcome === 'NOT_FOUND') {
      reply.code(404);
      return this.problem(
        request,
        404,
        'NOT_FOUND_OR_FORBIDDEN',
        'The import session was not found.',
      );
    }
    return WebsiteImportEnvelopeSchema.parse({
      data: { websiteImport: result.session },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post('import/website/:importId/confirm')
  async confirmImport(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('importId') importId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    if (request.headers.origin !== new URL(this.webOrigin).origin) {
      reply.code(403);
      return this.problem(request, 403, 'CSRF_REJECTED', 'The request origin is not allowed.');
    }
    const token = request.cookies['__Host-aeo_session'];
    const session = token === undefined ? null : await this.authService.getSession(token);
    if (session === null) {
      reply.code(401);
      return this.problem(request, 401, 'UNAUTHENTICATED', 'A valid server session is required.');
    }
    const parsed = WebsiteImportConfirmRequestSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return {
        ...this.problem(
          request,
          400,
          'VALIDATION_ERROR',
          'Website import confirmation is invalid.',
        ),
        errors: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
          message: issue.message,
        })),
      };
    }

    const result = await this.importService.confirmImport({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
      importId,
      createProfile: parsed.data.createProfile,
      offeringCandidateIds: parsed.data.offeringCandidateIds,
    });
    if (result.outcome === 'NOT_FOUND') {
      reply.code(404);
      return this.problem(
        request,
        404,
        'NOT_FOUND_OR_FORBIDDEN',
        'The import session was not found.',
      );
    }
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot confirm imports.');
    }

    reply.code(201);
    return WebsiteImportConfirmEnvelopeSchema.parse({
      data: {
        importId: result.importId,
        profileId: result.profileId,
        offeringIds: result.offeringIds,
        pendingFaqs: result.pendingFaqs,
      },
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
