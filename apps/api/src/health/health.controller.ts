import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import {
  HealthEnvelopeSchema,
  ProblemDetailsSchema,
  SCHEMA_VERSION,
} from '@aeostudio/contracts/auth';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { READINESS_CHECK } from './health.tokens.js';

export type ReadinessCheck = () => Promise<boolean>;

@Controller()
export class HealthController {
  constructor(@Inject(READINESS_CHECK) private readonly readiness: ReadinessCheck) {}

  @Get('health')
  health(@Req() request: FastifyRequest): Record<string, unknown> {
    return HealthEnvelopeSchema.parse({
      data: { status: 'alive' },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Get('ready')
  async ready(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    if (!(await this.readiness())) {
      reply.code(503);
      return ProblemDetailsSchema.parse({
        type: 'https://aeostudio.local/problems/dependency-not-ready',
        title: 'Dependency not ready',
        status: 503,
        code: 'DEPENDENCY_NOT_READY',
        detail: 'At least one required dependency is unavailable.',
        requestId: request.id,
        retryable: true,
      });
    }

    return HealthEnvelopeSchema.parse({
      data: { status: 'ready' },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }
}
