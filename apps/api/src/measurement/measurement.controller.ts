import { Body, Controller, Get, Inject, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { AuthService } from '@aeostudio/application/auth';
import type { MeasurementService } from '@aeostudio/application/measurement';
import type { JobTraceContextProvider } from '@aeostudio/application/jobs-budgets';
import type { StructuredApplicationLogger } from '@aeostudio/adapters/observability';
import { ProblemDetailsSchema, SCHEMA_VERSION } from '@aeostudio/contracts/auth';
import {
  ManualMeasurementImportDetailEnvelopeSchema,
  ManualMeasurementImportEnvelopeSchema,
  MeasurementDashboardEnvelopeSchema,
  MeasurementPromptRunListEnvelopeSchema,
  MeasurementPromptRunListQuerySchema,
  MeasurementProviderPolicyEnvelopeSchema,
  MeasurementProviderPolicyRequestSchema,
  MeasurementProviderPolicyStateEnvelopeSchema,
  MeasurementRunEnvelopeSchema,
  PromptRunEnvelopeSchema,
  ReviewManualMeasurementImportRequestSchema,
  StartMeasurementRunEnvelopeSchema,
  SubmitManualMeasurementImportRequestSchema,
  StartMeasurementRunRequestSchema,
} from '@aeostudio/contracts/measurement';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AUTH_SERVICE, AUTH_WEB_ORIGIN } from '../auth/auth.tokens.js';
import { emitJobBudgetSignals } from '../observability/job-budget-signals.js';
import {
  APPLICATION_LOGGER,
  JOB_TRACE_CONTEXT_PROVIDER,
} from '../observability/observability.tokens.js';
import { MEASUREMENT_SERVICE } from './measurement.tokens.js';

@Controller('api/v1/tenants/:tenantId/workspaces/:workspaceId')
export class MeasurementController {
  constructor(
    @Inject(AUTH_SERVICE) private readonly authService: AuthService,
    @Inject(AUTH_WEB_ORIGIN) private readonly webOrigin: string,
    @Inject(MEASUREMENT_SERVICE) private readonly measurement: MeasurementService,
    @Inject(JOB_TRACE_CONTEXT_PROVIDER)
    private readonly traces: JobTraceContextProvider,
    @Inject(APPLICATION_LOGGER)
    private readonly logger: StructuredApplicationLogger,
  ) {}

  @Get('measurement-manual-imports/:manualImportId')
  async getManualImport(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('manualImportId') manualImportId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const subject = await this.readSubject(request, reply);
    if (subject === null) return this.authProblem(request, reply);
    const detail = await this.measurement.getManualImport({
      actorSubject: subject,
      tenantId,
      workspaceId,
      manualImportId,
    });
    return detail === null
      ? this.notFound(request, reply)
      : ManualMeasurementImportDetailEnvelopeSchema.parse({
          data: detail,
          meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
        });
  }

