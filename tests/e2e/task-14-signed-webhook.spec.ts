import { expect, test, type APIResponse, type Locator, type Page } from '@playwright/test';
import { ArtifactBundleEnvelopeSchema } from '@aeostudio/contracts/artifacts';
import {
  ChannelAuthorizationListEnvelopeSchema,
  decodeSignedWebhookTarget,
  PublicationDetailEnvelopeSchema,
} from '@aeostudio/contracts/channels';

const apiOrigin = 'http://127.0.0.1:3200';
const webOrigin = 'http://127.0.0.1:3100';
const deliveryEndpoint = 'https://receiver.example.test/v1/channel-packages';
const receiptEndpoint = 'https://receiver.example.test/v1/channel-package-receipts';
const endpointVerificationId = '14000000-0000-4000-8000-000000000014';
const signingAlgorithm = 'HMAC_SHA256';
const signingKeyId = 'e2e-primary-2026-07';
const secretArn =
  'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:e2e/signed-webhook-sensitive';

type TestIdentity = 'owner@example.test' | 'publisher@example.test' | 'reviewer@example.test';

interface ApprovedArtifactScope {
  tenantId: string;
  workspaceId: string;
  artifactId: string;
  artifactRevisionId: string;
  revision: number;
  contentHash: string;
}

function requiredParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null || value.length === 0) throw new Error(`EXPECTED_${name.toUpperCase()}`);
  return value;
}

async function authenticatedApiGet(page: Page, url: string): Promise<APIResponse> {
  const cookies = (await page.context().cookies()).filter(
    ({ name }) => name === '__Host-aeo_session',
  );
  const cookie = cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
  if (cookie.length === 0) throw new Error('AUTHENTICATED_API_COOKIE_MISSING');
  return page.request.get(url, { headers: { cookie } });
}

async function loginAs(page: Page, email: TestIdentity): Promise<void> {
  const hint = email === 'owner@example.test' ? '' : `?login_hint=${encodeURIComponent(email)}`;
  await page.goto(`${apiOrigin}/api/v1/auth/login${hint}`);
  await expect(page).toHaveURL(/\/app(?:\?|$)/);
  await expect(page.getByText(email)).toBeVisible();
}

async function selectRegistryEntry(select: Locator, displayName: string): Promise<void> {
  const option = select.locator('option').filter({ hasText: displayName });
  await expect(option).toHaveCount(1);
  const value = await option.getAttribute('value');
  if (value === null || value.length === 0) throw new Error('REGISTRY_OPTION_VALUE_MISSING');
  await select.selectOption(value);
}

async function createApprovedArtifact(page: Page): Promise<ApprovedArtifactScope> {
  await page.goto('/app');
  await page.getByLabel('Tenant 名称').fill('Signed Webhook Tenant');
  await page.getByLabel('Workspace 名称').fill('Signed Webhook Workspace');
  await page.getByRole('button', { name: '创建 Workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Signed Webhook Workspace' })).toBeVisible();

  await page.getByRole('link', { name: 'Artifact Studio' }).click();
  await page.getByRole('button', { name: '保存 Artifact 预算' }).click();
  await page.getByRole('button', { name: '生成 Artifact Draft' }).click();
  await expect(page.getByTestId('artifact-job-status')).toHaveText('SUCCEEDED', {
    timeout: 15_000,
  });

  const artifactUrl = new URL(page.url());
  const tenantId = requiredParam(artifactUrl, 'tenant');
  const workspaceId = requiredParam(artifactUrl, 'workspace');
  const artifactId = requiredParam(artifactUrl, 'artifact');
  const response = await authenticatedApiGet(
    page,
    `${apiOrigin}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/artifacts/${artifactId}`,
  );
  expect(response.status()).toBe(200);
  const bundle = ArtifactBundleEnvelopeSchema.parse(await response.json()).data;
  if (bundle.revision === null) throw new Error('ARTIFACT_REVISION_MISSING');

  await page.getByRole('button', { name: '提交 exact revision/hash 审核' }).click();
  await page
    .getByLabel('Review note')
    .fill('Approved exact revision for the versioned signed webhook delivery.');
  await page.getByRole('button', { name: '批准 exact revision/hash' }).click();
  await expect(page.getByText('Current approval：ELIGIBLE')).toBeVisible();
  return {
    tenantId,
    workspaceId,
    artifactId,
    artifactRevisionId: bundle.revision.id,
    revision: bundle.revision.revision,
    contentHash: bundle.revision.contentHash,
  };
}

