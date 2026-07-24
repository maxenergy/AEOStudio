export type RuntimeBuildIdentityService = 'api' | 'web' | 'worker';

export interface RuntimeBuildIdentity {
  schemaVersion: 'aeostudio.runtime-build-identity.v1';
  source: 'ecs-container-metadata-v4';
  service: RuntimeBuildIdentityService;
  taskArn: string;
  taskDefinitionArn: string;
  containerArn: string;
  image: string;
  imageDigest: string;
  imageId: string;
  capturedAt: string;
}

interface RuntimeIdentityFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

interface EcsRuntimeIdentityInput {
  service: RuntimeBuildIdentityService;
  environment: Readonly<Record<string, string | undefined>>;
  fetch?: (
    url: string,
    init: { headers: Readonly<Record<string, string>>; signal: AbortSignal },
  ) => Promise<RuntimeIdentityFetchResponse>;
  now?: () => Date;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const TASK_ARN =
  /^arn:aws:ecs:(?<region>[a-z]{2}-[a-z]+-[1-9][0-9]*):(?<account>[0-9]{12}):task\/(?<cluster>[A-Za-z0-9_-]{1,255})\/(?<task>[0-9a-f]{32})$/u;
const CONTAINER_ARN =
  /^arn:aws:ecs:(?<region>[a-z]{2}-[a-z]+-[1-9][0-9]*):(?<account>[0-9]{12}):container\/(?<cluster>[A-Za-z0-9_-]{1,255})\/(?<task>[0-9a-f]{32})\/[0-9a-f]{32}$/u;
const FAMILY = /^[A-Za-z0-9_-]{1,255}$/u;
const REVISION = /^[1-9][0-9]{0,9}$/u;
const IMAGE =
  /^(?<account>[0-9]{12})\.dkr\.ecr\.(?<region>[a-z]{2}-[a-z]+-[1-9][0-9]*)\.amazonaws\.com\/[a-z0-9][a-z0-9._/-]{0,255}@(?<digest>sha256:[0-9a-f]{64})$/u;

/**
 * Resolves build identity from the task-local ECS metadata endpoint. A caller-supplied
 * release manifest is intentionally not accepted: the running task is the trust surface.
 */
export async function resolveEcsRuntimeBuildIdentity(
  input: EcsRuntimeIdentityInput,
): Promise<RuntimeBuildIdentity | null> {
  const rawUri = input.environment.ECS_CONTAINER_METADATA_URI_V4?.trim();
  if (rawUri === undefined || rawUri.length === 0) return null;
  const metadataUri = exactMetadataUri(rawUri);
  const fetchRuntime = input.fetch ?? globalThis.fetch;
  const response = await fetchRuntime(`${metadataUri}/task`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`ECS_METADATA_HTTP_${String(response.status)}`);
  const contents = await response.text();
  if (contents.length === 0 || contents.length > 256 * 1024) {
    throw new Error('ECS_METADATA_RESPONSE_INVALID');
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error: unknown) {
    throw new Error('ECS_METADATA_RESPONSE_INVALID', { cause: error });
  }
  const metadata = object(value, 'ECS_METADATA_RESPONSE_INVALID');
  const taskArn = exactString(metadata.TaskARN, TASK_ARN, 'ECS_TASK_ARN_INVALID');
  const task = TASK_ARN.exec(taskArn)?.groups;
  if (task === undefined) throw new Error('ECS_TASK_ARN_INVALID');
  const family = exactString(metadata.Family, FAMILY, 'ECS_TASK_DEFINITION_INVALID');
  const revision = exactString(metadata.Revision, REVISION, 'ECS_TASK_DEFINITION_INVALID');
  if (!Array.isArray(metadata.Containers)) throw new Error('ECS_CONTAINER_METADATA_INVALID');
  const matching = metadata.Containers.filter(
    (candidate) => objectOrNull(candidate)?.Name === input.service,
  );
  if (matching.length !== 1) throw new Error('ECS_RUNTIME_CONTAINER_NOT_UNIQUE');
  const container = object(matching[0], 'ECS_CONTAINER_METADATA_INVALID');
  const containerArn = exactString(
    container.ContainerARN,
    CONTAINER_ARN,
    'ECS_CONTAINER_ARN_INVALID',
  );
  const parsedContainer = CONTAINER_ARN.exec(containerArn)?.groups;
  if (
    parsedContainer === undefined ||
    parsedContainer.region !== task.region ||
    parsedContainer.account !== task.account ||
    parsedContainer.cluster !== task.cluster ||
    parsedContainer.task !== task.task
  ) {
    throw new Error('ECS_CONTAINER_TASK_IDENTITY_MISMATCH');
  }
  const image = exactString(container.Image, IMAGE, 'ECS_RUNTIME_IMAGE_NOT_DIGEST_PINNED');
  const parsedImage = IMAGE.exec(image)?.groups;
  if (
    parsedImage === undefined ||
    parsedImage.account !== task.account ||
    parsedImage.region !== task.region
  ) {
    throw new Error('ECS_RUNTIME_IMAGE_IDENTITY_MISMATCH');
  }
  const imageDigest = exactString(
    parsedImage.digest,
    DIGEST,
    'ECS_RUNTIME_IMAGE_NOT_DIGEST_PINNED',
  );
  const imageId = exactString(container.ImageID, DIGEST, 'ECS_RUNTIME_IMAGE_ID_INVALID');
  if (imageId !== imageDigest) throw new Error('ECS_RUNTIME_IMAGE_DIGEST_MISMATCH');
  const capturedAt = (input.now ?? (() => new Date()))();
  if (!Number.isFinite(capturedAt.valueOf())) throw new Error('ECS_METADATA_CLOCK_INVALID');

  return {
    schemaVersion: 'aeostudio.runtime-build-identity.v1',
    source: 'ecs-container-metadata-v4',
    service: input.service,
    taskArn,
    taskDefinitionArn:
      `arn:aws:ecs:${task.region}:${task.account}:task-definition/` + `${family}:${revision}`,
    containerArn,
    image,
    imageDigest,
    imageId,
    capturedAt: capturedAt.toISOString(),
  };
}

function exactMetadataUri(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error: unknown) {
    throw new Error('ECS_METADATA_URI_INVALID', { cause: error });
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '169.254.170.2' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !/^\/v4\/[A-Za-z0-9_-]{1,512}$/u.test(url.pathname)
  ) {
    throw new Error('ECS_METADATA_URI_INVALID');
  }
  return url.toString().replace(/\/$/u, '');
}

function exactString(value: unknown, pattern: RegExp, code: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(code);
  return value;
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(code);
  }
  return value as Record<string, unknown>;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
