import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { AuthService, ServerSession } from '@aeostudio/application/auth';
import type { ContentPlanningService } from '@aeostudio/application/content-planning';
import type { JobTraceContextProvider } from '@aeostudio/application/jobs-budgets';
import type { StructuredApplicationLogger } from '@aeostudio/adapters/observability';
import { ProblemDetailsSchema, SCHEMA_VERSION } from '@aeostudio/contracts/auth';
import {
  ApprovedBriefListEnvelopeSchema,
  BriefReviewEnvelopeSchema,
  ContentPlanBundleEnvelopeSchema,
  ReviewBriefRequestSchema,
  StartContentPlanEnvelopeSchema,
  StartContentPlanRequestSchema,
} from '@aeostudio/contracts/content-planning';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AUTH_SERVICE, AUTH_WEB_ORIGIN } from '../auth/auth.tokens.js';
import { emitJobBudgetSignals } from '../observability/job-budget-signals.js';
import {
  APPLICATION_LOGGER,
  JOB_TRACE_CONTEXT_PROVIDER,
} from '../observability/observability.tokens.js';
import { CONTENT_PLANNING_SERVICE } from './content-plans.tokens.js';

@Controller('api/v1/tenants/:tenantId/workspaces/:workspaceId/content-plans')
export class ContentPlansController {
  constructor(
    @Inject(AUTH_SERVICE) private readonly authService: AuthService,
    @Inject(AUTH_WEB_ORIGIN) private readonly webOrigin: string,
    @Inject(CONTENT_PLANNING_SERVICE) private readonly plans: ContentPlanningService,
    @Inject(JOB_TRACE_CONTEXT_PROVIDER)
    private readonly traces: JobTraceContextProvider,
    @Inject(APPLICATION_LOGGER)
    private readonly logger: StructuredApplicationLogger,
  ) {}

  @Post()
  async start(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const session = await this.authenticatedMutation(request, reply);
    if (session === null) return this.authenticationProblem(request, reply);
    const parsed = StartContentPlanRequestSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return this.problem(request, 400, 'VALIDATION_ERROR', 'Content Plan input is invalid.');
    }
    const { idempotencyKey, estimatedUnits, ...sourceInput } = parsed.data;
    void estimatedUnits;
    const traceContext = this.traces.capture(request.id);
    const result = await this.plans.startPlan({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
      sourceInput,
      idempotencyKey,
      ...(traceContext === undefined ? {} : { traceContext }),
    });
    if (result.outcome === 'NOT_FOUND') {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot create plans.');
    }
    if (result.outcome === 'IDEMPOTENCY_CONFLICT') {
      reply.code(409);
      return this.problem(
        request,
        409,
        'CONTENT_PLAN_IDEMPOTENCY_CONFLICT',
        'This idempotency key was already used for a different Content Plan request.',
      );
    }
    if (result.outcome === 'INVALID_REFERENCE') {
      reply.code(409);
      return {
        ...this.problem(
          request,
          409,
          'CONTENT_PLAN_INVALID_REFERENCE',
          'Every plan input must resolve to an approved current revision in this Workspace.',
        ),
        referenceType: result.referenceType,
      };
    }
    emitJobBudgetSignals(this.logger, {
      requestId: request.id,
      tenantId,
      workspaceId,
      aggregateId: result.plan.id,
      job: result.job,
    });
    reply.code(202);
    return StartContentPlanEnvelopeSchema.parse({
      data: { plan: result.plan, job: result.job },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Get('briefs/approved')
  async listApprovedBriefs(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const token = request.cookies['__Host-aeo_session'];
    const session = token === undefined ? null : await this.authService.getSession(token);
    if (session === null) return this.authenticationProblem(request, reply);
    const briefs = await this.plans.listApprovedBriefs({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
    });
    if (briefs === null) {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    return ApprovedBriefListEnvelopeSchema.parse({
      data: { briefs },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Get(':planId')
  async get(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('planId') planId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const token = request.cookies['__Host-aeo_session'];
    const session = token === undefined ? null : await this.authService.getSession(token);
    if (session === null) return this.authenticationProblem(request, reply);
    const bundle = await this.plans.getPlan({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
      planId,
    });
    if (bundle === null) {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    return ContentPlanBundleEnvelopeSchema.parse({
      data: bundle,
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post(':planId/briefs/:briefId/review')
  async reviewBrief(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('planId') planId: string,
    @Param('briefId') briefId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const session = await this.authenticatedMutation(request, reply);
    if (session === null) return this.authenticationProblem(request, reply);
    const parsed = ReviewBriefRequestSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return this.problem(request, 400, 'VALIDATION_ERROR', 'Brief review input is invalid.');
    }
    const result = await this.plans.reviewBrief({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
      planId,
      briefId,
      ...parsed.data,
    });
    if (result.outcome === 'NOT_FOUND') {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(request, 403, 'FORBIDDEN', 'Only a Reviewer can review Briefs.');
    }
    if (result.outcome === 'SELF_APPROVAL') {
      reply.code(409);
      return this.problem(
        request,
        409,
        'SELF_APPROVAL_FORBIDDEN',
        'The Brief creator cannot approve or reject the same Brief.',
      );
    }
    if (result.outcome === 'HASH_MISMATCH') {
      reply.code(409);
      return this.problem(
        request,
        409,
        'BRIEF_REVIEW_HASH_MISMATCH',
        'Review applies only to the exact current Brief hash.',
      );
    }
    if (result.outcome === 'ALREADY_REVIEWED') {
      reply.code(409);
      return this.problem(request, 409, 'BRIEF_ALREADY_REVIEWED', 'Brief review is immutable.');
    }
    if (result.outcome !== 'SUCCEEDED') {
      throw new Error('UNHANDLED_BRIEF_REVIEW_OUTCOME');
    }
    reply.code(200);
    return BriefReviewEnvelopeSchema.parse({
      data: { brief: result.brief, review: result.review },
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
