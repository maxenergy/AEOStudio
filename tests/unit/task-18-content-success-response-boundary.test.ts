import { describe, expect, test, vi } from 'vitest';

import { ArtifactsController } from '../../apps/api/src/artifacts/artifacts.controller.js';
import { ClaimsController } from '../../apps/api/src/claims/claims.controller.js';
import { ContentPlansController } from '../../apps/api/src/content-plans/content-plans.controller.js';
import { ProfileOfferingController } from '../../apps/api/src/profile-offering/profile-offering.controller.js';
import { PromptsController } from '../../apps/api/src/prompts/prompts.controller.js';

const tenantId = '018f3b76-1000-7000-8000-000000000001';
const workspaceId = '018f3b76-1000-7000-8000-000000000002';
const aggregateId = '018f3b76-1000-7000-8000-000000000003';

describe('Content HTTP success response boundaries', () => {
  test('Artifact revision creation fails closed when the application emits an uncontracted success', async () => {
    const controller = new ArtifactsController(
      authenticatedSession() as never,
      'https://app.example.test',
      {
        createRevision: () => Promise.resolve({ outcome: 'SUCCEEDED', artifact: {}, revision: {} }),
      } as never,
      {} as never,
      {} as never,
    );

    await expect(
      controller.createRevision(
        tenantId,
        workspaceId,
        aggregateId,
        {
          expectedRevision: 1,
          payload: {
            title: 'Exact title',
            summary: 'Exact summary',
            sections: [],
            claimMap: [],
            disclosure: 'Reviewed content.',
          },
        },
        requestDouble(),
        replyDouble() as never,
      ),
    ).rejects.toThrow();
  });

  test('Artifact errors fail closed when required Problem Details fields are invalid', async () => {
    const controller = new ArtifactsController(
      {} as never,
      'https://app.example.test',
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      controller.get(
        tenantId,
        workspaceId,
        aggregateId,
        unauthenticatedRequestWithInvalidId(),
        replyDouble() as never,
      ),
    ).rejects.toThrow();
  });

  test('Evidence Source creation fails closed when the application emits an uncontracted success', async () => {
    const controller = new ClaimsController(
      authenticatedSession() as never,
      'https://app.example.test',
      {
        registerSource: () => Promise.resolve({ outcome: 'SUCCEEDED', source: {} }),
      } as never,
    );

    await expect(
      controller.createSource(
        tenantId,
        workspaceId,
        {
          sourceType: 'UPLOAD',
          title: 'Reviewed source',
          uri: null,
          license: 'Internal evidence',
          publicity: 'PRIVATE',
        },
        requestDouble(),
        replyDouble() as never,
      ),
    ).rejects.toThrow();
  });

  test('Claim errors fail closed when required Problem Details fields are invalid', async () => {
    const controller = new ClaimsController({} as never, 'https://app.example.test', {} as never);

    await expect(
      controller.getClaim(
        tenantId,
        workspaceId,
        aggregateId,
        unauthenticatedRequestWithInvalidId(),
        replyDouble() as never,
      ),
    ).rejects.toThrow();
  });

  test('Content Plan reads fail closed when the application emits an uncontracted success', async () => {
    const controller = new ContentPlansController(
      authenticatedSession() as never,
      'https://app.example.test',
      { getPlan: () => Promise.resolve({}) } as never,
      {} as never,
      {} as never,
    );

    await expect(
      controller.get(tenantId, workspaceId, aggregateId, requestDouble(), replyDouble() as never),
    ).rejects.toThrow();
  });

  test('Content Plan errors fail closed when required Problem Details fields are invalid', async () => {
    const controller = new ContentPlansController(
      {} as never,
      'https://app.example.test',
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      controller.get(
        tenantId,
        workspaceId,
        aggregateId,
        unauthenticatedRequestWithInvalidId(),
        replyDouble() as never,
      ),
    ).rejects.toThrow();
  });

  test('Measurement registry reads fail closed when the application emits an uncontracted success', async () => {
    const controller = new PromptsController(
      authenticatedSession() as never,
      'https://app.example.test',
      { listRegistry: () => Promise.resolve([{}]) } as never,
    );

    await expect(
      controller.registry(tenantId, workspaceId, requestDouble(), replyDouble() as never),
    ).rejects.toThrow();
  });

  test('Prompt errors fail closed when required Problem Details fields are invalid', async () => {
    const controller = new PromptsController({} as never, 'https://app.example.test', {} as never);

    await expect(
      controller.registry(
        tenantId,
        workspaceId,
        unauthenticatedRequestWithInvalidId(),
        replyDouble() as never,
      ),
    ).rejects.toThrow();
  });

  test('Profile revision reads fail closed when the application emits an uncontracted success', async () => {
    const controller = new ProfileOfferingController(
      authenticatedSession() as never,
      'https://app.example.test',
      { getProfileRevision: () => Promise.resolve({}) } as never,
    );

    await expect(
      controller.getProfileRevision(
        tenantId,
        workspaceId,
        aggregateId,
        '1',
        requestDouble(),
        replyDouble() as never,
      ),
    ).rejects.toThrow();
  });

  test('Profile errors fail closed when required Problem Details fields are invalid', async () => {
    const controller = new ProfileOfferingController(
      {} as never,
      'https://app.example.test',
      {} as never,
    );

    await expect(
      controller.getProfileRevision(
        tenantId,
        workspaceId,
        aggregateId,
        '1',
        unauthenticatedRequestWithInvalidId(),
        replyDouble() as never,
      ),
    ).rejects.toThrow();
  });
});

function authenticatedSession() {
  return {
    getSession: () => Promise.resolve({ subject: 'subject-1' }),
  };
}

function requestDouble() {
  return {
    cookies: { '__Host-aeo_session': 'session-token' },
    headers: { origin: 'https://app.example.test' },
    id: 'content-response-boundary-request',
  } as never;
}

function unauthenticatedRequestWithInvalidId() {
  return {
    cookies: {},
    headers: {},
    id: '',
  } as never;
}

function replyDouble() {
  return {
    statusCode: 200,
    code: vi.fn(function (this: { statusCode: number }, status: number) {
      this.statusCode = status;
      return this;
    }),
  };
}
