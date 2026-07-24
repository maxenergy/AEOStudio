import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { AuthService } from '@aeostudio/application/auth';
import type { EvidenceClaimService } from '@aeostudio/application/evidence-claims';
import { ProblemDetailsSchema, SCHEMA_VERSION } from '@aeostudio/contracts/auth';
import {
  ClaimCurrentStateEnvelopeSchema,
  ClaimEnvelopeSchema,
  ClaimEvidenceDrillDownEnvelopeSchema,
  ClaimReviewEnvelopeSchema,
  CreateClaimRequestSchema,
  CreateEvidenceSnapshotRequestSchema,
  CreateEvidenceSourceRequestSchema,
  EvidenceSnapshotEnvelopeSchema,
  EvidenceSourceEnvelopeSchema,
  ReviewClaimRequestSchema,
  SubmitClaimRequestSchema,
} from '@aeostudio/contracts/evidence-claims';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AUTH_SERVICE, AUTH_WEB_ORIGIN } from '../auth/auth.tokens.js';
import { EVIDENCE_CLAIM_SERVICE } from './claims.tokens.js';

@Controller('api/v1/tenants/:tenantId/workspaces/:workspaceId')
export class ClaimsController {
  constructor(
    @Inject(AUTH_SERVICE) private readonly authService: AuthService,
    @Inject(AUTH_WEB_ORIGIN) private readonly webOrigin: string,
    @Inject(EVIDENCE_CLAIM_SERVICE) private readonly claims: EvidenceClaimService,
  ) {}

