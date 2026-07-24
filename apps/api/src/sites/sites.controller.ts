import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { AuthService } from '@aeostudio/application/auth';
import type { SiteCrawlService } from '@aeostudio/application/site-crawl';
import type { JobBudgetService } from '@aeostudio/application/jobs-budgets';
import type { JobTraceContextProvider } from '@aeostudio/application/jobs-budgets';
import type { StructuredApplicationLogger } from '@aeostudio/adapters/observability';
import { ProblemDetailsSchema, SCHEMA_VERSION } from '@aeostudio/contracts/auth';
import { JobEnvelopeSchema } from '@aeostudio/contracts/jobs-budgets';
import {
  CompleteSiteVerificationRequestSchema,
  CreateSiteRequestSchema,
  CreateSiteVerificationRequestSchema,
  SiteBaselineEnvelopeSchema,
  SiteBaselineListEnvelopeSchema,
  SiteEnvelopeSchema,
  SiteVerificationEnvelopeSchema,
  StartCrawlRequestSchema,
} from '@aeostudio/contracts/site-crawl';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AUTH_SERVICE, AUTH_WEB_ORIGIN } from '../auth/auth.tokens.js';
import { emitJobBudgetSignals } from '../observability/job-budget-signals.js';
import {
  APPLICATION_LOGGER,
  JOB_TRACE_CONTEXT_PROVIDER,
} from '../observability/observability.tokens.js';
import { SITE_CRAWL_SERVICE, SITE_JOB_BUDGET_SERVICE } from './sites.tokens.js';

@Controller('api/v1/tenants/:tenantId/workspaces/:workspaceId')
export class SitesController {
  constructor(
    @Inject(AUTH_SERVICE) private readonly authService: AuthService,
    @Inject(AUTH_WEB_ORIGIN) private readonly webOrigin: string,
    @Inject(SITE_CRAWL_SERVICE) private readonly sites: SiteCrawlService,
    @Inject(SITE_JOB_BUDGET_SERVICE) private readonly jobs: JobBudgetService,
    @Inject(JOB_TRACE_CONTEXT_PROVIDER)
    private readonly traces: JobTraceContextProvider,
    @Inject(APPLICATION_LOGGER)
    private readonly logger: StructuredApplicationLogger,
  ) {}

