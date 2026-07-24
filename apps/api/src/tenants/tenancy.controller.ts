import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { AuthService } from '@aeostudio/application/auth';
import type { TenancyService } from '@aeostudio/application/identity-access';
import { ProblemDetailsSchema, SCHEMA_VERSION } from '@aeostudio/contracts/auth';
import {
  ChangeMembershipRoleRequestSchema,
  CreateTenantEnvelopeSchema,
  CreateTenantRequestSchema,
  InviteMembershipRequestSchema,
  MembershipEnvelopeSchema,
  WorkspaceAccessEnvelopeSchema,
  WorkspaceListEnvelopeSchema,
} from '@aeostudio/contracts/identity-access';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AUTH_SERVICE, AUTH_WEB_ORIGIN } from '../auth/auth.tokens.js';
import { TENANCY_SERVICE } from './tenancy.tokens.js';

@Controller('api/v1/tenants')
export class TenancyController {
  constructor(
    @Inject(AUTH_SERVICE) private readonly authService: AuthService,
    @Inject(AUTH_WEB_ORIGIN) private readonly webOrigin: string,
    @Inject(TENANCY_SERVICE) private readonly tenancyService: TenancyService,
  ) {}

  @Get()
  async listWorkspaces(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const token = request.cookies['__Host-aeo_session'];
    const session = token === undefined ? null : await this.authService.getSession(token);
    if (session === null) {
      reply.code(401);
      return this.problem(request, 401, 'UNAUTHENTICATED', 'A valid server session is required.');
    }
    const workspaces = await this.tenancyService.listWorkspaces({ actorSubject: session.subject });
    return WorkspaceListEnvelopeSchema.parse({
      data: { workspaces },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post()
  async createTenant(
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
    const parsed = CreateTenantRequestSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return this.problem(request, 400, 'VALIDATION_ERROR', 'Tenant input is invalid.');
    }

    const result = await this.tenancyService.createTenant({
      actorSubject: session.subject,
      actorEmail: session.email,
      tenantName: parsed.data.tenantName,
      workspaceName: parsed.data.workspaceName,
    });
    reply.code(201);
    return CreateTenantEnvelopeSchema.parse({
      data: {
        tenant: result.tenant,
        workspace: result.workspace,
        membership: {
          id: result.membership.id,
          tenantId: result.membership.tenantId,
          workspaceId: result.membership.workspaceId,
          userId: result.membership.userId,
          role: result.membership.role,
          status: result.membership.status,
        },
      },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Get(':tenantId/workspaces/:workspaceId')
  async getWorkspace(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const token = request.cookies['__Host-aeo_session'];
    const session = token === undefined ? null : await this.authService.getSession(token);
    if (session === null) {
      reply.code(401);
      return this.problem(request, 401, 'UNAUTHENTICATED', 'A valid server session is required.');
    }
    const result = await this.tenancyService.getWorkspace({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
    });
    if (result === null) {
      reply.code(404);
      return this.problem(
        request,
        404,
        'NOT_FOUND_OR_FORBIDDEN',
        'The requested resource was not found.',
      );
    }
    return WorkspaceAccessEnvelopeSchema.parse({
      data: result,
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post(':tenantId/workspaces/:workspaceId/invitations')
  async inviteMembership(
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
    const parsed = InviteMembershipRequestSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return this.problem(request, 400, 'VALIDATION_ERROR', 'Invitation input is invalid.');
    }

    const result = await this.tenancyService.inviteMembership({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
      email: parsed.data.email,
      role: parsed.data.role,
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
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot invite members.');
    }

    reply.code(201);
    return MembershipEnvelopeSchema.parse({
      data: { membership: result.membership },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post(':tenantId/workspaces/:workspaceId/memberships/:membershipId/accept')
  async acceptMembership(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('membershipId') membershipId: string,
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

    const result = await this.tenancyService.acceptMembership({
      actorSubject: session.subject,
      actorEmail: session.email,
      tenantId,
      workspaceId,
      membershipId,
    });
    if (result.outcome !== 'SUCCEEDED') {
      reply.code(404);
      return this.problem(
        request,
        404,
        'NOT_FOUND_OR_FORBIDDEN',
        'The requested resource was not found.',
      );
    }

    reply.code(200);
    return MembershipEnvelopeSchema.parse({
      data: { membership: result.membership },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Patch(':tenantId/workspaces/:workspaceId/memberships/:membershipId')
  async changeMembershipRole(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('membershipId') membershipId: string,
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
    const parsed = ChangeMembershipRoleRequestSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return this.problem(request, 400, 'VALIDATION_ERROR', 'Role input is invalid.');
    }

    const result = await this.tenancyService.changeMembershipRole({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
      membershipId,
      role: parsed.data.role,
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
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot change roles.');
    }

    reply.code(200);
    return MembershipEnvelopeSchema.parse({
      data: { membership: result.membership },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Delete(':tenantId/workspaces/:workspaceId/memberships/:membershipId')
  async revokeMembership(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('membershipId') membershipId: string,
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

    const result = await this.tenancyService.revokeMembership({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
      membershipId,
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
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot revoke members.');
    }

    reply.code(200);
    return MembershipEnvelopeSchema.parse({
      data: { membership: result.membership },
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
