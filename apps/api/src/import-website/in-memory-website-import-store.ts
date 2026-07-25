import type { WebsiteImportSession, WebsiteImportStore } from '@aeostudio/application/import';

/**
 * In-memory website import session store. Sessions are keyed by
 * tenant/workspace/importId and hold the candidate data awaiting confirmation.
 */
export class InMemoryWebsiteImportStore implements WebsiteImportStore {
  private readonly sessions = new Map<string, WebsiteImportSession>();

  private key(input: { tenantId: string; workspaceId: string; importId: string }): string {
    return `${input.tenantId}:${input.workspaceId}:${input.importId}`;
  }

  save(session: WebsiteImportSession): Promise<void> {
    this.sessions.set(
      this.key({
        tenantId: session.tenantId,
        workspaceId: session.workspaceId,
        importId: session.importId,
      }),
      structuredClone(session),
    );
    return Promise.resolve();
  }

  find(input: {
    tenantId: string;
    workspaceId: string;
    importId: string;
  }): Promise<WebsiteImportSession | null> {
    const session = this.sessions.get(this.key(input));
    return Promise.resolve(session === undefined ? null : structuredClone(session));
  }
}
