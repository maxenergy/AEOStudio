import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import { ProblemDetailsSchema } from '@aeostudio/contracts/auth';
import type { FastifyReply, FastifyRequest } from 'fastify';

interface SafeHttpProblem {
  code: string;
  detail: string;
  retryable: boolean;
  slug: string;
  title: string;
}

const SAFE_HTTP_PROBLEMS = new Map<number, SafeHttpProblem>([
  [
    400,
    {
      code: 'BAD_REQUEST',
      detail: 'The request could not be processed.',
      retryable: false,
      slug: 'bad-request',
      title: 'Bad Request',
    },
  ],
  [
    401,
    {
      code: 'UNAUTHORIZED',
      detail: 'Authentication is required.',
      retryable: false,
      slug: 'unauthorized',
      title: 'Unauthorized',
    },
  ],
  [
    403,
    {
      code: 'FORBIDDEN',
      detail: 'The request is not authorized.',
      retryable: false,
      slug: 'forbidden',
      title: 'Forbidden',
    },
  ],
  [
    404,
    {
      code: 'NOT_FOUND',
      detail: 'The requested resource was not found.',
      retryable: false,
      slug: 'not-found',
      title: 'Not Found',
    },
  ],
  [
    405,
    {
      code: 'METHOD_NOT_ALLOWED',
      detail: 'The request method is not supported for this resource.',
      retryable: false,
      slug: 'method-not-allowed',
      title: 'Method Not Allowed',
    },
  ],
  [
    408,
    {
      code: 'REQUEST_TIMEOUT',
      detail: 'The request timed out.',
      retryable: true,
      slug: 'request-timeout',
      title: 'Request Timeout',
    },
  ],
  [
    409,
    {
      code: 'CONFLICT',
      detail: 'The request conflicts with the current resource state.',
      retryable: false,
      slug: 'conflict',
      title: 'Conflict',
    },
  ],
  [
    413,
    {
      code: 'PAYLOAD_TOO_LARGE',
      detail: 'The request payload is too large.',
      retryable: false,
      slug: 'payload-too-large',
      title: 'Payload Too Large',
    },
  ],
  [
    415,
    {
      code: 'UNSUPPORTED_MEDIA_TYPE',
      detail: 'The request media type is not supported.',
      retryable: false,
      slug: 'unsupported-media-type',
      title: 'Unsupported Media Type',
    },
  ],
  [
    422,
    {
      code: 'UNPROCESSABLE_ENTITY',
      detail: 'The request could not be processed.',
      retryable: false,
      slug: 'unprocessable-entity',
      title: 'Unprocessable Entity',
    },
  ],
  [
    429,
    {
      code: 'TOO_MANY_REQUESTS',
      detail: 'Too many requests were received.',
      retryable: true,
      slug: 'too-many-requests',
      title: 'Too Many Requests',
    },
  ],
  [
    500,
    {
      code: 'INTERNAL_SERVER_ERROR',
      detail: 'The server could not complete the request.',
      retryable: true,
      slug: 'internal-server-error',
      title: 'Internal Server Error',
    },
  ],
  [
    502,
    {
      code: 'BAD_GATEWAY',
      detail: 'An upstream service returned an invalid response.',
      retryable: true,
      slug: 'bad-gateway',
      title: 'Bad Gateway',
    },
  ],
  [
    503,
    {
      code: 'SERVICE_UNAVAILABLE',
      detail: 'The service is temporarily unavailable.',
      retryable: true,
      slug: 'service-unavailable',
      title: 'Service Unavailable',
    },
  ],
  [
    504,
    {
      code: 'GATEWAY_TIMEOUT',
      detail: 'An upstream service timed out.',
      retryable: true,
      slug: 'gateway-timeout',
      title: 'Gateway Timeout',
    },
  ],
]);

@Catch()
export class HttpProblemDetailsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const status = safeHttpStatus(exception);
    const descriptor =
      SAFE_HTTP_PROBLEMS.get(status) ??
      ({
        code: `HTTP_${status}`,
        detail: 'The server could not complete the request.',
        retryable: status >= 500,
        slug: `http-${status}`,
        title: 'Request Failed',
      } satisfies SafeHttpProblem);
    const problem = ProblemDetailsSchema.parse({
      type: `https://aeostudio.example/problems/${descriptor.slug}`,
      title: descriptor.title,
      status,
      code: descriptor.code,
      detail: descriptor.detail,
      requestId: String(request.id),
      retryable: descriptor.retryable,
    });

    void reply
      .code(status)
      .header('cache-control', 'private, no-store')
      .type('application/problem+json')
      .send(problem);
  }
}

function safeHttpStatus(exception: unknown): number {
  if (!(exception instanceof HttpException)) return 500;
  const status = exception.getStatus();
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}
