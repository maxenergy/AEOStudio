import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { AuthService } from '@aeostudio/application/auth';
import type { ProfileOfferingService } from '@aeostudio/application/profile-offering';
import { ProblemDetailsSchema, SCHEMA_VERSION } from '@aeostudio/contracts/auth';
import {
  OfferingEnvelopeSchema,
  OfferingInputSchema,
  ProfileEnvelopeSchema,
  ProfileInputSchema,
} from '@aeostudio/contracts/profile-offering';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AUTH_SERVICE, AUTH_WEB_ORIGIN } from '../auth/auth.tokens.js';
import { PROFILE_OFFERING_SERVICE } from './profile-offering.tokens.js';

@Controller('api/v1/tenants/:tenantId/workspaces/:workspaceId')
export class ProfileOfferingController {
  constructor(
    @Inject(AUTH_SERVICE) private readonly authService: AuthService,
    @Inject(AUTH_WEB_ORIGIN) private readonly webOrigin: string,
    @Inject(PROFILE_OFFERING_SERVICE)
    private readonly profileOfferingService: ProfileOfferingService,
  ) {}

  @Post('profiles')
  async createProfile(
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
    const parsed = ProfileInputSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return {
        ...this.problem(request, 400, 'VALIDATION_ERROR', 'Profile input is invalid.'),
        errors: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
          message: issue.message,
        })),
      };
    }

    const result = await this.profileOfferingService.createProfile({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
      content: parsed.data,
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
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot edit profiles.');
    }

    reply.code(201);
    return ProfileEnvelopeSchema.parse({
      data: { profile: result.profile },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post('profiles/:profileId/revisions')
  async createProfileRevision(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('profileId') profileId: string,
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
    const parsed = ProfileInputSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return {
        ...this.problem(request, 400, 'VALIDATION_ERROR', 'Profile input is invalid.'),
        errors: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
          message: issue.message,
        })),
      };
    }
    const result = await this.profileOfferingService.createProfileRevision({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
      profileId,
      content: parsed.data,
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
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot edit profiles.');
    }
    reply.code(201);
    return ProfileEnvelopeSchema.parse({
      data: { profile: result.profile },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Get('profiles/:profileId/revisions/:revision')
  async getProfileRevision(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('profileId') profileId: string,
    @Param('revision') revisionInput: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const token = request.cookies['__Host-aeo_session'];
    const session = token === undefined ? null : await this.authService.getSession(token);
    if (session === null) {
      reply.code(401);
      return this.problem(request, 401, 'UNAUTHENTICATED', 'A valid server session is required.');
    }
    const revision = Number(revisionInput);
    const profile =
      Number.isSafeInteger(revision) && revision > 0
        ? await this.profileOfferingService.getProfileRevision({
            actorSubject: session.subject,
            tenantId,
            workspaceId,
            profileId,
            revision,
          })
        : null;
    if (profile === null) {
      reply.code(404);
      return this.problem(
        request,
        404,
        'NOT_FOUND_OR_FORBIDDEN',
        'The requested resource was not found.',
      );
    }
    return ProfileEnvelopeSchema.parse({
      data: { profile },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post('profiles/:profileId/offerings')
  async createOffering(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('profileId') profileId: string,
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
    const parsed = OfferingInputSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return {
        ...this.problem(request, 400, 'VALIDATION_ERROR', 'Offering input is invalid.'),
        errors: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
          message: issue.message,
        })),
      };
    }

    const result = await this.profileOfferingService.createOffering({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
      profileId,
      content: parsed.data,
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
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot edit offerings.');
    }

    reply.code(201);
    return OfferingEnvelopeSchema.parse({
      data: { offering: result.offering },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post('offerings/:offeringId/revisions')
  async createOfferingRevision(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('offeringId') offeringId: string,
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
    const parsed = OfferingInputSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return {
        ...this.problem(request, 400, 'VALIDATION_ERROR', 'Offering input is invalid.'),
        errors: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
          message: issue.message,
        })),
      };
    }
    const result = await this.profileOfferingService.createOfferingRevision({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
      offeringId,
      content: parsed.data,
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
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot edit offerings.');
    }
    reply.code(201);
    return OfferingEnvelopeSchema.parse({
      data: { offering: result.offering },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Get('offerings/:offeringId/revisions/:revision')
  async getOfferingRevision(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('offeringId') offeringId: string,
    @Param('revision') revisionInput: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const token = request.cookies['__Host-aeo_session'];
    const session = token === undefined ? null : await this.authService.getSession(token);
    if (session === null) {
      reply.code(401);
      return this.problem(request, 401, 'UNAUTHENTICATED', 'A valid server session is required.');
    }
    const revision = Number(revisionInput);
    const offering =
      Number.isSafeInteger(revision) && revision > 0
        ? await this.profileOfferingService.getOfferingRevision({
            actorSubject: session.subject,
            tenantId,
            workspaceId,
            offeringId,
            revision,
          })
        : null;
    if (offering === null) {
      reply.code(404);
      return this.problem(
        request,
        404,
        'NOT_FOUND_OR_FORBIDDEN',
        'The requested resource was not found.',
      );
    }
    return OfferingEnvelopeSchema.parse({
      data: { offering },
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
