/** 官网导入：企业资料候选项。 */
export interface WebsiteImportProfileCandidate {
  displayName: string;
  description: string;
  websiteUrl: string;
  locale: string;
  market: string;
}

/** 官网导入：产品/服务候选项。 */
export interface WebsiteImportOfferingCandidate {
  candidateId: string;
  kind: string;
  name: string;
  description: string;
  locale: string;
  market: string;
}

/** 官网导入：FAQ 候选项（需后续补充证据后创建为事实声明）。 */
export interface WebsiteImportFaqCandidate {
  candidateId: string;
  question: string;
  answer: string;
}

export type WebsiteImportStatus = 'PENDING_CONFIRMATION' | 'CONFIRMED';

/** 一次官网导入会话（含候选数据与确认状态）。 */
export interface WebsiteImportSession {
  importId: string;
  tenantId: string;
  workspaceId: string;
  url: string;
  status: WebsiteImportStatus;
  profile: WebsiteImportProfileCandidate;
  offerings: WebsiteImportOfferingCandidate[];
  faqs: WebsiteImportFaqCandidate[];
  createdAt: string;
}

export interface WebsiteImportStore {
  save(session: WebsiteImportSession): Promise<void>;
  find(input: {
    tenantId: string;
    workspaceId: string;
    importId: string;
  }): Promise<WebsiteImportSession | null>;
}
