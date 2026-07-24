import type { PromptResearchStore } from '@aeostudio/application/prompt-research';

export class MissingPromptResearchStore implements PromptResearchStore {
  listRegistry(): ReturnType<PromptResearchStore['listRegistry']> {
    return Promise.reject(new Error('PROMPT_RESEARCH_STORE_NOT_CONFIGURED'));
  }

  createProposal(): ReturnType<PromptResearchStore['createProposal']> {
    return Promise.reject(new Error('PROMPT_RESEARCH_STORE_NOT_CONFIGURED'));
  }

  findCurrent(): ReturnType<PromptResearchStore['findCurrent']> {
    return Promise.reject(new Error('PROMPT_RESEARCH_STORE_NOT_CONFIGURED'));
  }

  findRevision(): ReturnType<PromptResearchStore['findRevision']> {
    return Promise.reject(new Error('PROMPT_RESEARCH_STORE_NOT_CONFIGURED'));
  }

  createRevision(): ReturnType<PromptResearchStore['createRevision']> {
    return Promise.reject(new Error('PROMPT_RESEARCH_STORE_NOT_CONFIGURED'));
  }

  approveRevision(): ReturnType<PromptResearchStore['approveRevision']> {
    return Promise.reject(new Error('PROMPT_RESEARCH_STORE_NOT_CONFIGURED'));
  }

  listApprovedPromptSets(): ReturnType<PromptResearchStore['listApprovedPromptSets']> {
    return Promise.reject(new Error('PROMPT_RESEARCH_STORE_NOT_CONFIGURED'));
  }
}
