import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { AuthService, ServerSession } from '@aeostudio/application/auth';
import type { ArtifactService } from '@aeostudio/application/artifacts';
import type { JobTraceContextProvider } from '@aeostudio/application/jobs-budgets';
import type { StructuredApplicationLogger } from '@aeostudio/adapters/observability';
import { ProblemDetailsSchema, SCHEMA_VERSION } from '@aeostudio/contracts/auth';
import {
  ArtifactBundleEnvelopeSchema,
  CreateArtifactRevisionEnvelopeSchema,
  CreateArtifactRevisionRequestSchema,
  ReviewArtifactRevisionEnvelopeSchema,
  ReviewArtifactRevisionRequestSchema,
  StartArtifactGenerationEnvelopeSchema,
  StartArtifactGenerationRequestSchema,
  SubmitArtifactRevisionEnvelopeSchema,
  SubmitArtifactRevisionRequestSchema,
} from '@aeostudio/contracts/artifacts';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AUTH_SERVICE, AUTH_WEB_ORIGIN } from '../auth/auth.tokens.js';
import { emitJobBudgetSignals } from '../observability/job-budget-signals.js';
import {
  APPLICATION_LOGGER,
  JOB_TRACE_CONTEXT_PROVIDER,
} from '../observability/observability.tokens.js';
import { ARTIFACT_SERVICE } from './artifacts.tokens.js';

