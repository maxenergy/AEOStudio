import type { ArtifactPayload, ArtifactRevisionRecord } from '@aeostudio/domain/artifacts';
import type { ChannelPackagePayload } from '@aeostudio/domain/channels-publishing';

export interface ChannelPackageTransformer {
  readonly key: string;
  readonly version: string;
  transform(input: {
    revision: ArtifactRevisionRecord;
    payload: ArtifactPayload;
  }): ChannelPackagePayload;
}

export interface ChannelPackageTransformerRegistry {
  resolve(key: string): ChannelPackageTransformer | null;
}

export class GenericWebPackageTransformer implements ChannelPackageTransformer {
  readonly key = 'generic-web-package';
  readonly version = '1.0.0';

  transform(input: {
    revision: ArtifactRevisionRecord;
    payload: ArtifactPayload;
  }): ChannelPackagePayload {
    const markdown = [
      `# ${input.payload.title}`,
      '',
      input.payload.summary,
      ...input.payload.sections.flatMap((section) => [
        '',
        `## ${section.heading}`,
        '',
        section.body,
      ]),
      '',
      '## Disclosure',
      '',
      input.payload.disclosure,
      '',
    ].join('\n');
    const html = [
      '<article>',
      `<h1>${escapeHtml(input.payload.title)}</h1>`,
      `<p>${escapeHtml(input.payload.summary)}</p>`,
      ...input.payload.sections.flatMap((section) => [
        '<section>',
        `<h2>${escapeHtml(section.heading)}</h2>`,
        `<p>${escapeHtml(section.body)}</p>`,
        '</section>',
      ]),
      '<section>',
      '<h2>Disclosure</h2>',
      `<p>${escapeHtml(input.payload.disclosure)}</p>`,
      '</section>',
      '</article>',
    ].join('');
    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'CreativeWork',
      headline: input.payload.title,
      abstract: input.payload.summary,
      inLanguage: input.revision.locale,
      text: markdown,
    };
    return {
      files: {
        'content.md': markdown,
        'content.html': html,
        'structured-data.json': JSON.stringify(jsonLd),
      },
    };
  }
}

export class DefaultChannelPackageTransformerRegistry implements ChannelPackageTransformerRegistry {
  private readonly transformers: ReadonlyMap<string, ChannelPackageTransformer>;

  constructor(transformers: ChannelPackageTransformer[] = [new GenericWebPackageTransformer()]) {
    this.transformers = new Map(transformers.map((transformer) => [transformer.key, transformer]));
  }

  resolve(key: string): ChannelPackageTransformer | null {
    return this.transformers.get(key) ?? null;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
