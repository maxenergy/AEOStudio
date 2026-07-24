export interface BootstrapCriticalSection<State> {
  readTargetSecrets(): Promise<State>;
  reconcileDatabase(state: State): Promise<void>;
  withDatabaseSessionLock<T>(operation: () => Promise<T>): Promise<T>;
  writeTargetSecrets(state: State): Promise<void>;
}

export async function runSerializedBootstrap<State>(
  operations: BootstrapCriticalSection<State>,
): Promise<void> {
  await operations.withDatabaseSessionLock(async () => {
    const state = await operations.readTargetSecrets();
    await operations.reconcileDatabase(state);
    await operations.writeTargetSecrets(state);
  });
}
