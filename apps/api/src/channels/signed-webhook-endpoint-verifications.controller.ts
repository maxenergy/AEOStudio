import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { AuthService, ServerSession } from '@aeostudio/application/auth';
import type { SignedWebhookEndpointVerificationService } from '@aeostudio/application/channels-publishing';
import { ProblemDetailsSchema, SCHEMA_VERSION } from '@aeostudio/contracts/auth';
import {
  CreatedSignedWebhookEndpointVerificationEnvelopeSchema,
  CreateSignedWebhookEndpointVerificationRequestSchema,
  RevokeSignedWebhookEndpointVerificationRequestSchema,
  SignedWebhookEndpointVerificationEnvelopeSchema,
  SignedWebhookEndpointVerificationListEnvelopeSchema,
  SignedWebhookEndpointVerificationPathParamsSchema,
  VerifySignedWebhookEndpointVerificationRequestSchema,
} from '@aeostudio/contracts/channels';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AUTH_SERVICE, AUTH_WEB_ORIGIN } from '../auth/auth.tokens.js';
import { SIGNED_WEBHOOK_ENDPOINT_VERIFICATION_SERVICE } from './channels.tokens.js';

@Controller(
  'api/v1/tenants/:tenantId/workspaces/:workspaceId/signed-webhook-endpoint-verifications',
)
export class SignedWebhookEndpointVerificationsController {
  constructor(
    @Inject(AUTH_SERVICE) private readonly authService: AuthService,
    @Inject(AUTH_WEB_ORIGIN) private readonly webOrigin: string,
    @Inject(SIGNED_WEBHOOK_ENDPOINT_VERIFICATION_SERVICE)
    private readonly verifications: SignedWebhookEndpointVerificationService,
  ) {}

