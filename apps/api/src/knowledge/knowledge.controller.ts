import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { AuthService } from '@aeostudio/application/auth';
import type {
  KnowledgeContentMap,
  KnowledgeKind,
  KnowledgeService,
} from '@aeostudio/application/knowledge';
import { ProblemDetailsSchema, SCHEMA_VERSION } from '@aeostudio/contracts/auth';
import {
  AudiencePersonaEnvelopeSchema,
  AudiencePersonaInputSchema,
  AudiencePersonaListEnvelopeSchema,
  CompetitorSetEnvelopeSchema,
  CompetitorSetInputSchema,
  CompetitorSetListEnvelopeSchema,
  ContentPolicyEnvelopeSchema,
  ContentPolicyInputSchema,
  ContentPolicyListEnvelopeSchema,
  IndustryContextEnvelopeSchema,
  IndustryContextInputSchema,
  IndustryContextListEnvelopeSchema,
  PromotionStrategyEnvelopeSchema,
  PromotionStrategyInputSchema,
  PromotionStrategyListEnvelopeSchema,
} from '@aeostudio/contracts/knowledge';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AUTH_SERVICE, AUTH_WEB_ORIGIN } from '../auth/auth.tokens.js';
import { KNOWLEDGE_SERVICE } from './knowledge.tokens.js';

interface KnowledgeIssue {
  path: ReadonlyArray<PropertyKey>;
  code: string;
  message: string;
}

interface KnowledgeInputSchema {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: KnowledgeContentMap[KnowledgeKind] }
    | { success: false; error: { issues: ReadonlyArray<KnowledgeIssue> } };
}

type KnowledgeParseResult = ReturnType<KnowledgeInputSchema['safeParse']>;

interface KnowledgeEnvelopeSchema {
  parse(value: unknown): Record<string, unknown>;
}

interface KindConfig {
  input: KnowledgeInputSchema;
  envelope: KnowledgeEnvelopeSchema;
  list: KnowledgeEnvelopeSchema;
  dataKey: string;
  listKey: string;
}

const KIND_CONFIG: Record<KnowledgeKind, KindConfig> = {
  industryContext: {
    input: IndustryContextInputSchema,
    envelope: IndustryContextEnvelopeSchema,
    list: IndustryContextListEnvelopeSchema,
    dataKey: 'industryContext',
    listKey: 'industryContexts',
  },
  audiencePersona: {
    input: AudiencePersonaInputSchema,
    envelope: AudiencePersonaEnvelopeSchema,
    list: AudiencePersonaListEnvelopeSchema,
    dataKey: 'audiencePersona',
    listKey: 'audiencePersonas',
  },
  competitorSet: {
    input: CompetitorSetInputSchema,
    envelope: CompetitorSetEnvelopeSchema,
    list: CompetitorSetListEnvelopeSchema,
    dataKey: 'competitorSet',
    listKey: 'competitorSets',
  },
  promotionStrategy: {
    input: PromotionStrategyInputSchema,
    envelope: PromotionStrategyEnvelopeSchema,
    list: PromotionStrategyListEnvelopeSchema,
    dataKey: 'promotionStrategy',
    listKey: 'promotionStrategies',
  },
  contentPolicy: {
    input: ContentPolicyInputSchema,
    envelope: ContentPolicyEnvelopeSchema,
    list: ContentPolicyListEnvelopeSchema,
    dataKey: 'contentPolicy',
    listKey: 'contentPolicies',
  },
};

@Controller('api/v1/tenants/:tenantId/workspaces/:workspaceId')
export class KnowledgeController {
  constructor(
    @Inject(AUTH_SERVICE) private readonly authService: AuthService,
    @Inject(AUTH_WEB_ORIGIN) private readonly webOrigin: string,
    @Inject(KNOWLEDGE_SERVICE) private readonly knowledgeService: KnowledgeService,
  ) {}

  @Post('industry-context')
  createIndustryContext(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    return this.handleCreate(
      'industryContext',
      IndustryContextInputSchema.safeParse(body),
      tenantId,
      workspaceId,
      request,
      reply,
    );
  }

