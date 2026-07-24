import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Http2ServerRequest } from 'node:http2';

import fastifyCookie from '@fastify/cookie';
import { bindRuntimeBuildIdentity, resolveEcsRuntimeBuildIdentity } from '@aeostudio/adapters';
import { createStructuredApplicationLogger } from '@aeostudio/adapters/observability';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule, type ApiAppOptions } from './app.module.js';
import { activeTraceIdProvider } from './observability/active-trace-id.js';
import { NestStructuredLogger } from './observability/nest-structured-logger.js';
import {
  createApiRequestTelemetry,
  resolveRequestId,
} from './observability/request-correlation.js';
import { HttpProblemDetailsFilter } from './http-problem-details.filter.js';
import { resolveApiRuntime } from './runtime/resolve-runtime.js';

export async function createApiApp(options: ApiAppOptions = {}): Promise<NestFastifyApplication> {
  const runtime = await resolveApiRuntime(options);
  const runtimeBuildIdentity =
    options.runtimeBuildIdentity === undefined
      ? await resolveEcsRuntimeBuildIdentity({ service: 'api', environment: process.env })
      : options.runtimeBuildIdentity;
  const applicationLogger = bindRuntimeBuildIdentity(
    createStructuredApplicationLogger({ serviceName: 'aeostudio-api' }),
    runtimeBuildIdentity,
  );
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      ...runtime.options,
      cleanup: runtime.cleanup,
      applicationLogger,
      runtimeBuildIdentity,
    }),
    new FastifyAdapter({
      genReqId: (request: IncomingMessage | Http2ServerRequest) =>
        resolveRequestId(request.headers['x-request-id'], { next: randomUUID }),
    }),
    {
      logger: new NestStructuredLogger(applicationLogger),
    },
  );
  const requestTelemetry = createApiRequestTelemetry(applicationLogger, {
    traceIds: activeTraceIdProvider,
    clock: { now: () => performance.now() },
  });
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onRequest', (request, reply, done) => {
    requestTelemetry.onRequest(request, reply);
    done();
  });
  fastify.addHook('onSend', (_request, reply, payload, done) => {
    if (reply.statusCode >= 400) {
      reply.header('cache-control', 'private, no-store');
      reply.type('application/problem+json');
    }
    done(null, payload);
  });
  fastify.addHook('onResponse', (request, reply, done) => {
    requestTelemetry.onResponse(request, reply);
    done();
  });
  app.useGlobalFilters(new HttpProblemDetailsFilter());
  await app.register(fastifyCookie);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