  @Post()
  async create(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const session = await this.authenticatedMutation(request, reply);
    if (session === null) return this.authenticationProblem(request, reply);
    const parsed = CreateSignedWebhookEndpointVerificationRequestSchema.safeParse(body);
    if (!parsed.success) {
      reply.code(400);
      return this.problem(
        request,
        400,
        'VALIDATION_ERROR',
        'Signed webhook endpoint verification input is invalid.',
      );
    }
    const result = await this.verifications.create({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
      ...parsed.data,
    });
    if (result.outcome === 'NOT_FOUND') return this.notFoundProblem(request, reply);
    if (result.outcome === 'CHANNEL_NOT_FOUND') {
      reply.code(404);
      return this.problem(
        request,
        404,
        'SIGNED_WEBHOOK_CHANNEL_NOT_FOUND',
        'The signed webhook Channel definition was not found.',
      );
    }
    if (result.outcome === 'FORBIDDEN') return this.forbiddenProblem(request, reply);
    reply.code(201);
    reply.header('cache-control', 'private, no-store');
    return CreatedSignedWebhookEndpointVerificationEnvelopeSchema.parse({
      data: {
        verification: {
          ...toContract(result.verification),
          proofs: result.verification.proofs,
        },
      },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Get()
  async list(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const token = request.cookies['__Host-aeo_session'];
    const session = token === undefined ? null : await this.authService.getSession(token);
    if (session === null) return this.authenticationProblem(request, reply);
    const result = await this.verifications.list({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
    });
    if (result.outcome === 'NOT_FOUND') return this.notFoundProblem(request, reply);
    if (result.outcome === 'FORBIDDEN') return this.forbiddenProblem(request, reply);
    return SignedWebhookEndpointVerificationListEnvelopeSchema.parse({
      data: { verifications: result.verifications.map(toContract) },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post(':verificationId/verify')
  async verify(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('verificationId') verificationId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const session = await this.authenticatedMutation(request, reply);
    if (session === null) return this.authenticationProblem(request, reply);
    const parsedPath = SignedWebhookEndpointVerificationPathParamsSchema.safeParse({
      verificationId,
    });
    if (!parsedPath.success) return this.notFoundProblem(request, reply);
    if (!VerifySignedWebhookEndpointVerificationRequestSchema.safeParse(body).success) {
      reply.code(400);
      return this.problem(
        request,
        400,
        'VALIDATION_ERROR',
        'Signed webhook endpoint verification proof input is invalid.',
      );
    }
    const result = await this.verifications.verify({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
      verificationId: parsedPath.data.verificationId,
    });
    if (result.outcome === 'NOT_FOUND') return this.notFoundProblem(request, reply);
    if (result.outcome === 'FORBIDDEN') return this.forbiddenProblem(request, reply);
    if (result.outcome === 'OWNERSHIP_NOT_VERIFIED') {
      reply.code(422);
      return this.problem(
        request,
        422,
        'ENDPOINT_OWNERSHIP_NOT_VERIFIED',
        `The receiver did not return the exact platform challenge (${result.reason}).`,
      );
    }
    reply.code(200);
    return SignedWebhookEndpointVerificationEnvelopeSchema.parse({
      data: { verification: toContract(result.verification) },
      meta: { requestId: request.id, schemaVersion: SCHEMA_VERSION },
    });
  }

  @Post(':verificationId/revoke')
  async revoke(
    @Param('tenantId') tenantId: string,
    @Param('workspaceId') workspaceId: string,
    @Param('verificationId') verificationId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const session = await this.authenticatedMutation(request, reply);
    if (session === null) return this.authenticationProblem(request, reply);
    const parsedPath = SignedWebhookEndpointVerificationPathParamsSchema.safeParse({
      verificationId,
    });
    if (!parsedPath.success) return this.notFoundProblem(request, reply);
    if (!RevokeSignedWebhookEndpointVerificationRequestSchema.safeParse(body).success) {
      reply.code(400);
      return this.problem(
        request,
        400,
        'VALIDATION_ERROR',
        'Signed webhook endpoint verification revoke input is invalid.',
      );
    }
    const result = await this.verifications.revoke({
      actorSubject: session.subject,
      tenantId,
      workspaceId,
      verificationId: parsedPath.data.verificationId,
    });
    if (result.outcome === 'NOT_FOUND') return this.notFoundProblem(request, reply);
    if (result.outcome === 'FORBIDDEN') return this.forbiddenProblem(request, reply);
    reply.code(200);
    return SignedWebhookEndpointVerificationEnvelopeSchema.parse({
      data: { verification: toContract(result.verification) },
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
    return this.problem(request, 401, 'UNAUTHENTICATED', 'A valid session is required.');
  }

  private notFoundProblem(request: FastifyRequest, reply: FastifyReply) {
    reply.code(404);
    return this.problem(request, 404, 'NOT_FOUND_OR_FORBIDDEN', 'Resource not found.');
  }

  private forbiddenProblem(request: FastifyRequest, reply: FastifyReply) {
    reply.code(403);
    return this.problem(
      request,
      403,
      'FORBIDDEN',
      'The active role cannot manage signed webhook endpoint verifications.',
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
      title: status === 401 ? 'Authentication required' : 'Request rejected',
      status,
      code,
      detail,
      requestId: request.id,
      retryable: false,
    });
  }
}

function toContract(input: {
  id: string;
  channelDefinitionId: string;
  status: 'PENDING' | 'VERIFIED' | 'REVOKED';
  endpointUrl: string;
  receiptUrl: string;
  algorithm: 'HMAC_SHA256' | 'ED25519';
  keyId: string;
  verificationReference: string;
  createdAt: string;
  challengeExpiresAt: string;
  verifiedAt: string | null;
  revokedAt: string | null;
}) {
  return {
    id: input.id,
    channelDefinitionId: input.channelDefinitionId,
    status: input.status,
    endpointUrl: input.endpointUrl,
    receiptUrl: input.receiptUrl,
    algorithm: input.algorithm,
    keyId: input.keyId,
    verificationReference: input.verificationReference,
    createdAt: input.createdAt,
    challengeExpiresAt: input.challengeExpiresAt,
    verifiedAt: input.verifiedAt,
    revokedAt: input.revokedAt,
  };
}
