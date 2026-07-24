import type {
  ApplicationLogInput,
  StructuredApplicationLogger,
} from '../observability/structured-logger.js';
import type { RuntimeBuildIdentity } from './ecs-runtime-build-identity.js';

export function bindRuntimeBuildIdentity(
  logger: StructuredApplicationLogger,
  identity: RuntimeBuildIdentity | null,
): StructuredApplicationLogger {
  if (identity === null) return logger;
  const bind = (input?: ApplicationLogInput): ApplicationLogInput => ({
    ...(input?.correlation === undefined ? {} : { correlation: input.correlation }),
    attributes: {
      ...input?.attributes,
      runtimeTaskArn: identity.taskArn,
      runtimeTaskDefinitionArn: identity.taskDefinitionArn,
      runtimeImageDigest: identity.imageDigest,
      runtimeImageId: identity.imageId,
    },
  });
  return {
    debug: (event, input) => logger.debug(event, bind(input)),
    info: (event, input) => logger.info(event, bind(input)),
    warn: (event, input) => logger.warn(event, bind(input)),
    error: (event, input) => logger.error(event, bind(input)),
    flush: () => logger.flush(),
  };
}
