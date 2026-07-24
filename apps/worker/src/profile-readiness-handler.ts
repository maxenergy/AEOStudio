import type { ProfileRevision } from '@aeostudio/domain/profile-offering';

export interface ProfileReadinessResult {
  readinessPercent: number;
  completedFields: number;
  totalFields: number;
  missingFields: string[];
  profileRevision: number;
  contentHash: string;
}

export class ProfileReadinessHandler {
  execute(profile: ProfileRevision): ProfileReadinessResult {
    return {
      readinessPercent: profile.completeness.percent,
      completedFields: profile.completeness.completedFields,
      totalFields: profile.completeness.totalFields,
      missingFields: [...profile.completeness.missingFields],
      profileRevision: profile.revision,
      contentHash: profile.contentHash,
    };
  }
}
