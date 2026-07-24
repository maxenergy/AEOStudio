import {
  channelProfileIsValid,
  GenericWebPackageTransformer,
  hashChannelProfile,
} from '@aeostudio/application/channels-publishing';
import type { ChannelProfile } from '@aeostudio/domain/channels-publishing';
import type { ArtifactPayload, ArtifactRevisionRecord } from '@aeostudio/domain/artifacts';
import { describe, expect, test } from 'vitest';

describe('Channel Profile adaptation package', () => {
  test('binds the open channel requirements and profile version to the profile hash', () => {
    const identity = {
      channel: 'configured-at-runtime',
      profileVersion: '42.7',
      fieldRequirements: [
        {
          field: 'answer',
          sourcePointer: '/summary',
          required: true,
          minLength: 10,
          maxLength: 900,
          format: 'provider-documented-text',
        },
      ],
    };
    const profile: ChannelProfile = {
      ...identity,
      profileHash: hashChannelProfile(identity),
    };

    expect(channelProfileIsValid(profile, identity.channel)).toBe(true);
    expect(
      channelProfileIsValid(
        {
          ...profile,
          fieldRequirements: [{ ...profile.fieldRequirements[0]!, maxLength: 901 }],
        },
        identity.channel,
      ),
    ).toBe(false);
    expect(channelProfileIsValid(profile, 'different-runtime-channel')).toBe(false);
  });

  test('uses profile field requirements to create review-only handoff files with lineage', () => {
    const payload: ArtifactPayload = {
      title: 'Neutral product title',
      summary: 'A concise product summary for an arbitrary configured channel.',
      sections: [{ heading: 'How it works', body: 'Evidence-backed operating details.' }],
      claimMap: [
        {
          claimRevisionId: '00000000-0000-7000-8000-000000000103',
          statement: 'An approved product Claim.',
          evidenceSourceIds: ['00000000-0000-7000-8000-000000000104'],
        },
      ],
      disclosure: 'Review the destination terms before submission.',
    };
    const revision: ArtifactRevisionRecord = {
      id: '00000000-0000-7000-8000-000000000101',
      artifactId: '00000000-0000-7000-8000-000000000102',
      revision: 3,
      briefId: '00000000-0000-7000-8000-000000000105',
      type: 'DEFINITION_PRODUCT',
      schemaVersion: '1.0.0',
      contentHash: 'a'.repeat(64),
      status: 'APPROVED',
      locale: 'en-SG',
      market: 'SG',
      sourceArtifactIds: [],
      lineage: {
        contentPlanId: '00000000-0000-7000-8000-000000000106',
        brief: {
          id: '00000000-0000-7000-8000-000000000105',
          contentHash: 'b'.repeat(64),
        },
        prompt: {
          promptSetId: '00000000-0000-7000-8000-000000000107',
          promptRevisionId: '00000000-0000-7000-8000-000000000108',
          contentHash: 'c'.repeat(64),
          promptIds: [],
        },
        sourceReferences: [],
      },
      claimBindings: [
        {
          claimId: '00000000-0000-7000-8000-000000000109',
          claimRevisionId: '00000000-0000-7000-8000-000000000103',
          claimContentHash: 'd'.repeat(64),
          claimStatement: 'An approved product Claim.',
          evidence: [
            {
              sourceId: '00000000-0000-7000-8000-000000000104',
              snapshotId: '00000000-0000-7000-8000-000000000110',
              sourceHash: 'e'.repeat(64),
            },
          ],
        },
      ],
      methodPolicyVersion: 'fixture-v1',
      createdByActor: { kind: 'USER', id: '00000000-0000-7000-8000-000000000111' },
      createdAt: '2026-07-25T00:00:00.000Z',
      payloadObjectRef: 'memory://artifact',
    };
    const input = {
      revision,
      payload,
      channelProfile: {
        channel: 'arbitrary-review-destination',
        profileVersion: '7.4.2',
        profileHash: 'f'.repeat(64),
        fieldRequirements: [
          {
            field: 'headline',
            sourcePointer: '/title',
            required: true,
            minLength: 1,
            maxLength: 120,
            format: 'plain-text',
          },
          {
            field: 'body',
            sourcePointer: '/summary',
            required: true,
            minLength: 1,
            maxLength: 2_000,
            format: 'plain-text',
          },
        ],
      },
    };

    const result = new GenericWebPackageTransformer().transform(input);
    const files = result.files as Record<string, string>;

    expect(files['post.txt']).toBe(`${payload.title}\n\n${payload.summary}`);
    expect(JSON.parse(files['fields.json'] ?? '')).toMatchObject({
      channel: 'arbitrary-review-destination',
      profileVersion: '7.4.2',
      profileHash: 'f'.repeat(64),
      reviewedBeforePublish: true,
      fields: [
        { field: 'headline', sourcePointer: '/title', value: payload.title },
        { field: 'body', sourcePointer: '/summary', value: payload.summary },
      ],
      lineage: {
        artifact: {
          artifactId: revision.artifactId,
          artifactRevisionId: revision.id,
          revision: revision.revision,
          contentHash: revision.contentHash,
        },
        claims: [
          {
            claimRevisionId: revision.claimBindings[0]?.claimRevisionId,
            evidence: revision.claimBindings[0]?.evidence,
          },
        ],
      },
    });
    expect(files['submission-checklist.md']).toContain(
      'Review required before external publication',
    );
    expect(files['submission-checklist.md']).toContain(input.channelProfile.profileHash);
    expect(files['submission-checklist.md']).toContain(revision.claimBindings[0]?.claimRevisionId);
    expect(files['submission-checklist.md']).toContain(
      revision.claimBindings[0]?.evidence[0]?.sourceHash,
    );
  });
});
