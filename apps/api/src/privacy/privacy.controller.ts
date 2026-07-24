import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { AuthService, ServerSession } from '@aeostudio/application/auth';
import type { PrivacyAuditService, PrivacyAuditStore } from '@aeostudio/application/privacy-audit';
import type { TenancyStore } from '@aeostudio/application/identity-access';
import { ProblemDetailsSchema, SCHEMA_VERSION } from '@aeostudio/contracts/auth';
import {
  AuditDigestEnvelopeSchema,
  AuditIntegrityEnvelopeSchema,
  AuditTimelineEnvelopeSchema,
  CreateLegalHoldRequestSchema,
  ExportTenantRequestSchema,
  LegalHoldEnvelopeSchema,
  LegalHoldListEnvelopeSchema,
  PrivacyOverviewEnvelopeSchema,
  RequestDeletionRequestSchema,
  TenantDeletionReceiptEnvelopeSchema,
  TenantExportEnvelopeSchema,
} from '@aeostudio/contracts/privacy-audit';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AUTH_SERVICE, AUTH_WEB_ORIGIN } from '../auth/auth.tokens.js';
import {
  DELETION_RECEIPT_COOKIE,
  DELETION_RECEIPT_COOKIE_TTL_SECONDS,
  DELETION_RECEIPT_TOKEN_HEADER,
  type DeletionReceiptTokenService,
} from './deletion-receipt-token.js';
import {
  DELETION_RECEIPT_TOKEN_SERVICE,
  PRIVACY_AUDIT_SERVICE,
  PRIVACY_AUDIT_STORE,
  PRIVACY_TENANCY_STORE,
} from './privacy.tokens.js';
import type { InMemoryTenantExportArchive } from './in-memory-tenant-export-archive.js';

interface AuthenticatedRequest {
  session: ServerSession;
  token: string;
}

function isTenantExportArchive(
  value: PrivacyAuditStore,
): value is PrivacyAuditStore & InMemoryTenantExportArchive {
  return 'readTenantExportArchive' in value && typeof value.readTenantExportArchive === 'function';
}

@Controller('api/v1/tenants/:tenantId/workspaces/:workspaceId/privacy')
export class PrivacyController {
  constructor(
    @Inject(AUTH_SERVICE) private readonly authService: AuthService,
    @Inject(AUTH_WEB_ORIGIN) private readonly webOrigin: string,
    @Inject(PRIVACY_AUDIT_SERVICE) private readonly privacy: PrivacyAuditService,
    @Inject(PRIVACY_AUDIT_STORE) private readonly privacyStore: PrivacyAuditStore,
    @Inject(PRIVACY_TENANCY_STORE) private readonly tenancyStore: TenancyStore,
    @Inject(DELETION_RECEIPT_TOKEN_SERVICE)
    private readonly deletionReceiptTokens: DeletionReceiptTokenService,
  ) {}

