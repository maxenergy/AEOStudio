import type { ArtifactGenerator } from '@aeostudio/application/artifacts';
import { TemplateContentWriter } from '@aeostudio/application/writer';
import type { ArtifactPayload, ArtifactWriterContext } from '@aeostudio/domain/artifacts';

/**
 * Thin adapter that preserves the historical ArtifactGenerator contract while
 * delegating draft production to the restricted TemplateContentWriter. Output
 * is byte-for-byte identical to the previous inline template when every claim
 * carries Evidence, so exact-revision content hashes remain stable.
 */
export class DeterministicArtifactGenerator implements ArtifactGenerator {
  private readonly writer = new TemplateContentWriter();

  generate(context: ArtifactWriterContext): Promise<ArtifactPayload> {
    return this.writer.generateDraft({ context });
  }
}