async function openChannels(page: Page, scope: ApprovedArtifactScope): Promise<void> {
  await page.goto(
    `${webOrigin}/app/channels?tenant=${scope.tenantId}&workspace=${scope.workspaceId}&artifact=${scope.artifactId}`,
  );
  await expect(
    page.getByRole('heading', { name: /Channel Packages? \/ Publications?/ }),
  ).toBeVisible();
}

async function buildSignedWebhookPackage(
  page: Page,
  scope: ApprovedArtifactScope,
): Promise<string> {
  await page.getByLabel('Approved Artifact revision').selectOption(scope.artifactRevisionId);
  await selectRegistryEntry(page.getByLabel('Channel Registry'), 'Signed Webhook');
  await page.getByRole('button', { name: '生成渠道适配包' }).click();
  const checksum = page.getByTestId('channel-package-checksum');
  await expect(checksum).toHaveText(/^Package checksum：[a-f0-9]{64}$/);
  const packageChecksum = ((await checksum.textContent()) ?? '').match(/[a-f0-9]{64}/)?.[0];
  if (packageChecksum === undefined) throw new Error('PACKAGE_CHECKSUM_MISSING');
  return packageChecksum;
}

async function configureSignedWebhook(page: Page): Promise<void> {
  await page.getByLabel('Webhook delivery endpoint (verified HTTPS)').fill(deliveryEndpoint);
  await page.getByLabel('Webhook receipt endpoint (same verified origin)').fill(receiptEndpoint);
  await page.getByLabel('Endpoint verification ID').fill(endpointVerificationId);

  const algorithm = page.getByLabel('Webhook signing algorithm');
  await expect(algorithm.locator('option[value="HMAC_SHA256"]')).toHaveCount(1);
  await expect(algorithm.locator('option[value="ED25519"]')).toHaveCount(1);
  await algorithm.selectOption(signingAlgorithm);
  await page.getByLabel('Webhook signing key ID').fill(signingKeyId);
  await page.getByLabel('Webhook signing key ring secret ARN').fill(secretArn);

  await page.getByRole('button', { name: '保存 Signed Webhook 授权与目标' }).click();
  await expect(page.getByText(/Signed Webhook 授权与目标已保存，等待提供商验证/)).toBeVisible();
}

async function setWorkspaceBudget(page: Page, scope: ApprovedArtifactScope): Promise<void> {
  await page.goto(
    `${webOrigin}/app/jobs?tenant=${scope.tenantId}&workspace=${scope.workspaceId}&profile=${scope.artifactId}`,
  );
  await page.getByLabel('Workspace 预算上限', { exact: true }).fill('100');
  await page.getByRole('button', { name: '保存 Workspace 预算', exact: true }).click();
  await expect(page.getByText('预算上限已更新')).toBeVisible();
}

async function inviteAsOwner(
  page: Page,
  email: 'publisher@example.test' | 'reviewer@example.test',
  role: 'PUBLISHER' | 'REVIEWER',
): Promise<string> {
  await page.getByLabel('受邀人邮箱').fill(email);
  await page.getByLabel('角色').selectOption(role);
  await page.getByRole('button', { name: '发送邀请' }).click();
  await expect(page.getByText('邀请已创建，等待对方接受。')).toBeVisible();
  const href = await page.getByRole('link', { name: `${email} 接受邀请链接` }).getAttribute('href');
  if (href === null) throw new Error('INVITATION_ACCEPTANCE_LINK_MISSING');
  return href;
}

async function acceptInvitation(page: Page, href: string, role: string): Promise<void> {
  await page.goto(`${webOrigin}${href}`);
  await page.getByRole('button', { name: '接受 Workspace 邀请' }).click();
  await expect(page.getByText(`当前角色：${role}`)).toBeVisible();
}