  @Get('exports/:exportId/download')
  async downloadExport(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('exportId') exportId: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void | Record<string, unknown>> {
    const authentication = await this.readAuthentication(request, reply);
    if (authentication === null) {
      reply.send(this.authenticationProblem(request, reply));
      return;
    }
    const context = await this.tenancyStore
      .resolveTenantContext({
        actorSubject: authentication.session.subject,
        tenantId,
        workspaceId,
      })
      .catch(() => null);
    if (context === null || context.role !== 'OWNER' || !isTenantExportArchive(this.privacyStore)) {
      reply.code(404).send(this.outcomeProblem(request, reply, 'NOT_FOUND'));
      return;
    }
    const archive = await this.privacyStore.readTenantExportArchive({
      sessionToken: authentication.token,
      context,
      exportId,
    });
    if (archive === null) {
      reply.code(404).send(this.outcomeProblem(request, reply, 'NOT_FOUND'));
      return;
    }
    reply
      .header('cache-control', 'private, no-store')
      .header('content-disposition', `attachment; filename="${archive.filename}"`)
      .header('content-type', 'application/json; charset=utf-8')
      .header('x-aeo-export-manifest-checksum', archive.manifestChecksum)
      .header('x-aeo-export-archive-checksum', archive.archiveChecksum)
      .send(Buffer.from(archive.body));
  }

  @Get('overview')
  async overview(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const authentication = await this.readAuthentication(request, reply);
    if (authentication === null) return this.authenticationProblem(request, reply);
    this.preventSensitiveResponseCaching(reply);
    const result = await this.privacy.getPrivacyOverview({
      actorSubject: authentication.session.subject,
      tenantId,
      workspaceId,
    });
    if (result.outcome !== 'SUCCEEDED') return this.outcomeProblem(request, reply, result.outcome);
    return PrivacyOverviewEnvelopeSchema.parse({
      data: { overview: result.overview },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Get('audit-events')
  async auditEvents(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const authentication = await this.readAuthentication(request, reply);
    if (authentication === null) return this.authenticationProblem(request, reply);
    this.preventSensitiveResponseCaching(reply);
    if (from === undefined || to === undefined) {
      return this.validationProblem(request, reply, 'Audit time range is required.');
    }
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    const result = await this.privacy.listAuditEvents({
      actorSubject: authentication.session.subject,
      tenantId,
      workspaceId,
      from,
      to,
      ...(cursor === undefined ? {} : { cursor }),
      ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
    });
    if (result.outcome !== 'SUCCEEDED') return this.outcomeProblem(request, reply, result.outcome);
    return AuditTimelineEnvelopeSchema.parse({
      data: { timeline: result.timeline },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post('exports')
  async exportTenant(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const authentication = await this.mutationAuthentication(request, reply);
    if (authentication === null) return this.authenticationProblem(request, reply);
    const parsed = ExportTenantRequestSchema.safeParse(body);
    if (!parsed.success) {
      return this.validationProblem(request, reply, 'Tenant export time range is invalid.');
    }
    const result = await this.privacy.exportTenant({
      actorSubject: authentication.session.subject,
      tenantId,
      workspaceId,
      from: parsed.data.from,
      to: parsed.data.to,
    });
    if (result.outcome !== 'SUCCEEDED') return this.outcomeProblem(request, reply, result.outcome);
    reply.code(201);
    return TenantExportEnvelopeSchema.parse({
      data: { export: result.export },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post('deletions/tenant')
  async deleteTenant(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const authentication = await this.mutationAuthentication(request, reply);
    if (authentication === null) return this.authenticationProblem(request, reply);
    this.preventSensitiveResponseCaching(reply);
    const parsed = RequestDeletionRequestSchema.safeParse(body);
    if (!parsed.success) {
      return this.validationProblem(request, reply, 'Tenant deletion reason is invalid.');
    }
    if (!this.deletionReceiptCapabilityIsReady()) {
      reply.code(503);
      return this.problem(
        request,
        503,
        'DELETION_RECEIPT_UNAVAILABLE',
        'Deletion was not started because its receipt capability is unavailable.',
        true,
      );
    }
    const result = await this.privacy.requestTenantDeletion({
      actorSubject: authentication.session.subject,
      tenantId,
      workspaceId,
      reason: parsed.data.reason,
    });
    if (result.outcome !== 'SUCCEEDED') return this.outcomeProblem(request, reply, result.outcome);
    await this.endDeletedSession(authentication.token, reply);
    this.exposeDeletionReceipt(result.receipt, reply);
    reply.code(202);
    return TenantDeletionReceiptEnvelopeSchema.parse({
      data: { receipt: result.receipt },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post('deletions/workspace')
  async deleteWorkspace(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const authentication = await this.mutationAuthentication(request, reply);
    if (authentication === null) return this.authenticationProblem(request, reply);
    this.preventSensitiveResponseCaching(reply);
    const parsed = RequestDeletionRequestSchema.safeParse(body);
    if (!parsed.success) {
      return this.validationProblem(request, reply, 'Workspace deletion reason is invalid.');
    }
    if (!this.deletionReceiptCapabilityIsReady()) {
      reply.code(503);
      return this.problem(
        request,
        503,
        'DELETION_RECEIPT_UNAVAILABLE',
        'Deletion was not started because its receipt capability is unavailable.',
        true,
      );
    }
    const result = await this.privacy.requestWorkspaceDeletion({
      actorSubject: authentication.session.subject,
      tenantId,
      workspaceId,
      reason: parsed.data.reason,
    });
    if (result.outcome !== 'SUCCEEDED') return this.outcomeProblem(request, reply, result.outcome);
    await this.endDeletedSession(authentication.token, reply);
    this.exposeDeletionReceipt(result.receipt, reply);
    reply.code(202);
    return TenantDeletionReceiptEnvelopeSchema.parse({
      data: { receipt: result.receipt },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Get('legal-holds')
  async legalHolds(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const authentication = await this.readAuthentication(request, reply);
    if (authentication === null) return this.authenticationProblem(request, reply);
    this.preventSensitiveResponseCaching(reply);
    const result = await this.privacy.listLegalHolds({
      actorSubject: authentication.session.subject,
      tenantId,
      workspaceId,
    });
    if (result.outcome !== 'SUCCEEDED') return this.outcomeProblem(request, reply, result.outcome);
    return LegalHoldListEnvelopeSchema.parse({
      data: { holds: result.holds },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post('legal-holds')
  async createLegalHold(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const authentication = await this.mutationAuthentication(request, reply);
    if (authentication === null) return this.authenticationProblem(request, reply);
    const parsed = CreateLegalHoldRequestSchema.safeParse(body);
    if (!parsed.success) {
      return this.validationProblem(request, reply, 'Legal hold input is invalid.');
    }
    const result = await this.privacy.createLegalHold({
      actorSubject: authentication.session.subject,
      tenantId,
      workspaceId,
      ...parsed.data,
    });
    if (result.outcome !== 'SUCCEEDED') return this.outcomeProblem(request, reply, result.outcome);
    reply.code(201);
    return LegalHoldEnvelopeSchema.parse({
      data: { hold: result.hold },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post('legal-holds/:holdId/release')
  async releaseLegalHold(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('holdId') holdId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const authentication = await this.mutationAuthentication(request, reply);
    if (authentication === null) return this.authenticationProblem(request, reply);
    const result = await this.privacy.releaseLegalHold({
      actorSubject: authentication.session.subject,
      tenantId,
      workspaceId,
      holdId,
    });
    if (result.outcome !== 'SUCCEEDED') return this.outcomeProblem(request, reply, result.outcome);
    return LegalHoldEnvelopeSchema.parse({
      data: { hold: result.hold },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Get('audit-integrity')
  async auditIntegrity(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const authentication = await this.readAuthentication(request, reply);
    if (authentication === null) return this.authenticationProblem(request, reply);
    this.preventSensitiveResponseCaching(reply);
    const verification = await this.privacy.verifyAuditIntegrity({
      actorSubject: authentication.session.subject,
      tenantId,
      workspaceId,
    });
    if (verification.outcome === 'NOT_FOUND') {
      return this.outcomeProblem(request, reply, verification.outcome);
    }
    return AuditIntegrityEnvelopeSchema.parse({
      data: { verification },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post('audit-digests')
  async sealAuditDigest(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const authentication = await this.mutationAuthentication(request, reply);
    if (authentication === null) return this.authenticationProblem(request, reply);
    const parsed = ExportTenantRequestSchema.safeParse(body);
    if (!parsed.success) {
      return this.validationProblem(request, reply, 'Audit digest time range is invalid.');
    }
    const result = await this.privacy.sealAuditDigest({
      actorSubject: authentication.session.subject,
      tenantId,
      workspaceId,
      from: parsed.data.from,
      to: parsed.data.to,
    });
    if (result.outcome !== 'SUCCEEDED') return this.outcomeProblem(request, reply, result.outcome);
    reply.code(201);
    return AuditDigestEnvelopeSchema.parse({
      data: { digest: result.digest },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  private async readAuthentication(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthenticatedRequest | null> {
    const token = request.cookies['__Host-aeo_session'];
    if (token === undefined) {
      reply.code(401);
      return null;
    }
    const session = await this.authService.getSession(token);
    if (session === null) {
      reply.code(401);
      return null;
    }
    return { session, token };
  }

  private async mutationAuthentication(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthenticatedRequest | null> {
    if (request.headers.origin !== new URL(this.webOrigin).origin) {
      reply.code(403);
      return null;
    }
    return this.readAuthentication(request, reply);
  }

  private async endDeletedSession(token: string, reply: FastifyReply): Promise<void> {
    try {
      await this.authService.revokeSession(token);
    } catch {
      // The deletion store owns the atomic revocation boundary. This is a defence-in-depth
      // revocation for explicitly supplied stores and must not hide a durable receipt.
    }
    reply.clearCookie('__Host-aeo_session', {
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      secure: true,
    });
  }

  private exposeDeletionReceipt(
    receipt: Parameters<DeletionReceiptTokenService['issue']>[0],
    reply: FastifyReply,
  ): boolean {
    try {
      const token = this.deletionReceiptTokens.issue(receipt);
      reply.setCookie(DELETION_RECEIPT_COOKIE, token, {
        httpOnly: true,
        maxAge: DELETION_RECEIPT_COOKIE_TTL_SECONDS,
        path: '/',
        sameSite: 'lax',
        secure: true,
      });
      reply.header(DELETION_RECEIPT_TOKEN_HEADER, token);
      reply.header('cache-control', 'private, no-store');
      return true;
    } catch {
      return false;
    }
  }

  private deletionReceiptCapabilityIsReady(): boolean {
    try {
      return this.deletionReceiptTokens.isReady();
    } catch {
      return false;
    }
  }

  private preventSensitiveResponseCaching(reply: FastifyReply): void {
    reply.header('cache-control', 'private, no-store');
  }

  private authenticationProblem(request: FastifyRequest, reply: FastifyReply) {
    const csrf = reply.statusCode === 403;
    return this.problem(
      request,
      csrf ? 403 : 401,
      csrf ? 'CSRF_REJECTED' : 'UNAUTHENTICATED',
      csrf ? 'The request origin is not allowed.' : 'A valid server session is required.',
    );
  }

  private validationProblem(request: FastifyRequest, reply: FastifyReply, detail: string) {
    reply.code(400);
    return this.problem(request, 400, 'VALIDATION_ERROR', detail);
  }

  private outcomeProblem(
    request: FastifyRequest,
    reply: FastifyReply,
    outcome: string,
  ): Record<string, unknown> {
    if (outcome === 'NOT_FOUND' || outcome === 'OBJECT_NOT_FOUND') {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    if (outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(request, 403, 'FORBIDDEN', 'Only an Owner can perform this action.');
    }
    if (outcome === 'PIPELINE_UNAVAILABLE') {
      reply.code(503);
      return this.problem(
        request,
        503,
        'PRIVACY_PIPELINE_UNAVAILABLE',
        'The privacy lifecycle store is unavailable.',
        true,
      );
    }
    if (outcome.startsWith('INVALID_')) {
      reply.code(400);
      return this.problem(request, 400, outcome, 'The privacy lifecycle request is invalid.');
    }
    reply.code(409);
    return this.problem(
      request,
      409,
      outcome,
      'The privacy lifecycle request conflicts with state.',
    );
  }

  private problem(
    request: FastifyRequest,
    status: number,
    code: string,
    detail: string,
    retryable = false,
  ): Record<string, unknown> {
    return ProblemDetailsSchema.parse({
      type: `https://aeostudio.local/problems/${code.toLowerCase().replaceAll('_', '-')}`,
      title: status === 401 ? 'Authentication required' : 'Request rejected',
      status,
      code,
      detail,
      requestId: request.id,
      retryable,
    });
  }
}
