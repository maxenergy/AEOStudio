import { expect, test, type APIResponse, type Locator, type Page } from '@playwright/test';
import { ArtifactBundleEnvelopeSchema } from '@aeostudio/contracts/artifacts';
import { PublicationDetailEnvelopeSchema } from '@aeostudio/contracts/channels';
import { MeasurementRunEnvelopeSchema } from '@aeostudio/contracts/measurement';

const apiOrigin = 'http://127.0.0.1:3200';
const reviewedTarget = 'fake://task-16-reviewed-publication';

type TestIdentity = 'owner@example.test';

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

async function selectRegistryEntry(select: Locator, displayName: string): Promise<void> {
  const option = select.locator('option').filter({ hasText: displayName });
  await expect(option).toHaveCount(1);
  const value = await option.getAttribute('value');
  if (value === null || value.length === 0) throw new Error('REGISTRY_OPTION_VALUE_MISSING');
  await select.selectOption(value);
}

async function loginAs(page: Page, email: TestIdentity): Promise<void> {
  await page.goto(`${apiOrigin}/api/v1/auth/login`);
  await expect(page).toHaveURL(/\/app(?:\?|$)/u);
  await expect(page.getByText(email)).toBeVisible();
}

test('an Owner compares a published intervention between compatible immutable measurements', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await loginAs(page, 'owner@example.test');
  await page.goto('/app');
  await page.getByLabel('Tenant 名称').fill('Experiment RED Tenant');
  await page.getByLabel('Workspace 名称').fill('Experiment RED Workspace');
  await page.getByRole('button', { name: '创建 Workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Experiment RED Workspace' })).toBeVisible();

  const scopeHref = await page
    .getByRole('link', { name: 'Prompt / Scenario Lab' })
    .getAttribute('href');
  if (scopeHref === null) throw new Error('EXPERIMENT_SCOPE_LINK_MISSING');
  const scope = new URL(scopeHref, page.url());
  const tenantId = scope.searchParams.get('tenant');
  const workspaceId = scope.searchParams.get('workspace');
  if (tenantId === null || workspaceId === null) throw new Error('EXPERIMENT_SCOPE_MISSING');

  await expect(
    page.getByRole('link', { name: 'Experiment Comparison' }),
    'expected the scoped Workspace navigation to expose Experiment Comparison',
  ).toHaveAttribute('href', `/app/experiments?tenant=${tenantId}&workspace=${workspaceId}`);

  await page.getByRole('link', { name: 'Artifact Studio' }).click();
  await page.getByRole('button', { name: '保存 Artifact 预算' }).click();
  await page.getByRole('button', { name: '生成 Artifact Draft' }).click();
  await expect(page.getByTestId('artifact-job-status')).toHaveText('SUCCEEDED', {
    timeout: 15_000,
  });
  await page.getByRole('button', { name: '提交 exact revision/hash 审核' }).click();
  await page.getByLabel('Review note').fill('Approved exact intervention revision for Task 16.');
  await page.getByRole('button', { name: '批准 exact revision/hash' }).click();
  await expect(page.getByText('Current approval：ELIGIBLE')).toBeVisible();
  const artifactUrl = new URL(page.url());
  const artifactId = requiredParam(artifactUrl, 'artifact');
  const artifactResponse = await authenticatedApiGet(
    page,
    `${apiOrigin}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/artifacts/${artifactId}`,
  );
  expect(artifactResponse.ok()).toBe(true);
  const artifact = ArtifactBundleEnvelopeSchema.parse(await artifactResponse.json()).data;
  if (artifact.revision === null) throw new Error('EXPERIMENT_ARTIFACT_REVISION_MISSING');
  const publishedRevision = artifact.revision;
  const publishedReview = artifact.reviews.find(
    (review) =>
      review.decision === 'APPROVE' &&
      review.artifactRevisionId === publishedRevision.id &&
      review.contentHash === publishedRevision.contentHash,
  );
  if (publishedReview === undefined) throw new Error('EXPERIMENT_PUBLICATION_REVIEW_MISSING');

  await page.goto(scopeHref);
  await page.getByLabel('Prompt Set 标题').fill('Compatible immutable experiment');
  await page.getByLabel('研究主题').fill('Workspace-defined product evidence');
  await page.getByLabel('Profile revision ID').fill('00000000-0000-7000-8000-000000000711');
  await page.getByLabel('Offering revision ID').fill('00000000-0000-7000-8000-000000000712');
  await page.getByLabel('Market', { exact: true }).fill('SG');
  await page.getByLabel('Locale', { exact: true }).fill('en-SG');
  await page.getByLabel('Region', { exact: true }).fill('Singapore');
  await page.getByLabel('Model', { exact: true }).fill('fixture-search-model');
  await page.getByLabel('Model version').fill('2026-07');
  await page.getByLabel('Account').fill('workspace-fixture-account');
  await page.getByLabel('Repetitions').fill('3');
  await page.getByRole('button', { name: '生成 20 个确定性问题草稿' }).click();
  await page.getByRole('button', { name: '批准 exact Prompt / Scenario hash' }).click();
  await expect(page.getByTestId('prompt-status')).toHaveText('APPROVED');
  await expect(page.getByRole('button', { name: '启动 Measurement baseline' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: '启动 Measurement remeasurement' }),
    'expected an approved exact Prompt/Scenario to expose the public REMEASUREMENT action',
  ).toBeVisible();
  const promptUrl = page.url();

  await page.goto(
    `/app/jobs?tenant=${tenantId}&workspace=${workspaceId}` +
      '&profile=00000000-0000-7000-8000-000000000711',
  );
  await page.getByLabel('Workspace 预算上限', { exact: true }).fill('500');
  await page.getByRole('button', { name: '保存 Workspace 预算', exact: true }).click();
  await expect(page.getByText('预算上限已更新')).toBeVisible();

  await page.goto(promptUrl);
  await page.getByRole('button', { name: '启动 Measurement baseline' }).click();
  await expect(page).toHaveURL(/\/app\/measurement\?/u, { timeout: 20_000 });
  await expect(page.getByTestId('measurement-run-status')).toHaveText('COMPLETED', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('measurement-run-progress')).toHaveText('60 / 60 PromptRuns');
  const baselineRunId = new URL(page.url()).searchParams.get('run');
  if (baselineRunId === null) throw new Error('EXPERIMENT_BASELINE_RUN_MISSING');
  const baselineResponse = await authenticatedApiGet(
    page,
    `${apiOrigin}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/measurement-runs/${baselineRunId}`,
  );
  expect(baselineResponse.ok()).toBe(true);
  const baselineRun = MeasurementRunEnvelopeSchema.parse(await baselineResponse.json()).data
    .measurementRun;
  expect(baselineRun.startedAt).not.toBeNull();
  expect(baselineRun.completedAt).not.toBeNull();

  await page.goto(`/app/artifacts?tenant=${tenantId}&workspace=${workspaceId}`);
  await page.getByRole('button', { name: '保存 Artifact 预算' }).click();
  await page.getByRole('button', { name: '生成 Artifact Draft' }).click();
  await expect(page.getByTestId('artifact-job-status')).toHaveText('SUCCEEDED', {
    timeout: 15_000,
  });
  await page.getByRole('button', { name: '提交 exact revision/hash 审核' }).click();
  await page
    .getByLabel('Review note')
    .fill('Approved event candidate without any external publication claim.');
  await page.getByRole('button', { name: '批准 exact revision/hash' }).click();
  await expect(page.getByText('Current approval：ELIGIBLE')).toBeVisible();
  const approvedArtifactId = requiredParam(new URL(page.url()), 'artifact');
  const approvedArtifactResponse = await authenticatedApiGet(
    page,
    `${apiOrigin}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/artifacts/${approvedArtifactId}`,
  );
  expect(approvedArtifactResponse.ok()).toBe(true);
  const approvedArtifact = ArtifactBundleEnvelopeSchema.parse(
    await approvedArtifactResponse.json(),
  ).data;
  if (approvedArtifact.revision === null) {
    throw new Error('EXPERIMENT_APPROVED_ARTIFACT_REVISION_MISSING');
  }
  const approvedReview = approvedArtifact.reviews.find(
    (review) =>
      review.decision === 'APPROVE' &&
      review.artifactRevisionId === approvedArtifact.revision.id &&
      review.contentHash === approvedArtifact.revision.contentHash,
  );
  if (approvedReview === undefined) throw new Error('EXPERIMENT_APPROVAL_EVENT_MISSING');

  await page.goto(
    `/app/channels?tenant=${tenantId}&workspace=${workspaceId}&artifact=${artifactId}`,
  );
  await page.getByLabel('Approved Artifact revision').selectOption(artifact.revision.id);
  await selectRegistryEntry(page.getByLabel('Channel Registry'), 'Reviewed Test Publisher');
  await page.getByRole('button', { name: '生成渠道适配包' }).click();
  await expect(page.getByTestId('channel-package-checksum')).toHaveText(
    /^Package checksum：[a-f0-9]{64}$/u,
  );
  await page.getByLabel('授权目标').fill(reviewedTarget);
  await page
    .getByLabel('AWS Secrets Manager ARN')
    .fill('arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:e2e/task-16');
  await page.getByLabel('授权到期时间').fill('2099-12-31T23:59:59+08:00');
  await page.getByRole('button', { name: '保存 Channel 授权' }).click();
  await expect(page.getByText(/Channel 授权请求已保存，等待提供商验证/)).toBeVisible();
  await page.getByRole('button', { name: '审核后发布' }).click();
  await expect(page.getByTestId('publication-status')).toHaveText('PUBLISHED', {
    timeout: 20_000,
  });
  const publicationId = requiredParam(new URL(page.url()), 'publication');
  const publicationResponse = await authenticatedApiGet(
    page,
    `${apiOrigin}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/publications/${publicationId}`,
  );
  expect(publicationResponse.ok()).toBe(true);
  const publicationDetail = PublicationDetailEnvelopeSchema.parse(
    await publicationResponse.json(),
  ).data;
  const publication = publicationDetail.publication;
  expect(publication).toMatchObject({
    id: publicationId,
    status: 'PUBLISHED',
    artifactRevisionId: artifact.revision.id,
    artifactContentHash: artifact.revision.contentHash,
  });
  const appliedAttempt = publicationDetail.attempts
    .filter(
      (attempt) =>
        attempt.outcome === 'APPLIED' &&
        attempt.finishedAt !== null &&
        attempt.remoteRef === publication.remoteRef,
    )
    .sort((left, right) =>
      (left.finishedAt ?? '') < (right.finishedAt ?? '')
        ? -1
        : (left.finishedAt ?? '') > (right.finishedAt ?? '')
          ? 1
          : left.attemptNumber - right.attemptNumber,
    )[0];
  if (appliedAttempt === undefined || appliedAttempt.finishedAt === null) {
    throw new Error('EXPERIMENT_APPLIED_ATTEMPT_MISSING');
  }

  await page.goto(promptUrl);
  await page.getByRole('button', { name: '启动 Measurement remeasurement' }).click();
  await expect(page).toHaveURL(/\/app\/measurement\?/u, { timeout: 20_000 });
  await expect(page.getByTestId('measurement-run-status')).toHaveText('COMPLETED', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('measurement-run-progress')).toHaveText('60 / 60 PromptRuns');
  const remeasurementRunId = requiredParam(new URL(page.url()), 'run');
  expect(remeasurementRunId).not.toBe(baselineRunId);
  const remeasurementResponse = await authenticatedApiGet(
    page,
    `${apiOrigin}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/measurement-runs/${remeasurementRunId}`,
  );
  expect(remeasurementResponse.ok()).toBe(true);
  const remeasurementRun = MeasurementRunEnvelopeSchema.parse(await remeasurementResponse.json())
    .data.measurementRun;
  expect(remeasurementRun.kind).toBe('REMEASUREMENT');
  expect(remeasurementRun.startedAt).not.toBeNull();
  expect(remeasurementRun.completedAt).not.toBeNull();

  await page.goto(`/app?tenant=${tenantId}&workspace=${workspaceId}`);
  const experimentNavigation = page.getByRole('link', { name: 'Experiment Comparison' });
  await expect(experimentNavigation).toHaveAttribute(
    'href',
    `/app/experiments?tenant=${tenantId}&workspace=${workspaceId}`,
  );
  await experimentNavigation.click();
  await expect(
    page.getByRole('heading', { name: 'Experiment Comparison' }),
    'expected Experiment route instead of the Next.js not-found page',
  ).toBeVisible();
  const compatibleInputs = page.getByLabel('Compatible Experiment inputs');
  const compatibleOption = compatibleInputs
    .locator('option')
    .filter({ hasText: baselineRunId })
    .filter({ hasText: publicationId })
    .filter({ hasText: remeasurementRunId });
  await expect(
    compatibleOption,
    'expected one exact server-approved baseline/intervention/remeasurement tuple',
  ).toHaveCount(1);
  const approvedCombinationOption = compatibleInputs
    .locator('option')
    .filter({ hasText: baselineRunId })
    .filter({ hasText: `Approval ${approvedReview.id}` })
    .filter({ hasText: remeasurementRunId });
  await expect(
    approvedCombinationOption,
    'expected an exact approved Artifact event tuple without claiming external application',
  ).toHaveCount(1);
  const combinationValue = await compatibleOption.getAttribute('value');
  if (combinationValue === null) throw new Error('EXPERIMENT_COMBINATION_OPTION_MISSING');
  await compatibleInputs.selectOption(combinationValue);
  await page.getByRole('button', { name: '创建 Experiment comparison' }).click();

  await expect(
    page.getByText('Experiment 已按 exact snapshots 与 intervention 封存。'),
  ).toBeVisible();
  const experimentUrl = page.url();
  const report = page.getByTestId('experiment-report');
  await expect(report).toBeVisible();
  await expect(report.getByText(/^COMPARABLE · immutable snapshot report$/u)).toBeVisible();
  await expect(report.getByTestId('experiment-scenario-version')).toHaveText('Scenario version：1');

  const measurementContext = report.getByTestId('experiment-measurement-context');
  await expect(measurementContext).toContainText(`Provider：${baselineRun.providerKey}`);
  await expect(measurementContext).toContainText(`Surface：${baselineRun.surfaceKey}`);
  await expect(measurementContext).toContainText(
    `Model：${baselineRun.model} / ${baselineRun.modelVersion}`,
  );
  const baselineTimeline = measurementContext.getByTestId('experiment-baseline-timeline');
  await expect(baselineTimeline).toContainText(`Run started：${baselineRun.startedAt}`);
  await expect(baselineTimeline).toContainText(`Run completed：${baselineRun.completedAt}`);
  await expect(baselineTimeline.getByText(/^Evidence window：.+ → .+$/u)).toBeVisible();
  const remeasurementTimeline = measurementContext.getByTestId('experiment-remeasurement-timeline');
  await expect(remeasurementTimeline).toContainText(`Run started：${remeasurementRun.startedAt}`);
  await expect(remeasurementTimeline).toContainText(
    `Run completed：${remeasurementRun.completedAt}`,
  );
  await expect(remeasurementTimeline.getByText(/^Evidence window：.+ → .+$/u)).toBeVisible();

  const intervention = report.getByTestId('experiment-intervention');
  await expect(intervention).toContainText('State：PUBLISHED');
  await expect(intervention).toContainText(`Artifact revision：${artifact.revision.id}`);
  await expect(intervention).toContainText(`Artifact hash：${artifact.revision.contentHash}`);
  await expect(intervention).toContainText(`Publication：${publicationId}`);
  await expect(intervention).toContainText(`Applied attempt：${appliedAttempt.id}`);
  await expect(intervention).toContainText(`Approval review：${publishedReview.id}`);
  await expect(intervention).toContainText(`Event recorded at：${appliedAttempt.finishedAt}`);

  const metricCards = report.getByTestId('experiment-metric');
  await expect(metricCards).toHaveCount(4);
  expect((await metricCards.locator('h3').allTextContents()).sort()).toEqual(
    ['ACCURACY_RATE', 'CITATION_RATE', 'COVERAGE_RATE', 'MENTION_RATE'].sort(),
  );
  for (let index = 0; index < 4; index += 1) {
    const card = metricCards.nth(index);
    await expect(card.getByText(/^Scope：.+$/u)).toBeVisible();
    await expect(card.getByText(/^Compatibility：[a-f0-9]{64}$/u)).toBeVisible();
    await expect(
      card.getByText(/^Descriptive delta：(NOT_COMPUTABLE|-?\d+\.\d{6})$/u),
    ).toBeVisible();
    await expect(card.getByText('Sample：baseline 60 / remeasurement 60')).toBeVisible();
    await expect(card.getByText(/^Eligible denominator：\d+ → \d+$/u)).toBeVisible();
    await expect(card.getByText(/^Excluded baseline：ERROR \d+ · NOT_CHECKED /u)).toBeVisible();
    await expect(
      card.getByText(/^Excluded remeasurement：ERROR \d+ · NOT_CHECKED /u),
    ).toBeVisible();
    await expect(card.getByText(/^Cost baseline：.+（未换汇）$/u)).toBeVisible();
    await expect(card.getByText(/^Cost remeasurement：.+（未换汇）$/u)).toBeVisible();
  }

  await expect(
    report.getByText(/observed association.*does not establish causation/iu).first(),
  ).toBeVisible();
  await expect(
    report
      .getByText(
        /sample size.*excluded outcomes.*Provider behavior.*timing.*external changes.*uncertainty.*descriptive delta/iu,
      )
      .first(),
  ).toBeVisible();
  await expect(
    report
      .getByText(/does not guarantee.*ranking.*citation.*recommendation.*future performance/iu)
      .first(),
  ).toBeVisible();
  await expect(
    page.getByText(
      '本报告不证明 intervention 导致任何变化，也不保证排名、引用、推荐、流量或业务结果。',
    ),
  ).toBeVisible();

  const baselineDrillDown = report.getByRole('link', { name: '查看 baseline raw evidence' });
  const remeasurementDrillDown = report.getByRole('link', {
    name: '查看 remeasurement raw evidence',
  });
  const interventionDrillDown = report.getByRole('link', {
    name: '查看 exact published intervention',
  });
  const baselineHref = await baselineDrillDown.getAttribute('href');
  const remeasurementHref = await remeasurementDrillDown.getAttribute('href');
  const interventionHref = await interventionDrillDown.getAttribute('href');
  if (baselineHref === null || remeasurementHref === null || interventionHref === null) {
    throw new Error('EXPERIMENT_DRILL_DOWN_MISSING');
  }
  expect(requiredParam(new URL(baselineHref, page.url()), 'run')).toBe(baselineRunId);
  expect(requiredParam(new URL(remeasurementHref, page.url()), 'run')).toBe(remeasurementRunId);
  expect(requiredParam(new URL(interventionHref, page.url()), 'publication')).toBe(publicationId);

  await page.goto(baselineHref);
  await expect(page.getByText(`Run ID：${baselineRunId}`)).toBeVisible();
  await expect(page.getByTestId('measurement-run-status')).toHaveText('COMPLETED');
  await page.goto(experimentUrl);
  await page.goto(remeasurementHref);
  await expect(page.getByText(`Run ID：${remeasurementRunId}`)).toBeVisible();
  await expect(page.getByTestId('measurement-run-status')).toHaveText('COMPLETED');
  await page.goto(experimentUrl);
  await page.goto(interventionHref);
  await expect(page.getByTestId('publication-status')).toHaveText('PUBLISHED');

  await page.goto(`/app/experiments?tenant=${tenantId}&workspace=${workspaceId}`);
  const approvedInputs = page.getByLabel('Compatible Experiment inputs');
  const approvedOption = approvedInputs
    .locator('option')
    .filter({ hasText: baselineRunId })
    .filter({ hasText: `Approval ${approvedReview.id}` })
    .filter({ hasText: remeasurementRunId });
  const approvedValue = await approvedOption.getAttribute('value');
  if (approvedValue === null) throw new Error('EXPERIMENT_APPROVED_COMBINATION_MISSING');
  await approvedInputs.selectOption(approvedValue);
  await page.getByRole('button', { name: '创建 Experiment comparison' }).click();

  const approvedReport = page.getByTestId('experiment-report');
  const approvedIntervention = approvedReport.getByTestId('experiment-intervention');
  await expect(
    approvedIntervention.getByRole('heading', { name: 'Exact approved Artifact event' }),
  ).toBeVisible();
  await expect(approvedIntervention).toContainText('State：APPROVED_NOT_PUBLISHED');
  await expect(approvedIntervention).toContainText(`Approval review：${approvedReview.id}`);
  await expect(approvedIntervention).toContainText(
    'Approval is a recorded review event, not proof of external application or causation.',
  );
  await expect(
    approvedReport.getByText(
      /observed association across a recorded approval event.*does not prove external application or causation/iu,
    ),
  ).toBeVisible();
  const approvedDrillDown = approvedIntervention.getByRole('link', {
    name: '查看 exact approved Artifact',
  });
  const approvedHref = await approvedDrillDown.getAttribute('href');
  if (approvedHref === null) throw new Error('EXPERIMENT_APPROVED_DRILL_DOWN_MISSING');
  expect(requiredParam(new URL(approvedHref, page.url()), 'artifact')).toBe(approvedArtifactId);
  await page.goto(approvedHref);
  await expect(page.getByText('Current approval：ELIGIBLE')).toBeVisible();
});
