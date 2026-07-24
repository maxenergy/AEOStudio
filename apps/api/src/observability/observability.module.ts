import { Global, Module, type DynamicModule } from '@nestjs/common';
import type { JobTraceContextProvider } from '@aeostudio/application/jobs-budgets';
import {
  activeJobTraceContextProvider,
  type StructuredApplicationLogger,
} from '@aeostudio/adapters/observability';

import { APPLICATION_LOGGER, JOB_TRACE_CONTEXT_PROVIDER } from './observability.tokens.js';

const NOOP_LOGGER: StructuredApplicationLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  flush: () => undefined,
};

@Global()
@Module({})
export class ObservabilityModule {
  static register(
    provider?: JobTraceContextProvider,
    logger?: StructuredApplicationLogger,
  ): DynamicModule {
    return {
      module: ObservabilityModule,
      providers: [
        {
          provide: JOB_TRACE_CONTEXT_PROVIDER,
          useValue: provider ?? activeJobTraceContextProvider,
        },
        {
          provide: APPLICATION_LOGGER,
          useValue: logger ?? NOOP_LOGGER,
        },
      ],
      exports: [JOB_TRACE_CONTEXT_PROVIDER, APPLICATION_LOGGER],
    };
  }
}
