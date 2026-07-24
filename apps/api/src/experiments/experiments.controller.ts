import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { AuthService } from '@aeostudio/application/auth';
import type { ExperimentService } from '@aeostudio/application/experiments';
import { ProblemDetailsSchema, SCHEMA_VERSION } from '@aeostudio/contracts/auth';
import {
  CreateExperimentRequestSchema,
  ExperimentEnvelopeSchema,
  ExperimentOptionsEnvelopeSchema,
} from '@aeostudio/contracts/experiments';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AUTH_SERVICE, AUTH_WEB_ORIGIN } from '../auth/auth.tokens.js';
import { EXPERIMENT_SERVICE } from './experiments.tokens.js';

@Controller('api/v1/tenants/:tenantId/workspaces/:workspaceId/experiments')
export class ExperimentsController {
  constructor(
    @Inject(AUTH_SERVICE) private readonly authService: AuthService,
    @Inject(AUTH_WEB_ORIGIN) private readonly webOrigin: string,
    @Inject(EXPERIMENT_SERVICE) private readonly experiments: ExperimentService,
  ) {}

  @Get('options')
  async listOptions(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Query('limit') limit: string | undefined,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const subject = await this.readSubject(request, reply);
    if (subject === null) return this.authProblem(request, reply);
    const parsedLimit = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      reply.code(400);
      return this.problem(request, 400, 'VALIDATION_ERROR', 'Experiment option limit is invalid.');
    }
    const options = await this.experiments.listOptions({
      actorSubject: subject,
      tenantId,
      workspaceId,
      limit: parsedLimit,
    });
    if (options === null) return this.notFound(request, reply);
    return ExperimentOptionsEnvelopeSchema.parse({
      data: { options },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post()
  async create(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const subject = await this.mutationSubject(request, reply);
    if (subject === null) return this.authProblem(request, reply);
    const parsed = CreateExperimentRequestSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return this.problem(request, 400, 'VALIDATION_ERROR', 'Experiment input is invalid.');
    }
    const result = await this.experiments.create({
      actorSubject: subject,
      tenantId,
      workspaceId,
      ...parsed.data,
    });
    if (result.outcome === 'NOT_FOUND') return this.notFound(request, reply);
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot create Experiments.');
    }
    if (result.outcome === 'PIPELINE_UNAVAILABLE') {
      reply.code(501);
      return this.problem(
        request,
        501,
        'EXPERIMENT_PIPELINE_UNAVAILABLE',
        'The durable Experiment store is not installed.',
      );
    }
    if (result.outcome === 'INCOMPATIBLE_SCENARIO') {
      reply.code(409);
      return {
        ...this.problem(
          request,
          409,
          'INCOMPATIBLE_SCENARIO',
          'The baseline and remeasurement cohorts cannot be compared directly.',
        ),
        comparison: result,
      };
    }
    if (result.outcome !== 'SUCCEEDED') {
      reply.code(409);
      return this.problem(request, 409, result.outcome, experimentConflictDetail(result.outcome));
    }
    reply.code(result.created ? 201 : 200);
    return ExperimentEnvelopeSchema.parse({
      data: { experiment: result.experiment },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Get(':experimentId')
  async get(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('experimentId') experimentId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const subject = await this.readSubject(request, reply);
    if (subject === null) return this.authProblem(request, reply);
    const experiment = await this.experiments.get({
      actorSubject: subject,
      tenantId,
      workspaceId,
      experimentId,
    });
    if (experiment === null) return this.notFound(request, reply);
    return ExperimentEnvelopeSchema.parse({
      data: { experiment },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  private async readSubject(request: FastifyRequest, reply: FastifyReply) {
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

function experimentConflictDetail(outcome: string): string {
  const details: Record<string, string> = {
    BASELINE_NOT_COMPLETED: 'The baseline must be sealed and COMPLETED.',
    REMEASUREMENT_NOT_COMPLETED: 'The remeasurement must be sealed and COMPLETED.',
    INVALID_RUN_KIND: 'Experiment requires one BASELINE and one REMEASUREMENT run.',
    EXACT_INTERVENTION_REQUIRED: 'The exact approved Artifact revision and hash are required.',
    INTERVENTION_NOT_APPLIED: 'The selected intervention is not approved or published.',
    INTERVENTION_OUTSIDE_MEASUREMENT_WINDOW:
      'The intervention must occur after baseline completion and before remeasurement begins.',
    SNAPSHOT_SET_MISMATCH: 'The immutable snapshot sets do not describe matching metrics.',
    IDEMPOTENCY_CONFLICT: 'This idempotency key was used for a different Experiment.',
  };
  return details[outcome] ?? 'The Experiment comparison was rejected.';
}
