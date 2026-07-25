import { createHash } from 'node:crypto';

import { canonicalArtifactJson } from '../artifacts/index.js';
import type { ChannelProfile } from '@aeostudio/domain/channels-publishing';

export function hashChannelProfile(
  input: Pick<ChannelProfile, 'channel' | 'profileVersion' | 'fieldRequirements'>,
): string {
  return createHash('sha256')
    .update(
      canonicalArtifactJson({
        channel: input.channel,
        fieldRequirements: input.fieldRequirements,
        profileVersion: input.profileVersion,
      }),
      'utf8',
    )
    .digest('hex');
}

export function channelProfileIsValid(profile: ChannelProfile, expectedChannel: string): boolean {
  if (
    typeof profile.channel !== 'string' ||
    typeof profile.profileVersion !== 'string' ||
    typeof profile.profileHash !== 'string' ||
    !Array.isArray(profile.fieldRequirements) ||
    profile.channel !== expectedChannel ||
    profile.channel.length < 1 ||
    profile.channel.length > 160 ||
    profile.profileVersion.length < 1 ||
    profile.profileVersion.length > 80 ||
    !/^[a-f0-9]{64}$/.test(profile.profileHash) ||
    profile.fieldRequirements.length < 1 ||
    profile.fieldRequirements.length > 100
  ) {
    return false;
  }
  const fields = new Set<string>();
  for (const requirement of profile.fieldRequirements) {
    if (
      requirement === null ||
      typeof requirement !== 'object' ||
      typeof requirement.field !== 'string' ||
      typeof requirement.sourcePointer !== 'string' ||
      typeof requirement.required !== 'boolean' ||
      typeof requirement.format !== 'string' ||
      requirement.field.length < 1 ||
      requirement.field.length > 160 ||
      fields.has(requirement.field) ||
      !requirement.sourcePointer.startsWith('/') ||
      requirement.sourcePointer.length > 500 ||
      requirement.format.length < 1 ||
      requirement.format.length > 160 ||
      !nullableLengthIsValid(requirement.minLength) ||
      !nullableLengthIsValid(requirement.maxLength) ||
      (requirement.minLength !== null &&
        requirement.maxLength !== null &&
        requirement.minLength > requirement.maxLength)
    ) {
      return false;
    }
    fields.add(requirement.field);
  }
  if (!optionalTemplateConstraintsAreValid(profile)) {
    return false;
  }
  return hashChannelProfile(profile) === profile.profileHash;
}

function optionalTemplateConstraintsAreValid(profile: ChannelProfile): boolean {
  const bodyFormats = ['markdown', 'html', 'plain'];
  const ctaPositions = ['none', 'top', 'bottom'];
  if (
    profile.titleMaxLength !== undefined &&
    profile.titleMaxLength !== null &&
    (!Number.isSafeInteger(profile.titleMaxLength) || profile.titleMaxLength < 1)
  ) {
    return false;
  }
  if (
    profile.bodyFormat !== undefined &&
    profile.bodyFormat !== null &&
    !bodyFormats.includes(profile.bodyFormat)
  ) {
    return false;
  }
  if (
    profile.maxTags !== undefined &&
    profile.maxTags !== null &&
    (!Number.isSafeInteger(profile.maxTags) || profile.maxTags < 0)
  ) {
    return false;
  }
  if (
    profile.ctaPosition !== undefined &&
    profile.ctaPosition !== null &&
    !ctaPositions.includes(profile.ctaPosition)
  ) {
    return false;
  }
  return true;
}

function nullableLengthIsValid(value: number | null): boolean {
  return value === null || (Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000);
}
