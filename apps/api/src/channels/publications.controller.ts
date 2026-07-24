import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { AuthService, ServerSession } from '@aeostudio/application/auth';
import type {
  PublicationCommandService,
  PublicationEligibilityService,
  PublicationQueryService,
  PublicationRemoteStatusRefreshService,
} from '@aeostudio/application/channels-publishing';
import { ProblemDetailsSchema, SCHEMA_VERSION } from '@aeostudio/contracts/auth';
import {
  CheckPublicationEligibilitySchema,
  ExportOnlyPublicationProblemSchema,
  PublicationCommandEnvelopeSchema,
  PublicationDetailEnvelopeSchema,
  PublicationEligibilityEnvelopeSchema,
  PublicationRecordSchema,
  PublicationRemoteStatusRefreshEnvelopeSchema,
  RequestPublicationSchema,
} from '@aeostudio/contracts/channels';
import type { PublicationRecord } from '@aeostudio/domain/channels-publishing';
import type { JobTraceContextProvider } from '@aeostudio/application/jobs-budgets';
import type { StructuredApplicationLogger } from '@aeostudio/adapters/observability';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AUTH_SERVICE, AUTH_WEB_ORIGIN } from '../auth/auth.tokens.js';
import {
  APPLICATION_LOGGER,
  JOB_TRACE_CONTEXT_PROVIDER,
} from '../observability/observability.tokens.js';
import {
  PUBLICATION_COMMAND_SERVICE,
  PUBLICATION_ELIGIBILITY_SERVICE,
  PUBLICATION_QUERY_SERVICE,
  PUBLICATION_REMOTE_STATUS_REFRESH_SERVICE,
} from './channels.tokens.js';

@Controller('api/v1/tenants/:tenantId/workspaces/:workspaceId/publications')
export class PublicationsController {
  constructor(
    @Inject(AUTH_SERVICE) private readonly authService: AuthService,
    @Inject(AUTH_WEB_ORIGIN) private readonly webOrigin: string,
    @Inject(PUBLICATION_COMMAND_SERVICE)
    private readonly publications: PublicationCommandService,
    @Inject(PUBLICATION_ELIGIBILITY_SERVICE)
    private readonly eligibility: PublicationEligibilityService,
    @Inject(PUBLICATION_QUERY_SERVICE)
    private readonly publicationQueries: PublicationQueryService,
    @Inject(PUBLICATION_REMOTE_STATUS_REFRESH_SERVICE)
    private readonly remoteStatusRefresh: PublicationRemoteStatusRefreshService,
    @Inject(JOB_TRACE_CONTEXT_PROVIDER)
    private readonly traces: JobTraceContextProvider,
    @Inject(APPLICATION_LOGGER)
    private readonly logger: StructuredApplicationLogger,
  ) {}

