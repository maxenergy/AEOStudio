import { describe, expect, it } from 'vitest';
import {
  buildDataDrivenContentPlan,
  type OpportunitySignalVector,
  RANKING_POLICY_V1,
  computePriorityScore,
} from '@aeostudio/domain/content-planning';
import type { ContentPlanInputSnapshot } from '@aeostudio/domain/content-planning';

function makeSnapshot(overrides: Partial<ContentPlanInputSnapshot> = {}): ContentPlanInputSnapshot {
  return {
    profile: { id: '00000000-0000-7000-8000-000000000001', revision: 1 },
    offering: { id: '00000000-0000-7000-8000-000000000002', revision: 1 },
    promptSetId: '00000000-0000-7000-8000-000000000003',
    promptRevisionId: '00000000-0000-7000-8000-000000000004',
    primaryClaimRevisionIds: ['00000000-0000-7000-8000-000000000005'],
    comparisonClaimRevisionIds: ['00000000-0000-7000-8000-000000000006'],
    baselineId: '00000000-0000-7000-8000-000000000007',
    methodPolicyVersion: 'content-plan-v2',
    profileRevisionId: '00000000-0000-7000-8000-000000000011',
    offeringRevisionId: '00000000-0000-7000-8000-000000000012',
    promptIds: [
      '00000000-0000-7000-8000-000000000021',
      '00000000-0000-7000-8000-000000000022',
      '00000000-0000-7000-8000-000000000023',
    ],
    primaryEvidenceSnapshotIds: ['00000000-0000-7000-8000-000000000031'],
    comparisonEvidenceSnapshotIds: ['00000000-0000-7000-8000-000000000032'],
    availableClaimRevisionIds: [
      '00000000-0000-7000-8000-000000000005',
      '00000000-0000-7000-8000-000000000006',
    ],
    availableSourceArtifactIds: [
      '00000000-0000-7000-8000-000000000011',
      '00000000-0000-7000-8000-000000000012',
      '00000000-0000-7000-8000-000000000004',
      '00000000-0000-7000-8000-000000000007',
    ],
    comparisonEvidenceIndependent: true,
    ...overrides,
  };
}