  @Get('industry-context')
  listIndustryContext(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    return this.handleList('industryContext', tenantId, workspaceId, request, reply);
  }

  @Post('audience-personas')
  createAudiencePersona(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    return this.handleCreate(
      'audiencePersona',
      AudiencePersonaInputSchema.safeParse(body),
      tenantId,
      workspaceId,
      request,
      reply,
    );
  }

  @Get('audience-personas')
  listAudiencePersonas(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    return this.handleList('audiencePersona', tenantId, workspaceId, request, reply);
  }

  @Post('competitor-sets')
  createCompetitorSet(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    return this.handleCreate(
      'competitorSet',
      CompetitorSetInputSchema.safeParse(body),
      tenantId,
      workspaceId,
      request,
      reply,
    );
  }

  @Get('competitor-sets')
  listCompetitorSets(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    return this.handleList('competitorSet', tenantId, workspaceId, request, reply);
  }

  @Post('promotion-strategy')
  createPromotionStrategy(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    return this.handleCreate(
      'promotionStrategy',
      PromotionStrategyInputSchema.safeParse(body),
      tenantId,
      workspaceId,
      request,
      reply,
    );
  }

  @Get('promotion-strategy')
  listPromotionStrategy(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    return this.handleList('promotionStrategy', tenantId, workspaceId, request, reply);
  }

  @Post('content-policy')
  createContentPolicy(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    return this.handleCreate(
      'contentPolicy',
      ContentPolicyInputSchema.safeParse(body),
      tenantId,
      workspaceId,
      request,
      reply,
    );
  }

  @Get('content-policy')
  listContentPolicy(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    return this.handleList('contentPolicy', tenantId, workspaceId, request, reply);
  }

  private async handleCreate(
    kind: KnowledgeKind,
    parsed: KnowledgeParseResult,
    tenantId: string,
    workspaceId: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const config = KIND_CONFIG[kind];
    if (request.headers.origin !== new URL(this.webOrigin).origin) {
      reply.code(403);
      return this.problem(request, 403, 'CSRF_REJECTED', 'The request origin is not allowed.');
    }
    const token = request.cookies['__Host-aeo_session'];
    const session = token === undefined ? null : await this.authService.getSession(token);
    if (session === null) {
      reply.code(401);
      return this.problem(request, 401, 'UNAUTHENTICATED', 'A valid server session is required.');
    }
    if (!parsed.success) {
      reply.code(400);
      return {
        ...this.problem(request, 400, 'VALIDATION_ERROR', 'Knowledge input is invalid.'),
        errors: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
          message: issue.message,
        })),
      };
    }

    const result = await this.knowledgeService.create({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
      kind,
      content: parsed.data,
    });
    if (result.outcome === 'NOT_FOUND') {
      reply.code(404);
      return this.problem(
        request,
        404,
        'NOT_FOUND_OR_FORBIDDEN',
        'The requested resource was not found.',
      );
    }
    if (result.outcome === 'FORBIDDEN') {
      reply.code(403);
      return this.problem(request, 403, 'FORBIDDEN', 'The active role cannot edit knowledge.');
    }

    reply.code(201);
    return config.envelope.parse({
      data: { [config.dataKey]: result.revision },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  private async handleList(
    kind: KnowledgeKind,
    tenantId: string,
    workspaceId: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const config = KIND_CONFIG[kind];
    const token = request.cookies['__Host-aeo_session'];
    const session = token === undefined ? null : await this.authService.getSession(token);
    if (session === null) {
      reply.code(401);
      return this.problem(request, 401, 'UNAUTHENTICATED', 'A valid server session is required.');
    }
    const result = await this.knowledgeService.list({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
      kind,
    });
    if (result.outcome === 'NOT_FOUND') {
      reply.code(404);
      return this.problem(
        request,
        404,
        'NOT_FOUND_OR_FORBIDDEN',
        'The requested resource was not found.',
      );
    }
    return config.list.parse({
      data: { [config.listKey]: result.revisions },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
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