@Controller('api/v1/tenants/:tenantId/workspaces/:workspaceId/artifacts')
export class ArtifactsController {
  constructor(
    @Inject(AUTH_SERVICE) private readonly authService: AuthService,
    @Inject(AUTH_WEB_ORIGIN) private readonly webOrigin: string,
    @Inject(ARTIFACT_SERVICE) private readonly artifacts: ArtifactService,
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
    const authentication = await this.authenticatedMutation(request, reply);
    if (authentication === null) return this.authenticationProblem(request, reply);
    const parsed = StartArtifactGenerationRequestSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return this.problem(request, 400, 'VALIDATION_ERROR', 'Artifact input is invalid.');
    }
    const { estimatedUnits, ...generationInput } = parsed.data;
    void estimatedUnits;
    const traceContext = this.traces.capture(request.id);
    const result = await this.artifacts.startGeneration({
      actorSubject: authentication.session.subject,
      tenantId,
      workspaceId,
      ...generationInput,
      ...(traceContext === undefined ? {} : { traceContext }),
    });
    if (result.outcome === 'NOT_FOUND') {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot generate Artifacts.');
    }
    if (result.outcome === 'INVALID_REFERENCE') {
      reply.code(409);
      return {
        ...this.problem(
          request,
          409,
          'ARTIFACT_INVALID_REFERENCE',
          'Generation requires an approved Brief and current approved Claim evidence.',
        ),
        referenceType: result.referenceType,
      };
    }
    emitJobBudgetSignals(this.logger, {
      requestId: request.id,
      tenantId,
      workspaceId,
      aggregateId: result.artifact.id,
      job: result.job,
    });
    reply.code(202);
    return StartArtifactGenerationEnvelopeSchema.parse({
      data: { artifact: result.artifact, job: result.job },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Get(':artifactId')
  async get(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('artifactId') artifactId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const token = request.cookies['__Host-aeo_session'];
    if (token === undefined) return this.authenticationProblem(request, reply);
    const session = await this.authService.getSession(token);
    if (session === null) return this.authenticationProblem(request, reply);
    const bundle = await this.artifacts.getArtifact({
      actorSubject: session.subject,
      sessionToken: token,
      tenantId,
      workspaceId,
      artifactId,
    });
    if (bundle === null) {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    return ArtifactBundleEnvelopeSchema.parse({
      data: bundle,
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post(':artifactId/revisions')
  async createRevision(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('artifactId') artifactId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const authentication = await this.authenticatedMutation(request, reply);
    if (authentication === null) return this.authenticationProblem(request, reply);
    const parsed = CreateArtifactRevisionRequestSchema.safeParse(body);
    if (!parsed.success) return this.validationProblem(request, reply);
    const result = await this.artifacts.createRevision({
      actorSubject: authentication.session.subject,
      tenantId,
      workspaceId,
      artifactId,
      ...parsed.data,
    });
    if (result.outcome === 'NOT_FOUND') return this.notFoundProblem(request, reply);
    if (result.outcome === 'FORBIDDEN') return this.forbiddenProblem(request, reply);
    if (result.outcome === 'REVISION_CONFLICT') {
      reply.code(409);
      return this.problem(request, 409, 'REVISION_CONFLICT', 'Artifact current revision changed.');
    }
    if (result.outcome === 'INVALID_REFERENCE') {
      reply.code(409);
      return this.problem(
        request,
        409,
        'APPROVAL_STALE',
        'Artifact lineage or Claim evidence is stale.',
      );
    }
    if (result.outcome !== 'SUCCEEDED') throw new Error('UNHANDLED_ARTIFACT_REVISION_OUTCOME');
    reply.code(201);
    return CreateArtifactRevisionEnvelopeSchema.parse({
      data: { artifact: result.artifact, revision: result.revision },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post(':artifactId/revisions/:revision/submit')
  async submitRevision(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('artifactId') artifactId: string,
    @Param('revision') revisionParam: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const authentication = await this.authenticatedMutation(request, reply);
    if (authentication === null) return this.authenticationProblem(request, reply);
    const parsed = SubmitArtifactRevisionRequestSchema.safeParse(body);
    const revision = Number(revisionParam);
    if (!parsed.success || !Number.isSafeInteger(revision) || revision < 1) {
      return this.validationProblem(request, reply);
    }
    const result = await this.artifacts.submitRevision({
      actorSubject: authentication.session.subject,
      sessionToken: authentication.sessionToken,
      tenantId,
      workspaceId,
      artifactId,
      revision,
      ...parsed.data,
    });
    if (result.outcome === 'NOT_FOUND') return this.notFoundProblem(request, reply);
    if (result.outcome === 'FORBIDDEN') return this.forbiddenProblem(request, reply);
    if (result.outcome === 'HASH_MISMATCH') {
      reply.code(409);
      return this.problem(request, 409, 'ARTIFACT_REVIEW_HASH_MISMATCH', 'Revision hash differs.');
    }
    if (result.outcome === 'INVALID_STATE') {
      reply.code(409);
      return this.problem(request, 409, 'ARTIFACT_INVALID_STATE', 'Revision is not a Draft.');
    }
    if (result.outcome === 'INVALID_PAYLOAD') {
      reply.code(409);
      return this.problem(
        request,
        409,
        'ARTIFACT_PAYLOAD_INTEGRITY',
        'Stored Artifact payload does not match its immutable revision hash.',
      );
    }
    if (result.outcome !== 'SUCCEEDED') throw new Error('UNHANDLED_ARTIFACT_SUBMIT_OUTCOME');
    reply.code(200);
    return SubmitArtifactRevisionEnvelopeSchema.parse({
      data: { revision: result.revision },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post(':artifactId/revisions/:revision/review')
  async reviewRevision(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('artifactId') artifactId: string,
    @Param('revision') revisionParam: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const authentication = await this.authenticatedMutation(request, reply);
    if (authentication === null) return this.authenticationProblem(request, reply);
    const parsed = ReviewArtifactRevisionRequestSchema.safeParse(body);
    const revision = Number(revisionParam);
    if (!parsed.success || !Number.isSafeInteger(revision) || revision < 1) {
      return this.validationProblem(request, reply);
    }
    const result = await this.artifacts.reviewRevision({
      actorSubject: authentication.session.subject,
      sessionToken: authentication.sessionToken,
      tenantId,
      workspaceId,
      artifactId,
      revision,
      ...parsed.data,
    });
    if (result.outcome === 'NOT_FOUND') return this.notFoundProblem(request, reply);
    if (result.outcome === 'FORBIDDEN') return this.forbiddenProblem(request, reply);
    if (result.outcome === 'HASH_MISMATCH') {
      reply.code(409);
      return this.problem(request, 409, 'ARTIFACT_REVIEW_HASH_MISMATCH', 'Review hash differs.');
    }
    if (result.outcome === 'SELF_APPROVAL') {
      reply.code(409);
      return this.problem(
        request,
        409,
        'SELF_APPROVAL_FORBIDDEN',
        'Revision creator cannot approve it.',
      );
    }
    if (result.outcome === 'ALREADY_REVIEWED') {
      reply.code(409);
      return this.problem(request, 409, 'ARTIFACT_ALREADY_REVIEWED', 'Review is immutable.');
    }
    if (result.outcome === 'INVALID_STATE') {
      reply.code(409);
      return this.problem(request, 409, 'ARTIFACT_INVALID_STATE', 'Revision is not in review.');
    }
    if (result.outcome === 'INVALID_REFERENCE') {
      reply.code(409);
      return this.problem(
        request,
        409,
        'APPROVAL_STALE',
        'Artifact lineage or Claim evidence changed before review.',
      );
    }
    if (result.outcome === 'INVALID_PAYLOAD') {
      reply.code(409);
      return this.problem(
        request,
        409,
        'ARTIFACT_PAYLOAD_INTEGRITY',
        'Stored Artifact payload does not match its immutable revision hash.',
      );
    }
    if (result.outcome !== 'SUCCEEDED') throw new Error('UNHANDLED_ARTIFACT_REVIEW_OUTCOME');
    reply.code(200);
    return ReviewArtifactRevisionEnvelopeSchema.parse({
      data: { revision: result.revision, review: result.review },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  private async authenticatedMutation(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ session: ServerSession; sessionToken: string } | null> {
    if (request.headers.origin !== new URL(this.webOrigin).origin) {
      reply.code(403);
      return null;
    }
    const token = request.cookies['__Host-aeo_session'];
    if (token === undefined) return null;
    const session = await this.authService.getSession(token);
    return session === null ? null : { session, sessionToken: token };
  }

  private validationProblem(request: FastifyRequest, reply: FastifyReply) {
    reply.code(400);
    return this.problem(request, 400, 'VALIDATION_ERROR', 'Artifact revision input is invalid.');
  }

  private notFoundProblem(request: FastifyRequest, reply: FastifyReply) {
    reply.code(404);
    return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
  }

  private forbiddenProblem(request: FastifyRequest, reply: FastifyReply) {
    reply.code(403);
    return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot perform this action.');
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
