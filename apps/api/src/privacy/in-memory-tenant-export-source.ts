import type { TenantExportSourceObject } from '@aeostudio/application/privacy-audit';

export interface InMemoryTenantExportSource {
  listTenantExportObjects(input: {
    tenantId: string;
    from: Date;
    to: Date;
  }): Promise<TenantExportSourceObject[]>;
}