test('a Publisher sends one approved package through a verified signed webhook and reconciles one receipt', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const ownerContext = await browser.newContext();
  const publisherContext = await browser.newContext();
  const reviewerContext = await browser.newContext();
  try {
    const ownerPage = await ownerContext.newPage();
    await loginAs(ownerPage, 'owner@example.test');
    const scope = await createApprovedArtifact(ownerPage);
    await openChannels(ownerPage, scope);
    await expect(
      ownerPage.getByTestId('channel-registry-entry').filter({ hasText: 'Signed Webhook' }),
    ).toHaveCount(1);
    const packageChecksum = await buildSignedWebhookPackage(ownerPage, scope);
    await configureSignedWebhook(ownerPage);

    const packageUrl = new URL(ownerPage.url());
    requiredParam(packageUrl, 'package');
    const target = requiredParam(packageUrl, 'target');
    expect(decodeSignedWebhookTarget(target)).toEqual({
      schemaVersion: 'signed-webhook-target.v1',
      endpointUrl: deliveryEndpoint,
      receiptUrl: receiptEndpoint,
      endpointVerificationId,
      algorithm: signingAlgorithm,
      keyId: signingKeyId,
    });
    expect(target).not.toContain(secretArn);

    const preview = ownerPage.getByTestId('signed-webhook-delivery-preview');
    await expect(preview).toContainText(`POST ${deliveryEndpoint}`);
    await expect(preview).toContainText('schemaVersion：1.0.0');
    await expect(preview).toContainText('eventType：channel-package.approved.v1');
    await expect(preview).toContainText(`algorithm：${signingAlgorithm}`);
    await expect(preview).toContainText(`keyId：${signingKeyId}`);
    await expect(preview).toContainText(scope.artifactRevisionId);
    await expect(preview).toContainText(`R${scope.revision}`);
    await expect(preview).toContainText(scope.contentHash);
    await expect(preview).toContainText(packageChecksum);
    await expect(ownerPage.getByTestId('channel-adapter-required-scopes')).toHaveText(
      'webhook:deliver',
    );
    await expect(ownerPage.getByTestId('publication-eligibility')).toContainText('PUBLISH_READY');
    await expect(ownerPage.locator('body')).not.toContainText(secretArn);

    const authorizationsResponse = await authenticatedApiGet(
      ownerPage,
      `${apiOrigin}/api/v1/tenants/${scope.tenantId}/workspaces/${scope.workspaceId}/channel-authorizations`,
    );
    expect(authorizationsResponse.status()).toBe(200);
    const authorizationsText = await authorizationsResponse.text();
    expect(authorizationsText).not.toContain(secretArn);
    const authorizations = ChannelAuthorizationListEnvelopeSchema.parse(
      JSON.parse(authorizationsText),
    );
    expect(authorizations.data.authorizations).toContainEqual(
      expect.objectContaining({ target, secretConfigured: true }),
    );

    await setWorkspaceBudget(ownerPage, scope);
    await ownerPage.goto(
      `${webOrigin}/app?tenant=${scope.tenantId}&workspace=${scope.workspaceId}`,
    );
    const publisherInvitation = await inviteAsOwner(
      ownerPage,
      'publisher@example.test',
      'PUBLISHER',
    );
    const reviewerInvitation = await inviteAsOwner(ownerPage, 'reviewer@example.test', 'REVIEWER');

    const publisherPage = await publisherContext.newPage();
    await loginAs(publisherPage, 'publisher@example.test');
    await acceptInvitation(publisherPage, publisherInvitation, 'Publisher');
    await publisherPage.goto(packageUrl.href);
    await expect(publisherPage.getByTestId('signed-webhook-delivery-preview')).toBeVisible();
    await expect(publisherPage.getByTestId('publication-eligibility')).toContainText(
      'PUBLISH_READY',
    );
    const publishButton = publisherPage.getByRole('button', {
      name: '审核后发送 Signed Webhook',
    });
    await expect(publishButton).toBeVisible();
    await publishButton.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });

    await expect(publisherPage.getByTestId('publication-status')).toHaveText('REMOTE_APPLIED', {
      timeout: 20_000,
    });
    await expect(publisherPage.getByTestId('publication-remote-status')).toHaveText('DELIVERED');
    await expect(publisherPage.getByTestId('publication-production-live')).toHaveText(
      'Webhook 已送达接收端，但不代表 CMS 内容已生产上线。',
    );
    await expect(publisherPage.locator('body')).not.toContainText('远端效果已标记为生产上线。');

    const publishedUrl = new URL(publisherPage.url());
    const publicationId = requiredParam(publishedUrl, 'publication');
    const receiptRemoteRef = `${receiptEndpoint}/${publicationId}`;
    await expect(publisherPage.getByTestId('publication-remote-ref')).toHaveText(receiptRemoteRef);
    const attempts = publisherPage.getByTestId('publication-attempt');
    await expect(attempts).toHaveCount(2);
    await expect(attempts.nth(0)).toContainText('PUBLISH · AMBIGUOUS');
    await expect(attempts.nth(1)).toContainText('RECONCILE · APPLIED');

    const detailResponse = await authenticatedApiGet(
      publisherPage,
      `${apiOrigin}/api/v1/tenants/${scope.tenantId}/workspaces/${scope.workspaceId}/publications/${publicationId}`,
    );
    expect(detailResponse.status()).toBe(200);
    const detailText = await detailResponse.text();
    expect(detailText).not.toContain(secretArn);
    const detail = PublicationDetailEnvelopeSchema.parse(JSON.parse(detailText)).data;
    expect(detail.publication).toMatchObject({
      id: publicationId,
      packageChecksum,
      artifactRevisionId: scope.artifactRevisionId,
      artifactContentHash: scope.contentHash,
      status: 'REMOTE_APPLIED',
      remoteRef: receiptRemoteRef,
      remoteState: {
        status: 'DELIVERED',
        number: null,
        isProductionLive: false,
        rollbackHandle: null,
        receiptEvidence: {
          schemaVersion: 'signed-webhook-receipt-evidence.v1',
          receiptId: `receipt:${publicationId}`,
          deliveryId: publicationId,
          receiverEffectId: `effect:${publicationId}`,
          requestBodySha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          verifiedKeyId: signingKeyId,
          verifiedAlgorithm: signingAlgorithm,
          receivedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        },
      },
    });
    expect(detail.attempts.map(({ operation, outcome }) => ({ operation, outcome }))).toEqual([
      { operation: 'PUBLISH', outcome: 'AMBIGUOUS' },
      { operation: 'RECONCILE', outcome: 'APPLIED' },
    ]);
    expect(detail.attempts.filter(({ outcome }) => outcome === 'APPLIED')).toHaveLength(1);
    expect(
      detail.attempts
        .filter(({ remoteRef }) => remoteRef !== null)
        .map(({ remoteRef }) => remoteRef),
    ).toEqual([receiptRemoteRef]);
    expect(detail.job.status).toBe('SUCCEEDED');

    await publisherPage.goto(packageUrl.href);
    await publisherPage.getByRole('button', { name: '审核后发送 Signed Webhook' }).click();
    await expect(publisherPage.getByTestId('publication-status')).toHaveText('REMOTE_APPLIED', {
      timeout: 20_000,
    });
    expect(requiredParam(new URL(publisherPage.url()), 'publication')).toBe(publicationId);
    await expect(publisherPage.getByTestId('publication-attempt')).toHaveCount(2);
    await expect(publisherPage.getByTestId('publication-remote-ref')).toHaveText(receiptRemoteRef);

    const reviewerPage = await reviewerContext.newPage();
    await loginAs(reviewerPage, 'reviewer@example.test');
    await acceptInvitation(reviewerPage, reviewerInvitation, 'Reviewer');
    await reviewerPage.goto(publishedUrl.href);
    await expect(reviewerPage.getByTestId('publication-status')).toHaveText('REMOTE_APPLIED');
    await expect(
      reviewerPage.getByRole('button', { name: '审核后发送 Signed Webhook' }),
    ).toHaveCount(0);
    await expect(reviewerPage.getByTestId('publication-production-live')).toHaveText(
      'Webhook 已送达接收端，但不代表 CMS 内容已生产上线。',
    );

    for (const page of [ownerPage, publisherPage, reviewerPage]) {
      await expect(page.locator('body')).not.toContainText(secretArn);
      await expect(page.locator('body')).not.toContainText('远端效果已标记为生产上线。');
    }
  } finally {
    await Promise.all([ownerContext.close(), publisherContext.close(), reviewerContext.close()]);
  }
});
