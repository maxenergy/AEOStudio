import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import { ProblemDetailsSchema, SCHEMA_VERSION } from '@aeostudio/contracts/auth';
import { TenantDeletionReceiptEnvelopeSchema } from '@aeostudio/contracts/privacy-audit';
import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  DELETION_RECEIPT_COOKIE,
  type DeletionReceiptTokenService,
} from './deletion-receipt-token.js';
import { DELETION_RECEIPT_TOKEN_SERVICE } from './privacy.tokens.js';

@Controller('api/v1/privacy/deletion-receipts')
export class DeletionReceiptController {
  public constructor(
    @Inject(DELETION_RECEIPT_TOKEN_SERVICE)
    private readonly tokens: DeletionReceiptTokenService,
  ) {}

  @Get('current')
  current(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Record<string, unknown> {
    reply.header('cache-control', 'private, no-store');
    const token = request.cookies[DELETION_RECEIPT_COOKIE];
    const receipt = token === undefined ? null : this.tokens.verify(token);
    if (receipt === null) {
      reply.code(401);
      return ProblemDetailsSchema.parse({
        type: 'https://aeostudio.local/problems/deletion-receipt-unavailable',
        title: 'Receipt unavailable',
        status: 401,
        code: 'DELETION_RECEIPT_UNAVAILABLE',
        detail: 'A valid short-lived deletion receipt capability is required.',
        requestId: request.id,
        retryable: false,
      });
    }
    return TenantDeletionReceiptEnvelopeSchema.parse({
      data: { receipt },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }
}
