import { expect, test, type Locator } from '@playwright/test';

async function linkUrl(link: Locator): Promise<URL> {
  const href = await link.getAttribute('href');
  if (href === null) throw new Error('EXPECTED_LINK_HREF');
  return new URL(href, 'http://aeostudio.test');
}

function requiredParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null || value.length === 0) throw new Error(`EXPECTED_${name.toUpperCase()}`);
  return value;
}

function expectExactLink(url: URL, pathname: string, query: Record<string, string>): void {
  expect(url.pathname).toBe(pathname);
  expect(Object.fromEntries(url.searchParams.entries())).toEqual(query);
}

test('an Owner reviews exact R1 and a one-character R2 makes that approval stale', async ({
  page,
}) => {
  test.setTimeout(60_000);

  await page.goto('/login');
  await page.getByRole('link', { name: '安全登录' }).click();
  await page.getByLabel('Tenant 名称').fill('Artifact Studio Cooperative');
  await page.getByLabel('Workspace 名称').fill('Artifact Workspace');
  await page.getByRole('button', { name: '创建 Workspace' }).click();

  await page.getByRole('link', { name: 'Artifact Studio' }).click();
  await expect(page.getByRole('heading', { name: 'Artifact Studio' })).toBeVisible();
  await page.getByRole('button', { name: '保存 Artifact 预算' }).click();
  await page.getByRole('button', { name: '生成 Artifact Draft' }).click();

  await expect(page.getByTestId('artifact-job-status')).toHaveText('SUCCEEDED', {
    timeout: 15_000,
  });
  await expect(
    page.getByRole('heading', { name: /Preview · Definition and offering/ }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Lineage / Claim map' })).toBeVisible();
  await expect(page.getByText(/Artifact .* · revision 1/)).toBeVisible();
  await expect(page.getByText(/^Content hash：[a-f0-9]{64}$/)).toBeVisible();
  await expect(page.getByText('Schema / method：1.0.0 / artifact-fixture-v1')).toBeVisible();
  const artifactUrl = new URL(page.url());
  const tenantId = requiredParam(artifactUrl, 'tenant');
  const workspaceId = requiredParam(artifactUrl, 'workspace');
  const approvedBriefLink = page.getByRole('link', { name: /^查看 approved Brief / });
  const approvedBriefText = await approvedBriefLink.innerText();
  const briefId = approvedBriefText.replace('查看 approved Brief ', '');
  const approvedBriefUrl = await linkUrl(approvedBriefLink);
  expectExactLink(approvedBriefUrl, '/app/plans', {
    tenant: tenantId,
    workspace: workspaceId,
    plan: requiredParam(approvedBriefUrl, 'plan'),
    brief: briefId,
  });
  expect(approvedBriefUrl.hash).toBe(`#brief-${briefId}`);
  await approvedBriefLink.click();
  await expect(page.getByRole('heading', { name: 'Content Plan / Briefs' })).toBeVisible();
  await expect(page.getByText(`Selected exact Brief ID：${briefId}`)).toBeVisible();
  const selectedBriefCard = page.locator(`#brief-${briefId}`);
  await expect(selectedBriefCard).toHaveAttribute('aria-current', 'true');
  await expect(selectedBriefCard).toHaveCSS('outline-style', 'solid');
  await expect(selectedBriefCard).toBeInViewport();
  const selectedPromptRefs = await selectedBriefCard.getByText(/^Prompt refs：/).innerText();
  expect(selectedPromptRefs.replace('Prompt refs：', '').split(', ')).toHaveLength(20);
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Artifact Studio' })).toBeVisible();
  const approvedPromptLink = page.getByRole('link', { name: /^查看 approved Prompt revision / });
  const approvedPromptText = await approvedPromptLink.innerText();
  const promptRevisionId = approvedPromptText.replace('查看 approved Prompt revision ', '');
  const approvedPromptUrl = await linkUrl(approvedPromptLink);
  expectExactLink(approvedPromptUrl, '/app/prompts', {
    tenant: tenantId,
    workspace: workspaceId,
    promptSet: requiredParam(approvedPromptUrl, 'promptSet'),
    promptRevision: promptRevisionId,
  });
  await page.goto(`${approvedPromptUrl.pathname}${approvedPromptUrl.search}`);
  await expect(page.getByText(`Exact Prompt revision ID：${promptRevisionId}`)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Prompt revision 1' })).toBeVisible();
  await expect(page.getByText('Approved artifact lineage prompt fixture')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Artifact Studio' })).toBeVisible();

  await page.getByText('Resolved source Artifacts').click();
  const sourceLinks = page.locator('details li a');
  await expect(sourceLinks).toHaveCount(4);
  await expect(sourceLinks.filter({ hasText: 'PROFILE_REVISION' })).toHaveAttribute(
    'href',
    /^\/app\/onboarding\?.*profile=/,
  );
  await expect(sourceLinks.filter({ hasText: 'OFFERING_REVISION' })).toHaveAttribute(
    'href',
    /^\/app\/onboarding\?.*profile=.*&offering=.*&revision=/,
  );
  const promptSourceLink = sourceLinks.filter({ hasText: 'PROMPT_REVISION' });
  const promptSourceText = await promptSourceLink.locator('..').innerText();
  const promptSourceMatch = /PROMPT_REVISION · ([^ ]+) · hash /.exec(promptSourceText);
  if (promptSourceMatch?.[1] === undefined) throw new Error('EXPECTED_PROMPT_SOURCE_ID');
  const promptSourceUrl = await linkUrl(promptSourceLink);
  expectExactLink(promptSourceUrl, '/app/prompts', {
    tenant: tenantId,
    workspace: workspaceId,
    promptSet: requiredParam(promptSourceUrl, 'promptSet'),
    promptRevision: promptSourceMatch[1],
  });
  await expect(sourceLinks.filter({ hasText: 'SITE_BASELINE' })).toHaveAttribute(
    'href',
    /^\/app\/sites\?.*profile=.*&site=/,
  );
  await expect(page.getByRole('heading', { name: /^Claim revision / })).toBeVisible();
  const claimLink = page.getByRole('link', { name: /^Claim revision / });
  const claimRevisionId = (await claimLink.innerText()).replace('Claim revision ', '');
  const claimUrl = await linkUrl(claimLink);
  const claimId = requiredParam(claimUrl, 'claim');
  expectExactLink(claimUrl, '/app/claims', {
    tenant: tenantId,
    workspace: workspaceId,
    claim: claimId,
    claimRevision: claimRevisionId,
  });
  const evidenceLinks = page.getByRole('link', {
    name: /^Evidence .* \/ .* \/ [a-f0-9]{64}$/,
  });
  await expect(evidenceLinks).not.toHaveCount(0);
  const evidenceDrillDowns: Array<{ sourceId: string; snapshotId: string; url: URL }> = [];
  for (let index = 0; index < (await evidenceLinks.count()); index += 1) {
    const evidenceLink = evidenceLinks.nth(index);
    const evidenceMatch = /^Evidence ([^ ]+) \/ ([^ ]+) \/ [a-f0-9]{64}$/.exec(
      await evidenceLink.innerText(),
    );
    if (evidenceMatch?.[1] === undefined || evidenceMatch[2] === undefined) {
      throw new Error('EXPECTED_EVIDENCE_SOURCE_AND_SNAPSHOT');
    }
    const evidenceUrl = await linkUrl(evidenceLink);
    expectExactLink(evidenceUrl, '/app/claims', {
      tenant: tenantId,
      workspace: workspaceId,
      claim: claimId,
      claimRevision: claimRevisionId,
      source: evidenceMatch[1],
      snapshot: evidenceMatch[2],
    });
    evidenceDrillDowns.push({
      sourceId: evidenceMatch[1],
      snapshotId: evidenceMatch[2],
      url: evidenceUrl,
    });
  }

  await page.goto(`${claimUrl.pathname}${claimUrl.search}`);
  await expect(page.getByText(`Exact Claim revision ID：${claimRevisionId}`)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Claim revision 1' })).toBeVisible();
  await expect(
    page.getByText('The approved fixture claim is traceable to current evidence.'),
  ).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Artifact Studio' })).toBeVisible();

  const evidenceDrillDown = evidenceDrillDowns[0];
  if (evidenceDrillDown === undefined) throw new Error('EXPECTED_EVIDENCE_DRILL_DOWN');
  await page.goto(`${evidenceDrillDown.url.pathname}${evidenceDrillDown.url.search}`);
  await expect(page.getByText(`Exact Claim revision ID：${claimRevisionId}`)).toBeVisible();
  await expect(
    page.getByText(`Selected exact Evidence Source：${evidenceDrillDown.sourceId}`),
  ).toBeVisible();
  await expect(
    page.getByText(`Selected exact Evidence Snapshot：${evidenceDrillDown.snapshotId}`),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Exact Evidence drill-down' })).toBeVisible();
  await expect(page.getByText('Artifact lineage evidence fixture')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Artifact Studio' })).toBeVisible();

  await expect(page.getByText('Current approval：APPROVAL_REQUIRED')).toBeVisible();

  await page.getByRole('button', { name: '提交 exact revision/hash 审核' }).click();
  const submittedUrl = new URL(page.url());
  const artifactJobId = requiredParam(submittedUrl, 'job');
  const artifactDeepLink = new URL(submittedUrl);
  artifactDeepLink.searchParams.delete('job');
  await page.goto(`${artifactDeepLink.pathname}${artifactDeepLink.search}`);
  expect(new URL(page.url()).searchParams.has('job')).toBe(false);
  await expect(page.getByRole('heading', { name: 'Exact-revision review' })).toBeVisible();
  await page.getByLabel('Review note').fill('Owner approves the exact Agent-generated R1/hash.');
  await page.getByRole('button', { name: '批准 exact revision/hash' }).click();

  await expect(page.getByText('Current approval：ELIGIBLE')).toBeVisible();
  expect(requiredParam(new URL(page.url()), 'job')).toBe(artifactJobId);
  await expect(page.getByRole('button', { name: '提交 exact revision/hash 审核' })).toHaveCount(0);
  const summary = page.getByLabel('Summary（保存会创建新 revision）');
  const r1Summary = await summary.inputValue();
  await summary.fill(`${r1Summary}X`);
  await page.getByRole('button', { name: '创建 immutable next revision' }).click();

  await expect(page.getByText(/Artifact .* · revision 2/)).toBeVisible();
  expect(requiredParam(new URL(page.url()), 'job')).toBe(artifactJobId);
  await expect(page.getByText('Current approval：APPROVAL_STALE')).toBeVisible();
  await expect(page.getByText(/^仍可选择的 approved revisions：R1$/)).toBeVisible();
  await expect(page.getByText(/^R1 [a-f0-9]{64} → R2 [a-f0-9]{64}$/)).toBeVisible();
  await expect(page.getByLabel('Summary（保存会创建新 revision）')).toHaveValue(`${r1Summary}X`);
  await expect(page.getByRole('button', { name: '提交 exact revision/hash 审核' })).toBeVisible();
});
