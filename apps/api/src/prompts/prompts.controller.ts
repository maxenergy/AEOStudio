import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { AuthService } from '@aeostudio/application/auth';
import type { PromptResearchService } from '@aeostudio/application/prompt-research';
import { ProblemDetailsSchema, SCHEMA_VERSION } from '@aeostudio/contracts/auth';
import {
  ApprovePromptRevisionRequestSchema,
  ApprovedPromptSetListEnvelopeSchema,
  CreatePromptRevisionRequestSchema,
  PromptBundleEnvelopeSchema,
  PromptRegistryEnvelopeSchema,
  ProposePromptSetRequestSchema,
} from '@aeostudio/contracts/prompt-research';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AUTH_SERVICE, AUTH_WEB_ORIGIN } from '../auth/auth.tokens.js';
import { PROMPT_RESEARCH_SERVICE } from './prompts.tokens.js';

@Controller('api/v1/tenants/:tenantId/workspaces/:workspaceId')
export class PromptsController {
  constructor(
    @Inject(AUTH_SERVICE) private readonly authService: AuthService,
    @Inject(AUTH_WEB_ORIGIN) private readonly webOrigin: string,
    @Inject(PROMPT_RESEARCH_SERVICE) private readonly prompts: PromptResearchService,
  ) {}

  @Get('measurement-registry')
  async registry(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const subject = await this.readSubject(request, reply);
    if (subject === null) return this.problem(request, 401, 'UNAUTHENTICATED', 'Login required.');
    const entries = await this.prompts.listRegistry({
      actorSubject: subject,
      tenantId,
      workspaceId,
    });
    if (entries === null) {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    return PromptRegistryEnvelopeSchema.parse({
      data: { entries },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post('prompt-sets/proposals')
  async propose(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const subject = await this.mutationSubject(request, reply);
    if (subject === null) return this.authProblem(request, reply);
    const parsed = ProposePromptSetRequestSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return this.problem(request, 400, 'VALIDATION_ERROR', 'Prompt proposal input is invalid.');
    }
    const result = await this.prompts.propose({
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
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot propose Prompt Sets.');
    }
    reply.code(201);
    return PromptBundleEnvelopeSchema.parse({
      data: result.bundle,
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post('prompt-sets/:promptSetId/revisions')
  async revise(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('promptSetId') promptSetId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const subject = await this.mutationSubject(request, reply);
    if (subject === null) return this.authProblem(request, reply);
    const parsed = CreatePromptRevisionRequestSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return this.problem(request, 400, 'VALIDATION_ERROR', 'Prompt revision input is invalid.');
    }
    const result = await this.prompts.revise({
      actorSubject: subject,
      tenantId,
      workspaceId,
      promptSetId,
      ...parsed.data,
    });
    if (result.outcome === 'NOT_FOUND') {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot edit Prompt Sets.');
    }
    reply.code(201);
    return PromptBundleEnvelopeSchema.parse({
      data: result.bundle,
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post('prompt-sets/:promptSetId/revisions/:revisionId/approve')
  async approve(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('promptSetId') promptSetId: string,
    @Param('revisionId') revisionId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const subject = await this.mutationSubject(request, reply);
    if (subject === null) return this.authProblem(request, reply);
    const parsed = ApprovePromptRevisionRequestSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return this.problem(request, 400, 'VALIDATION_ERROR', 'Approval hashes are invalid.');
    }
    const result = await this.prompts.approve({
      actorSubject: subject,
      tenantId,
      workspaceId,
      promptSetId,
      revisionId,
      ...parsed.data,
    });
    if (result.outcome === 'NOT_FOUND') {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot approve Prompt Sets.');
    }
    if (result.outcome === 'HASH_MISMATCH') {
      reply.code(409);
      return this.problem(
        request,
        409,
        'PROMPT_APPROVAL_HASH_MISMATCH',
        'Approval applies only to the exact current Prompt and Scenario hashes.',
      );
    }
    if (result.outcome === 'NOT_APPROVABLE') {
      reply.code(409);
      return {
        ...this.problem(
          request,
          409,
          'PROMPT_SCENARIO_NOT_APPROVABLE',
          'Prompt Set or Measurement Scenario approval requirements are incomplete.',
        ),
        fieldErrors: result.issues,
      };
    }
    reply.code(200);
    return PromptBundleEnvelopeSchema.parse({
      data: result.bundle,
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Get('prompt-sets/approved')
  async listApproved(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const subject = await this.readSubject(request, reply);
    if (subject === null) return this.problem(request, 401, 'UNAUTHENTICATED', 'Login required.');
    const promptSets = await this.prompts.listApprovedPromptSets({
      actorSubject: subject,
      tenantId,
      workspaceId,
    });
    if (promptSets === null) {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    return ApprovedPromptSetListEnvelopeSchema.parse({
      data: { promptSets },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Get('prompt-sets/:promptSetId')
  async current(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('promptSetId') promptSetId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const subject = await this.readSubject(request, reply);
    if (subject === null) return this.problem(request, 401, 'UNAUTHENTICATED', 'Login required.');
    const bundle = await this.prompts.getCurrent({
      actorSubject: subject,
      tenantId,
      workspaceId,
      promptSetId,
    });
    if (bundle === null) {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    return PromptBundleEnvelopeSchema.parse({
      data: bundle,
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Get('prompt-sets/:promptSetId/revisions/:revisionId')
  async revision(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('promptSetId') promptSetId: string,
    @Param('revisionId') revisionId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const subject = await this.readSubject(request, reply);
    if (subject === null) return this.problem(request, 401, 'UNAUTHENTICATED', 'Login required.');
    const bundle = await this.prompts.getRevision({
      actorSubject: subject,
      tenantId,
      workspaceId,
      promptSetId,
      revisionId,
    });
    if (bundle === null) {
      reply.code(404);
      return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
    }
    return PromptBundleEnvelopeSchema.parse({
      data: bundle,
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  private async readSubject(request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    const token = request.cookies['__Host-aeo_session'];
    const session = token === undefined ? null : await this.authService.getSession(token);
    if (session === null) reply.code(401);
    return session?.subject ?? null;
  }

  private async mutationSubject(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<string | null> {
    if (request.headers.origin !== new URL(this.webOrigin).origin) {
      reply.code(403);
      return null;
    }
    return this.readSubject(request, reply);
  }

  private authProblem(request: FastifyRequest, reply: FastifyReply): Record<string, unknown> {
    return this.problem(
      request,
      reply.statusCode,
      reply.statusCode === 403 ? 'CSRF_REJECTED' : 'UNAUTHENTICATED',
      'Authentication failed.',
    );
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
