import type { TenantContext } from '@aeostudio/application/identity-access';

export interface InMemoryTenantExportArchive {
  readTenantExportArchive(input: {
    sessionToken: string;
    context: TenantContext;
    exportId: string;
  }): Promise<{
    body: Uint8Array;
    manifestChecksum: string;
    archiveChecksum: string;
    filename: string;
  } | null>;
}
