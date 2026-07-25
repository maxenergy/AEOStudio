import type { ArtifactPayload, ArtifactWriterContext } from '@aeostudio/domain/artifacts';

/**
 * Advanced generation parameters exposed to operators. The deterministic
 * template writer accepts but ignores them; a future LLM adapter will honour
 * them. They never affect the exact-revision content hash of deterministic
 * output, preserving reproducible generation.
 */
export interface WriterPolicy {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  seed?: number;
}

/**
 * Restricted content writer. Implementations MUST use only the approved Claim
 * revisions carried in the writer context as the source of facts. Text without
 * backing Evidence must be surfaced as "pending verification" rather than
 * asserted as fact.
 */
export interface ContentWriter {
  generateDraft(input: {
    context: ArtifactWriterContext;
    policy?: WriterPolicy;
  }): Promise<ArtifactPayload>;
}

/**
 * Reserved port for a future real LLM backend. The current Sprint ships no
 * concrete adapter; the deterministic template writer does not call it. Kept
 * so a later Sprint can inject a restricted LLM without changing callers.
 */
export interface LlmAdapter {
  complete(input: { prompt: string; policy?: WriterPolicy }): Promise<string>;
}
