import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Req, Res } from '@nestjs/common';
import type { AuthService, ServerSession } from '@aeostudio/application/auth';
import type {
  JobBudgetService,
  JobTraceContextProvider,
} from '@aeostudio/application/jobs-budgets';
import type { StructuredApplicationLogger } from '@aeostudio/adapters/observability';
import { ProblemDetailsSchema, SCHEMA_VERSION } from '@aeostudio/contracts/auth';
import {
  BudgetAlertsEnvelopeSchema,
  JobEnvelopeSchema,
  ProviderKeySchema,
  ProviderBudgetPolicyEnvelopeSchema,
  SetBudgetRequestSchema,
  SubmitJobRequestSchema,
  TenantBudgetPolicyEnvelopeSchema,
  WorkspaceBudgetPolicyEnvelopeSchema,
} from '@aeostudio/contracts/jobs-budgets';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AUTH_SERVICE, AUTH_WEB_ORIGIN } from '../auth/auth.tokens.js';
import {
  APPLICATION_LOGGER,
  JOB_TRACE_CONTEXT_PROVIDER,
} from '../observability/observability.tokens.js';
import { JOB_BUDGET_SERVICE } from './jobs.tokens.js';

@Controller('api/v1/tenants/:tenantId/workspaces/:workspaceId')
export class JobsController {
  constructor(
    @Inject(AUTH_SERVICE) private readonly authService: AuthService,
    @Inject(AUTH_WEB_ORIGIN) private readonly webOrigin: string,
    @Inject(JOB_BUDGET_SERVICE) private readonly jobs: JobBudgetService,
    @Inject(JOB_TRACE_CONTEXT_PROVIDER)
    private readonly traces: JobTraceContextProvider,
    @Inject(APPLICATION_LOGGER)
    private readonly logger: StructuredApplicationLogger,
  ) {}

  @Put('budget')
  async setBudget(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const session = await this.authenticatedMutation(request, reply);
    if (session === null) {
      return this.authenticationProblem(request, reply);
    }
    const parsed = SetBudgetRequestSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return this.problem(request, 400, 'VALIDATION_ERROR', 'Budget input is invalid.');
    }
    const result = await this.jobs.setBudget({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
      limitUnits: parsed.data.limitUnits,
    });
    if (result.outcome === 'NOT_FOUND') {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(request, 403, 'FORBIDDEN', 'Only an Owner can change the budget.');
    }
    return WorkspaceBudgetPolicyEnvelopeSchema.parse({
      data: { policy: result.policy },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Put('budget/tenant')
  async setTenantBudget(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const session = await this.authenticatedMutation(request, reply);
    if (session === null) return this.authenticationProblem(request, reply);
    const parsed = SetBudgetRequestSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return this.problem(request, 400, 'VALIDATION_ERROR', 'Tenant budget input is invalid.');
    }
    const result = await this.jobs.setTenantBudget({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
      limitUnits: parsed.data.limitUnits,
    });
    if (result.outcome === 'NOT_FOUND') {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(request, 403, 'FORBIDDEN', 'Only an Owner can change the budget.');
    }
    return TenantBudgetPolicyEnvelopeSchema.parse({
      data: { policy: result.policy },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Put('budget/providers/:providerKey')
  async setProviderBudget(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('providerKey') rawProviderKey: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const session = await this.authenticatedMutation(request, reply);
    if (session === null) return this.authenticationProblem(request, reply);
    const parsedBody = SetBudgetRequestSchema.safeParse(body);
    const parsedProvider = ProviderKeySchema.safeParse(rawProviderKey);
    if (!parsedBody.success || !parsedProvider.success) {
      reply.code(400);
      return this.problem(request, 400, 'VALIDATION_ERROR', 'Provider budget input is invalid.');
    }
    const result = await this.jobs.setProviderBudget({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
      providerKey: parsedProvider.data,
      limitUnits: parsedBody.data.limitUnits,
    });
    if (result.outcome === 'NOT_FOUND') {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(request, 403, 'FORBIDDEN', 'Only an Owner can change the budget.');
    }
    return ProviderBudgetPolicyEnvelopeSchema.parse({
      data: { policy: result.policy },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Get('budget/alerts')
  async listBudgetAlerts(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const token = request.cookies['__Host-aeo_session'];
    const session = token === undefined ? null : await this.authService.getSession(token);
    if (session === null) return this.authenticationProblem(request, reply);
    const result = await this.jobs.listBudgetAlerts({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
    });
    if (result.outcome === 'NOT_FOUND') {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(request, 403, 'FORBIDDEN', 'Only a Tenant Owner can read budget alerts.');
    }
    return BudgetAlertsEnvelopeSchema.parse({
      data: { alerts: result.alerts },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post('jobs')
  async submitJob(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const session = await this.authenticatedMutation(request, reply);
    if (session === null) {
      return this.authenticationProblem(request, reply);
    }
    const parsed = SubmitJobRequestSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return this.problem(request, 400, 'VALIDATION_ERROR', 'Job input is invalid.');
    }
    const acknowledgementStartedAt = performance.now();
    const traceContext = this.traces.capture(request.id);
    const result = await this.jobs.submitJob({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
      ...parsed.data,
      ...(traceContext === undefined ? {} : { traceContext }),
    });
    reply.header(
      'server-timing',
      `job-ack;dur=${(performance.now() - acknowledgementStartedAt).toFixed(2)}`,
    );
    if (result.outcome === 'NOT_FOUND') {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot submit jobs.');
    }
    const logInput = {
      correlation: { requestId: request.id, jobId: result.job.id },
      attributes: { tenantId, workspaceId, outcome: result.job.status },
    };
    if (result.job.budgetWarning) this.logger.warn('BUDGET_WARNING', logInput);
    if (result.job.status === 'BUDGET_BLOCKED') this.logger.warn('BUDGET_BLOCKED', logInput);
    reply.code(202);
    return JobEnvelopeSchema.parse({
      data: { job: result.job },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Get('jobs/:jobId')
  async getJob(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('jobId') jobId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const token = request.cookies['__Host-aeo_session'];
    const session = token === undefined ? null : await this.authService.getSession(token);
    if (session === null) {
      return this.authenticationProblem(request, reply);
    }
    const job = await this.jobs.getJob({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
      jobId,
    });
    if (job === null) {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    return JobEnvelopeSchema.parse({
      data: { job },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Delete('jobs/:jobId')
  async cancelJob(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('jobId') jobId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const session = await this.authenticatedMutation(request, reply);
    if (session === null) {
      return this.authenticationProblem(request, reply);
    }
    const result = await this.jobs.cancelJob({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
      jobId,
    });
    if (result.outcome === 'NOT_FOUND') {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot cancel jobs.');
    }
    if (result.outcome === 'CONFLICT') {
      reply.code(409);
      return this.problem(
        request,
        409,
        'PUBLICATION_CANCEL_REQUIRES_RECONCILIATION',
        'A Publication that may have crossed the remote boundary cannot be cancelled.',
      );
    }
    return JobEnvelopeSchema.parse({
      data: { job: result.job },
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
    return this.problem(request, 401, 'UNAUTHENTICATED', 'A valid server session is required.');
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