  @Post('evidence-sources')
  async createSource(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const subject = await this.authenticatedSubject(request, reply);
    if (subject === null) {
      return this.problem(
        request,
        reply.statusCode,
        reply.statusCode === 403 ? 'CSRF_REJECTED' : 'UNAUTHENTICATED',
        'Authentication failed.',
      );
    }
    const parsed = CreateEvidenceSourceRequestSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return this.problem(request, 400, 'VALIDATION_ERROR', 'Evidence Source input is invalid.');
    }
    const result = await this.claims.registerSource({
      actorSubject: subject,
      tenantId,
      workspaceId,
      ...parsed.data,
    });
    if (result.outcome === 'NOT_FOUND') {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot edit Evidence.');
    }
    reply.code(201);
    return EvidenceSourceEnvelopeSchema.parse({
      data: { source: result.source },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post('evidence-sources/:sourceId/snapshots')
  async createSnapshot(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('sourceId') sourceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const subject = await this.authenticatedSubject(request, reply);
    if (subject === null) {
      return this.problem(
        request,
        reply.statusCode,
        reply.statusCode === 403 ? 'CSRF_REJECTED' : 'UNAUTHENTICATED',
        'Authentication failed.',
      );
    }
    const parsed = CreateEvidenceSnapshotRequestSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return this.problem(request, 400, 'VALIDATION_ERROR', 'Snapshot input is invalid.');
    }
    const result = await this.claims.addSnapshot({
      actorSubject: subject,
      tenantId,
      workspaceId,
      sourceId,
      ...parsed.data,
    });
    if (result.outcome === 'NOT_FOUND') {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot edit Evidence.');
    }
    if (result.outcome === 'OBJECT_UNVERIFIED') {
      reply.code(422);
      return this.problem(
        request,
        422,
        'EVIDENCE_OBJECT_UNVERIFIED',
        'The server could not persist and verify an exact immutable Evidence object.',
      );
    }
    reply.code(201);
    return EvidenceSnapshotEnvelopeSchema.parse({
      data: { snapshot: result.snapshot, source: result.source },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post('claims')
  async createClaim(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const subject = await this.authenticatedSubject(request, reply);
    if (subject === null) {
      return this.problem(
        request,
        reply.statusCode,
        reply.statusCode === 403 ? 'CSRF_REJECTED' : 'UNAUTHENTICATED',
        'Authentication failed.',
      );
    }
    const parsed = CreateClaimRequestSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return this.problem(request, 400, 'VALIDATION_ERROR', 'Claim input is invalid.');
    }
    const result = await this.claims.proposeClaim({
      actorSubject: subject,
      tenantId,
      workspaceId,
      ...parsed.data,
    });
    if (result.outcome === 'NOT_FOUND') {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot propose Claims.');
    }
    reply.code(201);
    return ClaimEnvelopeSchema.parse({
      data: { claim: result.claim, revision: result.revision },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post('claims/:claimId/revisions/:revisionId/submit')
  async submitClaim(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('claimId') claimId: string,
    @Param('revisionId') revisionId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const subject = await this.authenticatedSubject(request, reply);
    if (subject === null) {
      return this.problem(
        request,
        reply.statusCode,
        reply.statusCode === 403 ? 'CSRF_REJECTED' : 'UNAUTHENTICATED',
        'Authentication failed.',
      );
    }
    if (!SubmitClaimRequestSchema.safeParse(body).success) {
      reply.code(400);
      return this.problem(request, 400, 'VALIDATION_ERROR', 'Claim submission is invalid.');
    }
    const result = await this.claims.submitClaim({
      actorSubject: subject,
      tenantId,
      workspaceId,
      claimId,
      revisionId,
    });
    if (result.outcome === 'NOT_FOUND') {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot submit Claims.');
    }
    if (result.outcome === 'NEEDS_EVIDENCE') {
      reply.code(409);
      return this.problem(
        request,
        409,
        'CLAIM_NEEDS_EVIDENCE',
        'Exact evidence, scope and future expiry are required.',
      );
    }
    return ClaimEnvelopeSchema.parse({
      data: result.bundle,
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post('claims/:claimId/revisions/:revisionId/reviews')
  async reviewClaim(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('claimId') claimId: string,
    @Param('revisionId') revisionId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const subject = await this.authenticatedSubject(request, reply);
    if (subject === null) {
      return this.problem(
        request,
        reply.statusCode,
        reply.statusCode === 403 ? 'CSRF_REJECTED' : 'UNAUTHENTICATED',
        'Authentication failed.',
      );
    }
    const parsed = ReviewClaimRequestSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return this.problem(request, 400, 'VALIDATION_ERROR', 'Claim review is invalid.');
    }
    const result = await this.claims.reviewClaim({
      actorSubject: subject,
      tenantId,
      workspaceId,
      claimId,
      revisionId,
      ...parsed.data,
    });
    if (result.outcome === 'SELF_APPROVAL_FORBIDDEN') {
      reply.code(409);
      return this.problem(
        request,
        409,
        'SELF_APPROVAL_FORBIDDEN',
        'A revision creator cannot approve their own work.',
      );
    }
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot review Claims.');
    }
    if (result.outcome === 'NOT_FOUND') {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    if (result.outcome === 'NOT_IN_REVIEW') {
      reply.code(409);
      return this.problem(
        request,
        409,
        'CLAIM_NOT_IN_REVIEW',
        'The exact revision is not in review.',
      );
    }
    if (result.outcome === 'NEEDS_EVIDENCE') {
      reply.code(409);
      return this.problem(
        request,
        409,
        'CLAIM_NEEDS_EVIDENCE',
        'Evidence is stale, incomplete or expired.',
      );
    }
    reply.code(200);
    return ClaimReviewEnvelopeSchema.parse({
      data: { ...result.bundle, review: result.review },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Get('claims/:claimId/revisions/:revisionId/evidence')
  async getEvidenceDrillDown(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('claimId') claimId: string,
    @Param('revisionId') revisionId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const token = request.cookies['__Host-aeo_session'];
    const session = token === undefined ? null : await this.authService.getSession(token);
    if (session === null) {
      reply.code(401);
      return this.problem(request, 401, 'UNAUTHENTICATED', 'A valid session is required.');
    }
    const evidence = await this.claims.getEvidenceDrillDown({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
      claimId,
      revisionId,
    });
    if (evidence === null) {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    return ClaimEvidenceDrillDownEnvelopeSchema.parse({
      data: { evidence },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Get('claims/:claimId/revisions/:revisionId')
  async getClaimRevision(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('claimId') claimId: string,
    @Param('revisionId') revisionId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const token = request.cookies['__Host-aeo_session'];
    const session = token === undefined ? null : await this.authService.getSession(token);
    if (session === null) {
      reply.code(401);
      return this.problem(request, 401, 'UNAUTHENTICATED', 'A valid session is required.');
    }
    const bundle = await this.claims.getClaimRevision({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
      claimId,
      revisionId,
    });
    if (bundle === null) {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    return ClaimEnvelopeSchema.parse({
      data: bundle,
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Get('claims/:claimId')
  async getClaim(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('claimId') claimId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const token = request.cookies['__Host-aeo_session'];
    const session = token === undefined ? null : await this.authService.getSession(token);
    if (session === null) {
      reply.code(401);
      return this.problem(request, 401, 'UNAUTHENTICATED', 'A valid session is required.');
    }
    const claim = await this.claims.getClaim({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
      claimId,
    });
    if (claim === null) {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    return ClaimCurrentStateEnvelopeSchema.parse({
      data: claim,
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  private async authenticatedSubject(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<string | null> {
    if (request.headers.origin !== new URL(this.webOrigin).origin) {
      reply.code(403);
      return null;
    }
    const token = request.cookies['__Host-aeo_session'];
    const session = token === undefined ? null : await this.authService.getSession(token);
    if (session === null) {
      reply.code(401);
      return null;
    }
    return session.subject;
  }

  private problem(
    request: FastifyRequest,
    status: number,
    code: string,
    detail: string,
  ): Record<string, unknown> {
    return ProblemDetailsSchema.parse({
      type: `https://aeostudio.local/problems/${code.toLowerCase().replaceAll('_', '-')}`,
      title: 'Request rejected',
      status,
      code,
      detail,
      requestId: request.id,
      retryable: false,
    });
  }
}