  @Post('eligibility')
  @HttpCode(200)
  async checkEligibility(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const authentication = await this.authenticatedMutation(request, reply);
    if (authentication === null) return this.authenticationProblem(request, reply);
    const parsed = CheckPublicationEligibilitySchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return this.problem(request, 400, 'VALIDATION_ERROR', 'Eligibility input is invalid.');
    }
    const { adapterVersionId, ...eligibilityInput } = parsed.data;
    const result = await this.eligibility.check({
      actorSubject: authentication.session.subject,
      sessionToken: authentication.sessionToken,
      tenantId,
      workspaceId,
      ...eligibilityInput,
      ...(adapterVersionId === undefined ? {} : { adapterVersionId }),
    });
    if (result.outcome === 'NOT_FOUND') return this.notFoundProblem(request, reply);
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot publish.');
    }
    if (result.outcome === 'PACKAGE_CHECKSUM_MISMATCH') {
      reply.code(409);
      return this.problem(
        request,
        409,
        'CHANNEL_PACKAGE_HASH_MISMATCH',
        'The expected Channel Package checksum does not match.',
      );
    }
    if (result.outcome === 'PACKAGE_INTEGRITY_INVALID') {
      reply.code(409);
      return this.problem(
        request,
        409,
        'CHANNEL_PACKAGE_INTEGRITY_INVALID',
        'The immutable Channel Package failed integrity verification.',
      );
    }
    if (result.outcome === 'APPROVAL_REQUIRED' || result.outcome === 'APPROVAL_STALE') {
      reply.code(409);
      return this.problem(
        request,
        409,
        result.outcome,
        result.outcome === 'APPROVAL_REQUIRED'
          ? 'The exact Artifact revision is not approved.'
          : 'The exact Artifact approval or source lineage is stale.',
      );
    }
    if (result.outcome !== 'EXPORT_ONLY' && result.outcome !== 'READY') {
      throw new Error('UNHANDLED_PUBLICATION_ELIGIBILITY_OUTCOME');
    }
    const scopeHref = `/api/v1/tenants/${tenantId}/workspaces/${workspaceId}`;
    const exportLink = {
      href: `${scopeHref}/channel-packages/${result.packageId}/export`,
      packageChecksum: result.packageChecksum,
    };
    if (result.outcome === 'EXPORT_ONLY') {
      return PublicationEligibilityEnvelopeSchema.parse({
        data: {
          eligibility: {
            mode: 'EXPORT_ONLY',
            packageId: result.packageId,
            packageChecksum: result.packageChecksum,
            reasons: result.reasons,
          },
          export: exportLink,
        },
        meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
      });
    }
    return PublicationEligibilityEnvelopeSchema.parse({
      data: {
        eligibility: {
          mode: 'PUBLISH_READY',
          packageId: result.packageId,
          packageChecksum: result.packageChecksum,
          adapterVersionId: result.adapter.id,
          channelAuthorizationId: result.authorization.id,
        },
        export: exportLink,
      },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post()
  async requestPublication(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const authentication = await this.authenticatedMutation(request, reply);
    if (authentication === null) return this.authenticationProblem(request, reply);
    const parsed = RequestPublicationSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return this.problem(request, 400, 'VALIDATION_ERROR', 'Publication input is invalid.');
    }
    const { adapterVersionId, ...publicationInput } = parsed.data;
    const traceContext = this.traces.capture(request.id);
    const result = await this.publications.request({
      actorSubject: authentication.session.subject,
      sessionToken: authentication.sessionToken,
      tenantId,
      workspaceId,
      ...publicationInput,
      ...(adapterVersionId === undefined ? {} : { adapterVersionId }),
      ...(traceContext === undefined ? {} : { traceContext }),
    });
    if (result.outcome === 'NOT_FOUND') return this.notFoundProblem(request, reply);
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot publish.');
    }
    if (result.outcome === 'PACKAGE_CHECKSUM_MISMATCH') {
      reply.code(409);
      return this.problem(
        request,
        409,
        'CHANNEL_PACKAGE_HASH_MISMATCH',
        'The expected Channel Package checksum does not match.',
      );
    }
    if (result.outcome === 'PACKAGE_INTEGRITY_INVALID') {
      reply.code(409);
      return this.problem(
        request,
        409,
        'CHANNEL_PACKAGE_INTEGRITY_INVALID',
        'The immutable Channel Package failed integrity verification.',
      );
    }
    if (result.outcome === 'APPROVAL_REQUIRED' || result.outcome === 'APPROVAL_STALE') {
      reply.code(409);
      return this.problem(
        request,
        409,
        result.outcome,
        result.outcome === 'APPROVAL_REQUIRED'
          ? 'The exact Artifact revision is not approved.'
          : 'The exact Artifact approval or source lineage is stale.',
      );
    }
    if (result.outcome === 'IDEMPOTENCY_CONFLICT') {
      reply.code(409);
      return this.problem(
        request,
        409,
        'IDEMPOTENCY_CONFLICT',
        'This idempotency key was already used for a different publication command.',
      );
    }
    if (result.outcome === 'EXPORT_ONLY') {
      reply.code(409);
      const scopeHref = `/api/v1/tenants/${tenantId}/workspaces/${workspaceId}`;
      return ExportOnlyPublicationProblemSchema.parse({
        ...this.problem(
          request,
          409,
          'EXPORT_ONLY',
          'This Channel handoff is available only as a reviewed export.',
        ),
        eligibility: {
          mode: 'EXPORT_ONLY',
          packageId: result.packageId,
          packageChecksum: result.packageChecksum,
          reasons: result.reasons,
        },
        export: {
          href: `${scopeHref}/channel-packages/${result.packageId}/export`,
          packageChecksum: result.packageChecksum,
        },
      });
    }

    if (result.outcome === 'PIPELINE_UNAVAILABLE') {
      // A runtime implementation alone is not a publication pipeline. Fail closed unless a
      // durable command store is explicitly installed.
      reply.code(501);
      return this.problem(
        request,
        501,
        'PUBLICATION_PIPELINE_UNAVAILABLE',
        'The durable publication pipeline is not installed.',
      );
    }
    if (result.outcome !== 'SUCCEEDED') throw new Error('UNHANDLED_PUBLICATION_COMMAND_OUTCOME');

    const budgetLogInput = {
      correlation: { requestId: request.id, jobId: result.job.id },
      attributes: {
        tenantId,
        workspaceId,
        publicationId: result.publication.id,
        outcome: result.job.status,
      },
    };
    if (result.job.budgetWarning) this.logger.warn('BUDGET_WARNING', budgetLogInput);
    if (result.job.status === 'BUDGET_BLOCKED') {
      this.logger.warn('BUDGET_BLOCKED', budgetLogInput);
    }

    reply.code(result.created ? 202 : 200);
    return PublicationCommandEnvelopeSchema.parse({
      data: {
        publication: {
          id: result.publication.id,
          status: result.publication.status,
          channelPackageId: result.publication.channelPackageId,
          packageChecksum: result.publication.packageChecksum,
          artifactRevisionId: result.publication.artifactRevisionId,
          artifactContentHash: result.publication.artifactContentHash,
          adapterVersionId: result.publication.adapterVersionId,
          channelAuthorizationId: result.publication.channelAuthorizationId,
          target: result.publication.target,
          idempotencyKey: result.publication.idempotencyKey,
          remoteRef: result.publication.remoteRef,
          remoteState: result.publication.remoteState ?? null,
          requestedByUserId: result.publication.requestedByUserId,
          createdAt: result.publication.createdAt,
          updatedAt: result.publication.updatedAt,
        },
        job: result.job,
        created: result.created,
      },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Get(':publicationId')
  async getPublication(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('publicationId') publicationId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const token = request.cookies['__Host-aeo_session'];
    const session = token === undefined ? null : await this.authService.getSession(token);
    if (session === null) return this.authenticationProblem(request, reply);
    if (!PublicationRecordSchema.shape.id.safeParse(publicationId).success) {
      return this.notFoundProblem(request, reply);
    }
    const detail = await this.publicationQueries.get({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
      publicationId,
    });
    if (detail === null) return this.notFoundProblem(request, reply);
    return PublicationDetailEnvelopeSchema.parse({
      data: {
        publication: publicPublication(detail.publication),
        attempts: detail.attempts.map((attempt) => ({
          id: attempt.id,
          publicationId: attempt.publicationId,
          attemptNumber: attempt.attemptNumber,
          operation: attempt.operation,
          outcome: attempt.outcome,
          remoteRef: attempt.remoteRef,
          errorCode: attempt.errorCode,
          startedAt: attempt.startedAt,
          finishedAt: attempt.finishedAt,
        })),
        job: detail.job,
      },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post(':publicationId/remote-status/refresh')
  @HttpCode(200)
  async refreshRemoteStatus(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('publicationId') publicationId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const authentication = await this.authenticatedMutation(request, reply);
    if (authentication === null) return this.authenticationProblem(request, reply);
    if (!PublicationRecordSchema.shape.id.safeParse(publicationId).success) {
      return this.notFoundProblem(request, reply);
    }
    const result = await this.remoteStatusRefresh.refresh({
      actorSubject: authentication.session.subject,
      tenantId,
      workspaceId,
      publicationId,
    });
    if (result.outcome === 'NOT_FOUND') return this.notFoundProblem(request, reply);
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot refresh status.');
    }
    if (result.outcome === 'INVALID_STATE') {
      reply.code(409);
      return this.problem(
        request,
        409,
        'PUBLICATION_REMOTE_STATUS_NOT_REFRESHABLE',
        'This Publication has no refreshable remote effect.',
      );
    }
    if (result.outcome === 'GATE_REJECTED') {
      reply.code(409);
      return this.problem(
        request,
        409,
        'PUBLICATION_REMOTE_STATUS_GATE_REJECTED',
        'The current Publication, Adapter, or authorization gate rejected the refresh.',
      );
    }
    if (result.outcome === 'ADAPTER_UNAVAILABLE') {
      reply.code(501);
      return this.problem(
        request,
        501,
        'PUBLICATION_REMOTE_STATUS_ADAPTER_UNAVAILABLE',
        'No approved remote-status Adapter runtime is installed.',
      );
    }
    if (result.outcome === 'REMOTE_STATUS_UNAVAILABLE') {
      reply.code(503);
      return this.problem(
        request,
        503,
        'PUBLICATION_REMOTE_STATUS_UNAVAILABLE',
        'The Provider status could not be confirmed.',
      );
    }
    if (result.outcome === 'REMOTE_STATUS_INVALID') {
      reply.code(502);
      return this.problem(
        request,
        502,
        'PUBLICATION_REMOTE_STATUS_INVALID',
        'The Provider returned a mismatched or invalid remote status.',
      );
    }
    if (!('publication' in result)) throw new Error('UNHANDLED_REMOTE_STATUS_REFRESH_OUTCOME');
    return PublicationRemoteStatusRefreshEnvelopeSchema.parse({
      data: { publication: publicPublication(result.publication) },
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

  private authenticationProblem(request: FastifyRequest, reply: FastifyReply) {
    if (reply.statusCode === 403) {
      return this.problem(request, 403, 'CSRF_REJECTED', 'The request origin is not allowed.');
    }
    reply.code(401);
    return this.problem(request, 401, 'UNAUTHENTICATED', 'A valid session is required.');
  }

  private notFoundProblem(request: FastifyRequest, reply: FastifyReply) {
    reply.code(404);
    return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
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

function publicPublication(publication: PublicationRecord) {
  return {
    id: publication.id,
    status: publication.status,
    channelPackageId: publication.channelPackageId,
    packageChecksum: publication.packageChecksum,
    artifactRevisionId: publication.artifactRevisionId,
    artifactContentHash: publication.artifactContentHash,
    adapterVersionId: publication.adapterVersionId,
    channelAuthorizationId: publication.channelAuthorizationId,
    target: publication.target,
    idempotencyKey: publication.idempotencyKey,
    remoteRef: publication.remoteRef,
    remoteState: publication.remoteState ?? null,
    requestedByUserId: publication.requestedByUserId,
    createdAt: publication.createdAt,
    updatedAt: publication.updatedAt,
  };
}