  @Post('sites')
  async registerSite(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const subject = await this.authenticatedSubject(request, reply);
    if (subject === null) {
      return this.authenticationProblem(request, reply);
    }
    const parsed = CreateSiteRequestSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return this.problem(request, 400, 'VALIDATION_ERROR', 'Site input is invalid.');
    }
    const result = await this.sites.registerSite({
      actorSubject: subject,
      tenantId,
      workspaceId,
      ...parsed.data,
    });
    if (result.outcome === 'INVALID_ORIGIN') {
      reply.code(400);
      return this.problem(
        request,
        400,
        'INVALID_SITE_ORIGIN',
        'A canonical HTTP(S) origin is required.',
      );
    }
    if (result.outcome === 'NOT_FOUND') {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot register Sites.');
    }
    if (result.outcome !== 'SUCCEEDED') {
      throw new Error('UNHANDLED_SITE_REGISTRATION_OUTCOME');
    }
    reply.code(201);
    return SiteEnvelopeSchema.parse({
      data: { site: result.site },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post('sites/:siteId/crawls')
  async startCrawl(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('siteId') siteId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const subject = await this.authenticatedSubject(request, reply);
    if (subject === null) {
      return this.authenticationProblem(request, reply);
    }
    const parsed = StartCrawlRequestSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return this.problem(request, 400, 'VALIDATION_ERROR', 'Crawl input is invalid.');
    }
    const result = await this.sites.authorizeCrawl({
      actorSubject: subject,
      tenantId,
      workspaceId,
      siteId,
    });
    if (result.outcome === 'SITE_NOT_VERIFIED') {
      reply.code(409);
      return this.problem(
        request,
        409,
        'SITE_NOT_VERIFIED',
        'Verify Site ownership before crawling.',
      );
    }
    if (result.outcome === 'NOT_FOUND') {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot start crawls.');
    }
    if (result.outcome !== 'ALLOWED') {
      throw new Error('UNHANDLED_CRAWL_AUTHORIZATION_OUTCOME');
    }
    const traceContext = this.traces.capture(request.id);
    const submitted = await this.jobs.submitJob({
      actorSubject: subject,
      tenantId,
      workspaceId,
      jobType: 'SITE_CRAWL',
      aggregateId: result.site.id,
      idempotencyKey: parsed.data.idempotencyKey,
      estimatedUnits: 10,
      ...(traceContext === undefined ? {} : { traceContext }),
    });
    if (submitted.outcome === 'NOT_FOUND') {
      reply.code(409);
      return this.problem(
        request,
        409,
        'CRAWL_BUDGET_OR_SITE_UNAVAILABLE',
        'A verified Site and active budget are required.',
      );
    }
    if (submitted.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot start crawls.');
    }
    emitJobBudgetSignals(this.logger, {
      requestId: request.id,
      tenantId,
      workspaceId,
      aggregateId: result.site.id,
      job: submitted.job,
    });
    reply.code(202);
    return JobEnvelopeSchema.parse({
      data: { job: submitted.job },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Get('sites/:siteId/baseline')
  async getBaseline(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('siteId') siteId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const token = request.cookies['__Host-aeo_session'];
    const session = token === undefined ? null : await this.authService.getSession(token);
    if (session === null) {
      reply.code(401);
      return this.problem(request, 401, 'UNAUTHENTICATED', 'A valid server session is required.');
    }
    const baseline = await this.sites.getBaseline({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
      siteId,
    });
    if (baseline === null) {
      reply.code(404);
      return this.problem(
        request,
        404,
        'BASELINE_NOT_READY',
        'No completed baseline is available.',
      );
    }
    return SiteBaselineEnvelopeSchema.parse({
      data: { baseline },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Get('sites/baselines')
  async listBaselines(
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
    const baselines = await this.sites.listBaselines({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
    });
    if (baselines === null) {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    return SiteBaselineListEnvelopeSchema.parse({
      data: { baselines },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Get('sites/:siteId')
  async getSite(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('siteId') siteId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const token = request.cookies['__Host-aeo_session'];
    const session = token === undefined ? null : await this.authService.getSession(token);
    if (session === null) {
      reply.code(401);
      return this.problem(request, 401, 'UNAUTHENTICATED', 'A valid server session is required.');
    }
    const site = await this.sites.getSite({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
      siteId,
    });
    if (site === null) {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    return SiteEnvelopeSchema.parse({
      data: { site },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post('sites/:siteId/verifications')
  async createVerification(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('siteId') siteId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const subject = await this.authenticatedSubject(request, reply);
    if (subject === null) {
      return this.authenticationProblem(request, reply);
    }
    const parsed = CreateSiteVerificationRequestSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return this.problem(request, 400, 'VALIDATION_ERROR', 'Verification input is invalid.');
    }
    const result = await this.sites.createVerification({
      actorSubject: subject,
      tenantId,
      workspaceId,
      siteId,
      method: parsed.data.method,
    });
    if (result.outcome === 'NOT_FOUND') {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot verify Sites.');
    }
    if (result.outcome !== 'SUCCEEDED') {
      throw new Error('UNHANDLED_VERIFICATION_CREATION_OUTCOME');
    }
    reply.code(201);
    return SiteVerificationEnvelopeSchema.parse({
      data: { verification: result.verification },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post('sites/:siteId/verifications/:verificationId/complete')
  async completeVerification(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('siteId') siteId: string,
    @Param('verificationId') verificationId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const subject = await this.authenticatedSubject(request, reply);
    if (subject === null) {
      return this.authenticationProblem(request, reply);
    }
    if (!CompleteSiteVerificationRequestSchema.safeParse(body).success) {
      reply.code(400);
      return this.problem(request, 400, 'VALIDATION_ERROR', 'Verification input is invalid.');
    }
    const result = await this.sites.completeVerification({
      actorSubject: subject,
      tenantId,
      workspaceId,
      siteId,
      verificationId,
    });
    if (result.outcome === 'VERIFICATION_MISMATCH') {
      reply.code(409);
      return this.problem(
        request,
        409,
        'VERIFICATION_MISMATCH',
        'Ownership evidence did not exactly match the challenge.',
      );
    }
    if (result.outcome === 'NOT_FOUND') {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot verify Sites.');
    }
    if (result.outcome !== 'SUCCEEDED') {
      throw new Error('UNHANDLED_VERIFICATION_COMPLETION_OUTCOME');
    }
    reply.code(200);
    return SiteEnvelopeSchema.parse({
      data: { site: result.site },
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

  private authenticationProblem(request: FastifyRequest, reply: FastifyReply) {
    return reply.statusCode === 403
      ? this.problem(request, 403, 'CSRF_REJECTED', 'The request origin is not allowed.')
      : this.problem(request, 401, 'UNAUTHENTICATED', 'A valid server session is required.');
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
