import type { ArtifactStore } from '@aeostudio/application/artifacts';

export class MissingArtifactStore implements ArtifactStore {
  prepareArtifact(): ReturnType<ArtifactStore['prepareArtifact']> {
    return Promise.reject(new Error('ARTIFACT_STORE_NOT_CONFIGURED'));
  }

  bindJob(): ReturnType<ArtifactStore['bindJob']> {
    return Promise.reject(new Error('ARTIFACT_STORE_NOT_CONFIGURED'));
  }

  loadWriterContext(): ReturnType<ArtifactStore['loadWriterContext']> {
    return Promise.reject(new Error('ARTIFACT_STORE_NOT_CONFIGURED'));
  }

  completeGeneration(): ReturnType<ArtifactStore['completeGeneration']> {
    return Promise.reject(new Error('ARTIFACT_STORE_NOT_CONFIGURED'));
  }

  createRevision(): ReturnType<ArtifactStore['createRevision']> {
    return Promise.reject(new Error('ARTIFACT_STORE_NOT_CONFIGURED'));
  }

  submitRevision(): ReturnType<ArtifactStore['submitRevision']> {
    return Promise.reject(new Error('ARTIFACT_STORE_NOT_CONFIGURED'));
  }

  reviewRevision(): ReturnType<ArtifactStore['reviewRevision']> {
    return Promise.reject(new Error('ARTIFACT_STORE_NOT_CONFIGURED'));
  }

  findBundle(): ReturnType<ArtifactStore['findBundle']> {
    return Promise.reject(new Error('ARTIFACT_STORE_NOT_CONFIGURED'));
  }
}
