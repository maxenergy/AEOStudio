import type { ContentPlanningStore } from '@aeostudio/application/content-planning';

export class MissingContentPlanningStore implements ContentPlanningStore {
  preparePlan(): ReturnType<ContentPlanningStore['preparePlan']> {
    return Promise.reject(new Error('CONTENT_PLANNING_STORE_NOT_CONFIGURED'));
  }

  bindJob(): ReturnType<ContentPlanningStore['bindJob']> {
    return Promise.reject(new Error('CONTENT_PLANNING_STORE_NOT_CONFIGURED'));
  }

  findBundle(): ReturnType<ContentPlanningStore['findBundle']> {
    return Promise.reject(new Error('CONTENT_PLANNING_STORE_NOT_CONFIGURED'));
  }

  loadInput(): ReturnType<ContentPlanningStore['loadInput']> {
    return Promise.reject(new Error('CONTENT_PLANNING_STORE_NOT_CONFIGURED'));
  }

  completePlan(): ReturnType<ContentPlanningStore['completePlan']> {
    return Promise.reject(new Error('CONTENT_PLANNING_STORE_NOT_CONFIGURED'));
  }

  reviewBrief(): ReturnType<ContentPlanningStore['reviewBrief']> {
    return Promise.reject(new Error('CONTENT_PLANNING_STORE_NOT_CONFIGURED'));
  }
}