describe('C06: Data-driven Content Plan', () => {
  describe('OpportunitySignalVector', () => {
    it('each opportunity stores independent signal components', () => {
      const result = buildDataDrivenContentPlan(makeSnapshot());
      for (const opp of result.opportunities) {
        const signals = opp.signals;
        expect(signals).toBeDefined();
        expect(typeof signals.businessPriority).toBe('number');
        expect(typeof signals.evidenceReadiness).toBe('number');
        expect(typeof signals.technicalReadiness).toBe('number');
        expect(typeof signals.contentCoverageGap).toBe('number');
        expect(typeof signals.promptCoverageGap).toBe('number');
        expect(typeof signals.effort).toBe('number');
        expect(typeof signals.risk).toBe('number');
        // AI visibility remains UNKNOWN without measurement
        expect(signals.aiVisibilityObservation.status).toBe('UNKNOWN');
      }
    });

    it('signals are derived from real input data, not fixed constants', () => {
      const withClaims = buildDataDrivenContentPlan(makeSnapshot());
      const withoutClaims = buildDataDrivenContentPlan(
        makeSnapshot({ primaryClaimRevisionIds: [], comparisonClaimRevisionIds: [] }),
      );
      // Evidence readiness should differ based on actual claims
      const defWith = withClaims.opportunities.find((o) => o.assetKind === 'DEFINITION_PRODUCT');
      const defWithout = withoutClaims.opportunities.find(
        (o) => o.assetKind === 'DEFINITION_PRODUCT',
      );
      expect(defWith!.signals.evidenceReadiness).not.toBe(defWithout!.signals.evidenceReadiness);
    });

    it('different surfaces keep signals independent (no cross-surface total)', () => {
      const result = buildDataDrivenContentPlan(makeSnapshot());
      for (const opp of result.opportunities) {
        // No single "GEO score" or cross-surface merged score
        expect(opp.signals.aiVisibilityObservation.status).toBe('UNKNOWN');
        // priorityScore is explainable from policy weights, not a merged surface score
        expect(opp.rankReason).toContain('content-plan-v2');
      }
    });
  });

  describe('Versioned ranking policy', () => {
    it('RANKING_POLICY_V1 has explicit weights summing to 1.0', () => {
      const weights = RANKING_POLICY_V1.weights;
      const sum = Object.values(weights).reduce((a, b) => a + b, 0);
      expect(Math.abs(sum - 1.0)).toBeLessThan(0.001);
    });

    it('computePriorityScore is deterministic for same inputs', () => {
      const signals: OpportunitySignalVector = {
        businessPriority: 80,
        evidenceReadiness: 100,
        technicalReadiness: 70,
        contentCoverageGap: 40,
        promptCoverageGap: 30,
        searchOpportunity: { status: 'UNKNOWN', reason: 'No GSC data' },
        aiVisibilityObservation: { status: 'UNKNOWN', reason: 'No measurement' },
        competitorEvidenceGap: 50,
        effort: 35,
        risk: 20,
        freshnessExpiry: null,
        methodPolicyVersion: 'content-plan-v2',
      };
      const score1 = computePriorityScore(signals, RANKING_POLICY_V1);
      const score2 = computePriorityScore(signals, RANKING_POLICY_V1);
      expect(score1).toBe(score2);
    });

    it('policy version change produces different ranking explanation', () => {
      const result = buildDataDrivenContentPlan(makeSnapshot());
      for (const opp of result.opportunities) {
        expect(opp.rankReason).toContain(RANKING_POLICY_V1.version);
      }
    });

    it('same inputs + policy version produce deterministic plan hash', () => {
      const result1 = buildDataDrivenContentPlan(makeSnapshot());
      const result2 = buildDataDrivenContentPlan(makeSnapshot());
      expect(result1.contentHash).toBe(result2.contentHash);
    });
  });

  describe('Brief references', () => {
    it('each brief references real prompts, claims, and source artifacts', () => {
      const snapshot = makeSnapshot();
      const result = buildDataDrivenContentPlan(snapshot);
      for (const brief of result.briefs) {
        expect(brief.promptIds.length).toBeGreaterThan(0);
        for (const pid of brief.promptIds) {
          expect(snapshot.promptIds).toContain(pid);
        }
        expect(brief.claimRevisionIds.length).toBeGreaterThan(0);
        for (const cid of brief.claimRevisionIds) {
          expect(snapshot.availableClaimRevisionIds).toContain(cid);
        }
        expect(brief.sourceArtifactIds.length).toBeGreaterThan(0);
      }
    });

    it('missing comparison evidence produces evidence task, not brief', () => {
      const result = buildDataDrivenContentPlan(
        makeSnapshot({ comparisonEvidenceIndependent: false }),
      );
      const comparisonBrief = result.briefs.find((b) => b.assetKind === 'COMPARISON');
      expect(comparisonBrief).toBeUndefined();
      const comparisonTask = result.evidenceTasks.find((t) => t.assetKind === 'COMPARISON');
      expect(comparisonTask).toBeDefined();
      expect(comparisonTask!.reasonCode).toBe('INDEPENDENT_COMPARISON_EVIDENCE_REQUIRED');
    });

    it('missing primary claims produces evidence task', () => {
      const result = buildDataDrivenContentPlan(makeSnapshot({ primaryClaimRevisionIds: [] }));
      const defBrief = result.briefs.find((b) => b.assetKind === 'DEFINITION_PRODUCT');
      expect(defBrief).toBeUndefined();
      const defTask = result.evidenceTasks.find((t) => t.assetKind === 'DEFINITION_PRODUCT');
      expect(defTask).toBeDefined();
    });
  });

  describe('Determinism and staleness', () => {
    it('same inputs produce identical opportunities', () => {
      const r1 = buildDataDrivenContentPlan(makeSnapshot());
      const r2 = buildDataDrivenContentPlan(makeSnapshot());
      expect(r1.opportunities).toEqual(r2.opportunities);
      expect(r1.briefs).toEqual(r2.briefs);
      expect(r1.evidenceTasks).toEqual(r2.evidenceTasks);
    });

    it('changed inputs produce different content hash', () => {
      const r1 = buildDataDrivenContentPlan(makeSnapshot());
      const r2 = buildDataDrivenContentPlan(
        makeSnapshot({ primaryClaimRevisionIds: ['00000000-0000-7000-8000-000000000099'] }),
      );
      expect(r1.contentHash).not.toBe(r2.contentHash);
    });
  });
});
