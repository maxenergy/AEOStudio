import type { ArtifactPayload, ArtifactRevisionRecord } from '@aeostudio/domain/artifacts';
import type { ChannelPackagePayload, ChannelProfile } from '@aeostudio/domain/channels-publishing';

export interface ChannelPackageTransformer {
  readonly key: string;
  readonly version: string;
  transform(input: {
    revision: ArtifactRevisionRecord;
    payload: ArtifactPayload;
    channelProfile?: ChannelProfile | null;
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
    channelProfile?: ChannelProfile | null;
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
    const coreFiles: ChannelPackagePayload['files'] = {
      'content.md': markdown,
      'content.html': html,
      'structured-data.json': JSON.stringify(jsonLd),
    };
    if (input.channelProfile === undefined || input.channelProfile === null) {
      return { files: coreFiles };
    }

    const fields = input.channelProfile.fieldRequirements.map((requirement) => ({
      field: requirement.field,
      sourcePointer: requirement.sourcePointer,
      value: readArtifactValue(input.payload, requirement.sourcePointer),
      requirements: {
        required: requirement.required,
        minLength: requirement.minLength,
        maxLength: requirement.maxLength,
        format: requirement.format,
      },
    }));
    const claims = [...input.revision.claimBindings]
      .sort((left, right) => left.claimRevisionId.localeCompare(right.claimRevisionId))
      .map((binding) => ({
        claimId: binding.claimId,
        claimRevisionId: binding.claimRevisionId,
        claimContentHash: binding.claimContentHash,
        evidence: [...binding.evidence].sort((left, right) =>
          `${left.sourceId}:${left.snapshotId}`.localeCompare(
            `${right.sourceId}:${right.snapshotId}`,
          ),
        ),
      }));
    const lineage = {
      artifact: {
        artifactId: input.revision.artifactId,
        artifactRevisionId: input.revision.id,
        revision: input.revision.revision,
        contentHash: input.revision.contentHash,
      },
      claims,
    };
    const profileHeader = [
      '# Submission checklist',
      '',
      'Review required before external publication.',
      '',
      `- Channel: ${input.channelProfile.channel}`,
      `- Profile version: ${input.channelProfile.profileVersion}`,
      `- Profile hash: ${input.channelProfile.profileHash}`,
      '',
      '## Field requirements',
      '',
    ];
    const fieldChecklist = fields.map((field) => {
      const minimum =
        field.requirements.minLength === null ? 'none' : String(field.requirements.minLength);
      const maximum =
        field.requirements.maxLength === null ? 'none' : String(field.requirements.maxLength);
      return (
        `- [ ] ${field.field}: source \`${field.sourcePointer}\`; ` +
        `required=${String(field.requirements.required)}; ` +
        `length=${minimum}..${maximum}; format=${field.requirements.format}`
      );
    });
    const lineageChecklist = [
      '',
      '## Source lineage',
      '',
      `- Artifact revision: ${input.revision.id} @ ${input.revision.contentHash}`,
      ...claims.flatMap((claim) => [
        `- Claim revision: ${claim.claimRevisionId} @ ${claim.claimContentHash}`,
        ...claim.evidence.map(
          (evidence) =>
            `  - Evidence: ${evidence.sourceId}/${evidence.snapshotId} @ ${evidence.sourceHash}`,
        ),
      ]),
      '',
    ];

    return {
      files: {
        ...coreFiles,
        'post.txt': fields
          .map((field) => field.value)
          .filter((value) => value.length > 0)
          .join('\n\n'),
        'fields.json': JSON.stringify(
          {
            schemaVersion: '1.0.0',
            channel: input.channelProfile.channel,
            profileVersion: input.channelProfile.profileVersion,
            profileHash: input.channelProfile.profileHash,
            reviewedBeforePublish: true,
            fields,
            lineage,
          },
          null,
          2,
        ),
        'submission-checklist.md': [...profileHeader, ...fieldChecklist, ...lineageChecklist].join(
          '\n',
        ),
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

function readArtifactValue(payload: ArtifactPayload, pointer: string): string {
  if (!pointer.startsWith('/')) return '';
  let current: unknown = payload;
  for (const rawToken of pointer.slice(1).split('/')) {
    const token = rawToken.replaceAll('~1', '/').replaceAll('~0', '~');
    if (current === null || typeof current !== 'object') return '';
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return '';
      current = current[Number(token)];
    } else {
      current = (current as Record<string, unknown>)[token];
    }
  }
  if (current === undefined || current === null) return '';
  return typeof current === 'string' ? current : JSON.stringify(current);
}