  @Post('measurement-manual-imports/:manualImportId/review')
  async reviewManualImport(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('manualImportId') manualImportId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const subject = await this.mutationSubject(request, reply);
    if (subject === null) return this.authProblem(request, reply);
    const parsed = ReviewManualMeasurementImportRequestSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return this.problem(request, 400, 'VALIDATION_ERROR', 'Manual import review is invalid.');
    }
    const result = await this.measurement.reviewManualImport({
      actorSubject: subject,
      tenantId,
      workspaceId,
      manualImportId,
      ...parsed.data,
    });
    if (result.outcome === 'NOT_FOUND') return this.notFound(request, reply);
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(
        request,
        403,
        'FORBIDDEN',
        'Only a Reviewer or Owner can review a manual import.',
      );
    }
    if (result.outcome !== 'SUCCEEDED') {
      reply.code(409);
      return this.problem(
        request,
        409,
        `MANUAL_IMPORT_REVIEW_${result.outcome}`,
        'Manual import review conflicts with its hash, state, reviewer, or slot integrity.',
      );
    }
    reply.code(200);
    return ManualMeasurementImportEnvelopeSchema.parse({
      data: { manualImport: result.manualImport },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post('measurement-manual-imports')
  async submitManualImport(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const subject = await this.mutationSubject(request, reply);
    if (subject === null) return this.authProblem(request, reply);
    const parsed = SubmitManualMeasurementImportRequestSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return this.problem(request, 400, 'VALIDATION_ERROR', 'Manual import input is invalid.');
    }
    const result = await this.measurement.submitManualImport({
      actorSubject: subject,
      tenantId,
      workspaceId,
      ...parsed.data,
    });
    if (result.outcome === 'NOT_FOUND') return this.notFound(request, reply);
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot submit imports.');
    }
    if (result.outcome === 'INVALID_ENTRIES' || result.outcome === 'EVIDENCE_TOO_LARGE') {
      reply.code(400);
      return this.problem(
        request,
        400,
        result.outcome === 'EVIDENCE_TOO_LARGE'
          ? 'MANUAL_IMPORT_EVIDENCE_TOO_LARGE'
          : 'MANUAL_IMPORT_ENTRIES_INVALID',
        'Manual import entries do not match the approved Prompt slots.',
      );
    }
    if (
      result.outcome === 'APPROVAL_MISMATCH' ||
      result.outcome === 'INVALID_SOURCE' ||
      result.outcome === 'EVIDENCE_HASH_MISMATCH' ||
      result.outcome === 'IDEMPOTENCY_CONFLICT'
    ) {
      reply.code(409);
      return this.problem(
        request,
        409,
        `MANUAL_IMPORT_${result.outcome}`,
        'Manual import conflicts with its approved source, evidence hash, or idempotency key.',
      );
    }
    if (result.outcome !== 'SUCCEEDED') {
      reply.code(409);
      return this.problem(request, 409, 'MANUAL_IMPORT_REJECTED', 'Manual import was rejected.');
    }
    reply.code(201);
    return ManualMeasurementImportEnvelopeSchema.parse({
      data: { manualImport: result.manualImport },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post('measurement-runs')
  async start(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const subject = await this.mutationSubject(request, reply);
    if (subject === null) return this.authProblem(request, reply);
    const parsed = StartMeasurementRunRequestSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return this.problem(request, 400, 'VALIDATION_ERROR', 'Measurement start input is invalid.');
    }
    const { manualImportId, expectedManualImportHash, ...startInput } = parsed.data;
    const traceContext = this.traces.capture(request.id);
    const result = await this.measurement.start({
      actorSubject: subject,
      tenantId,
      workspaceId,
      ...startInput,
      ...(manualImportId === undefined ? {} : { manualImportId }),
      ...(expectedManualImportHash === undefined ? {} : { expectedManualImportHash }),
      ...(traceContext === undefined ? {} : { traceContext }),
    });
    if (result.outcome === 'NOT_FOUND') return this.notFound(request, reply);
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot run measurements.');
    }
    if (result.outcome === 'APPROVAL_MISMATCH') {
      reply.code(409);
      return this.problem(
        request,
        409,
        'MEASUREMENT_APPROVAL_MISMATCH',
        'Measurement requires the exact approved Prompt and Scenario hashes.',
      );
    }
    if (result.outcome === 'MANUAL_IMPORT_NOT_APPROVED') {
      reply.code(409);
      return this.problem(
        request,
        409,
        'MANUAL_IMPORT_NOT_APPROVED',
        'Baseline requires an exact reviewed manual import.',
      );
    }
    emitJobBudgetSignals(this.logger, {
      requestId: request.id,
      tenantId,
      workspaceId,
      aggregateId: result.measurementRun.id,
      job: result.job,
    });
    reply.code(202);
    return StartMeasurementRunEnvelopeSchema.parse({
      data: {
        measurementRun: result.measurementRun,
        job: result.job,
      },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Put('measurement-provider-policies/:providerKey/:surfaceKey')
  async setProviderPolicy(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('providerKey') providerKey: string,
    @Param('surfaceKey') surfaceKey: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const subject = await this.mutationSubject(request, reply);
    if (subject === null) return this.authProblem(request, reply);
    const parsed = MeasurementProviderPolicyRequestSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return this.problem(request, 400, 'VALIDATION_ERROR', 'Provider policy input is invalid.');
    }
    const result = await this.measurement.setProviderPolicy({
      actorSubject: subject,
      tenantId,
      workspaceId,
      providerKey,
      surfaceKey,
      ...parsed.data,
    });
    if (result.outcome === 'NOT_FOUND') return this.notFound(request, reply);
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(
        request,
        403,
        'FORBIDDEN',
        'Only a Tenant Owner can set Provider policy.',
      );
    }
    return MeasurementProviderPolicyEnvelopeSchema.parse({
      data: { policy: result.policy },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Get('measurement-provider-policies/:providerKey/:surfaceKey')
  async getProviderPolicyState(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('providerKey') providerKey: string,
    @Param('surfaceKey') surfaceKey: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const subject = await this.readSubject(request, reply);
    if (subject === null) return this.authProblem(request, reply);
    const state = await this.measurement.getProviderPolicyState({
      actorSubject: subject,
      tenantId,
      workspaceId,
      providerKey,
      surfaceKey,
    });
    return state === null
      ? this.notFound(request, reply)
      : MeasurementProviderPolicyStateEnvelopeSchema.parse({
          data: { state },
          meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
        });
  }

  @Get('measurement-runs/:measurementRunId')
  async getRun(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('measurementRunId') measurementRunId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const subject = await this.readSubject(request, reply);
    if (subject === null) return this.authProblem(request, reply);
    const measurementRun = await this.measurement.getRun({
      actorSubject: subject,
      tenantId,
      workspaceId,
      measurementRunId,
    });
    return measurementRun === null
      ? this.notFound(request, reply)
      : MeasurementRunEnvelopeSchema.parse({
          data: { measurementRun },
          meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
        });
  }

  @Get('measurement-runs/:measurementRunId/prompt-runs')
  async listPromptRuns(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('measurementRunId') measurementRunId: string,
    @Query('limit') requestedLimit: string | undefined,
    @Query('offset') requestedOffset: string | undefined,
    @Query('scopeKey') requestedScopeKey: string | undefined,
    @Query('dimension') requestedDimension: string | undefined,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const subject = await this.readSubject(request, reply);
    if (subject === null) return this.authProblem(request, reply);
    const query = MeasurementPromptRunListQuerySchema.safeParse({
      ...(requestedLimit === undefined ? {} : { limit: requestedLimit }),
      ...(requestedOffset === undefined ? {} : { offset: requestedOffset }),
      ...(requestedScopeKey === undefined ? {} : { scopeKey: requestedScopeKey }),
      ...(requestedDimension === undefined ? {} : { dimension: requestedDimension }),
    });
    if (!query.success) {
      reply.code(400);
      return this.problem(request, 400, 'VALIDATION_ERROR', 'PromptRun pagination is invalid.');
    }
    const result = await this.measurement.listPromptRuns({
      actorSubject: subject,
      tenantId,
      workspaceId,
      measurementRunId,
      limit: query.data.limit,
      offset: query.data.offset,
      ...(query.data.scopeKey === undefined ? {} : { scopeKey: query.data.scopeKey }),
      ...(query.data.dimension === undefined ? {} : { dimension: query.data.dimension }),
    });
    if (result === null) return this.notFound(request, reply);
    return MeasurementPromptRunListEnvelopeSchema.parse({
      data: { promptRuns: result.promptRuns },
      meta: {
        requestId: request.id,
        schemaVersion: SCHEMA_VERSION,
        total: result.total,
        limit: query.data.limit,
        offset: query.data.offset,
        nextOffset:
          query.data.offset + result.promptRuns.length < result.total
            ? query.data.offset + result.promptRuns.length
            : null,
      },
    });
  }

  @Get('measurement-runs/:measurementRunId/prompt-runs/:promptRunId')
  async getPromptRun(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('measurementRunId') measurementRunId: string,
    @Param('promptRunId') promptRunId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const subject = await this.readSubject(request, reply);
    if (subject === null) return this.authProblem(request, reply);
    const result = await this.measurement.getPromptRun({
      actorSubject: subject,
      tenantId,
      workspaceId,
      measurementRunId,
      promptRunId,
    });
    return result === null
      ? this.notFound(request, reply)
      : PromptRunEnvelopeSchema.parse({
          data: result,
          meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
        });
  }

  @Get('measurement-runs/:measurementRunId/dashboard')
  async dashboard(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('measurementRunId') measurementRunId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const subject = await this.readSubject(request, reply);
    if (subject === null) return this.authProblem(request, reply);
    const dashboard = await this.measurement.getDashboard({
      actorSubject: subject,
      tenantId,
      workspaceId,
      measurementRunId,
    });
    return dashboard === null
      ? this.notFound(request, reply)
      : MeasurementDashboardEnvelopeSchema.parse({
          data: dashboard,
          meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
        });
  }

  private async readSubject(request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    const token = request.cookies['__Host-aeo_session'];
    const session = token === undefined ? null : await this.authService.getSession(token);
    if (session === null) reply.code(401);
    return session?.subject ?? null;
  }

  private async mutationSubject(request: FastifyRequest, reply: FastifyReply) {
    if (request.headers.origin !== new URL(this.webOrigin).origin) {
      reply.code(403);
      return null;
    }
    return this.readSubject(request, reply);
  }

  private authProblem(request: FastifyRequest, reply: FastifyReply) {
    return this.problem(
      request,
      reply.statusCode,
      reply.statusCode === 403 ? 'CSRF_REJECTED' : 'UNAUTHENTICATED',
      'Authentication failed.',
    );
  }

  private notFound(request: FastifyRequest, reply: FastifyReply) {
    reply.code(404);
    return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
  }

  private problem(request: FastifyRequest, status: number, code: string, detail: string) {
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
