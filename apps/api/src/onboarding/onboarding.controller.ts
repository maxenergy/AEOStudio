import { Controller, Get, Inject, Param, Req, Res } from '@nestjs/common';
import type { AuthService } from '@aeostudio/application/auth';
import type { OnboardingService } from '@aeostudio/application/onboarding';
import { ProblemDetailsSchema, SCHEMA_VERSION } from '@aeostudio/contracts/auth';
import {
  OnboardingStateEnvelopeSchema,
  ReadinessEnvelopeSchema,
} from '@aeostudio/contracts/onboarding';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AUTH_SERVICE } from '../auth/auth.tokens.js';
import { ONBOARDING_SERVICE } from './onboarding.tokens.js';

@Controller('api/v1/tenants/:tenantId/workspaces/:workspaceId')
export class OnboardingController {
  constructor(
    @Inject(AUTH_SERVICE) private readonly authService: AuthService,
    @Inject(ONBOARDING_SERVICE)
    private readonly onboardingService: OnboardingService,
  ) {}

  @Get('onboarding-state')
  async getOnboardingState(
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

    const result = await this.onboardingService.getOnboardingState({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
    });

    if (result.outcome === 'NOT_FOUND') {
      reply.code(404);
      return this.problem(
        request,
        404,
        'NOT_FOUND_OR_FORBIDDEN',
        'The requested workspace was not found.',
      );
    }

    return OnboardingStateEnvelopeSchema.parse({
      data: { onboardingState: result.state },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Get('readiness')
  async getReadiness(
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

    const result = await this.onboardingService.getReadiness({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
    });

    if (result.outcome === 'NOT_FOUND') {
      reply.code(404);
      return this.problem(
        request,
        404,
        'NOT_FOUND_OR_FORBIDDEN',
        'The requested workspace was not found.',
      );
    }

    return ReadinessEnvelopeSchema.parse({
      data: { readiness: result.readiness },
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
