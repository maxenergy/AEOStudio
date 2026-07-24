import type {
  ManualMeasurementImportRecord,
  ManualMeasurementImportSlot,
  ManualMeasurementImportStore,
} from '@aeostudio/application/measurement';
import type { TenantContext } from '@aeostudio/application/identity-access';

interface State {
  context: TenantContext;
  idempotencyKey: string;
  manualImport: ManualMeasurementImportRecord;
  slots: Map<string, ManualMeasurementImportSlot>;
}

/** Process-memory persistence used only behind the explicit fake-runtime gate. */
export class InMemoryManualMeasurementImportStore implements ManualMeasurementImportStore {
  private readonly states = new Map<string, State>();

  submit(input: Parameters<ManualMeasurementImportStore['submit']>[0]) {
    const replay = [...this.states.values()].find(
      (state) =>
        inScope(state.context, input.context) && state.idempotencyKey === input.idempotencyKey,
    );
    if (replay !== undefined) {
      return Promise.resolve(
        replay.manualImport.contentHash === input.manualImport.contentHash
          ? ({ outcome: 'SUCCEEDED', manualImport: clone(replay.manualImport) } as const)
          : ({ outcome: 'IDEMPOTENCY_CONFLICT' } as const),
      );
    }
    this.states.set(input.manualImport.id, {
      context: clone(input.context),
      idempotencyKey: input.idempotencyKey,
      manualImport: clone(input.manualImport),
      slots: new Map(
        input.slots.map((slot) => [
          slotKey(slot.promptId, slot.scopeKey, slot.repetition),
          clone(slot),
        ]),
      ),
    });
    return Promise.resolve({
      outcome: 'SUCCEEDED',
      manualImport: clone(input.manualImport),
    } as const);
  }

  find(input: Parameters<ManualMeasurementImportStore['find']>[0]) {
    const state = this.states.get(input.manualImportId);
    return Promise.resolve(
      state === undefined || !inScope(state.context, input.context)
        ? null
        : clone(state.manualImport),
    );
  }

  findWithSlots(input: Parameters<ManualMeasurementImportStore['findWithSlots']>[0]) {
    const state = this.states.get(input.manualImportId);
    return Promise.resolve(
      state === undefined || !inScope(state.context, input.context)
        ? null
        : {
            manualImport: clone(state.manualImport),
            slots: [...state.slots.values()].map(clone),
          },
    );
  }

  review(input: Parameters<ManualMeasurementImportStore['review']>[0]) {
    const state = this.states.get(input.manualImportId);
    if (state === undefined || !inScope(state.context, input.context)) {
      return Promise.resolve({ outcome: 'NOT_FOUND' } as const);
    }
    if (state.manualImport.contentHash !== input.expectedContentHash) {
      return Promise.resolve({ outcome: 'HASH_MISMATCH' } as const);
    }
    if (state.manualImport.submittedByUserId === input.context.actorUserId) {
      return Promise.resolve({ outcome: 'SELF_REVIEW' } as const);
    }
    if (state.manualImport.status !== 'SUBMITTED') {
      return Promise.resolve({ outcome: 'ALREADY_REVIEWED' } as const);
    }
    if (
      state.slots.size !== state.manualImport.expectedSlotCount ||
      [...state.slots.values()].filter((slot) => slot.provided).length !==
        state.manualImport.providedSlotCount
    ) {
      return Promise.resolve({ outcome: 'INVALID_SLOT_SET' } as const);
    }
    state.manualImport.status = input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    state.manualImport.reviewedByUserId = input.context.actorUserId;
    state.manualImport.reviewedAt = input.reviewedAt.toISOString();
    state.manualImport.reviewNote = input.note;
    return Promise.resolve({
      outcome: 'SUCCEEDED',
      manualImport: clone(state.manualImport),
    } as const);
  }

  readReviewedSlot(input: Parameters<ManualMeasurementImportStore['readReviewedSlot']>[0]) {
    const state = this.states.get(input.manualImportId);
    if (
      state === undefined ||
      state.context.tenantId !== input.tenantId ||
      state.context.workspaceId !== input.workspaceId ||
      state.manualImport.status !== 'APPROVED' ||
      state.manualImport.contentHash !== input.expectedContentHash
    ) {
      return Promise.resolve({ outcome: 'INVALID' } as const);
    }
    const slot = state.slots.get(slotKey(input.promptId, input.scopeKey, input.repetition));
    if (slot === undefined) {
      return Promise.resolve({
        outcome: 'INVALID',
        costCurrency: state.manualImport.costCurrency,
      } as const);
    }
    return Promise.resolve(
      slot.provided
        ? ({ outcome: 'FOUND', slot: clone(slot) } as const)
        : ({ outcome: 'MISSING', costCurrency: state.manualImport.costCurrency } as const),
    );
  }
}

function inScope(left: TenantContext, right: TenantContext): boolean {
  return left.tenantId === right.tenantId && left.workspaceId === right.workspaceId;
}

function slotKey(promptId: string, scopeKey: string, repetition: number): string {
  return JSON.stringify([promptId, scopeKey, repetition]);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
