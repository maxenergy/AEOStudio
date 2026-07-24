import type {
  ClaimCurrentStateEnvelope,
  ClaimEvidenceDrillDownEnvelope,
  ClaimEnvelope,
  EvidenceSnapshotEnvelope,
  EvidenceSourceEnvelope,
  WorkspaceListEnvelope,
} from '@aeostudio/contracts';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

function apiOrigin(): string {
  return process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:3200';
}

function webOrigin(): string {
  return process.env.WEB_ORIGIN ?? 'http://127.0.0.1:3100';
}

function requiredText(formData: FormData, name: string): string {
  const value = formData.get(name);
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`INVALID_${name.toUpperCase()}`);
  }
  return value.trim();
}

function optionalText(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function ledgerLocation(input: { tenantId: string; workspaceId: string; claimId?: string }) {
  const query = new URLSearchParams({ tenant: input.tenantId, workspace: input.workspaceId });
  if (input.claimId !== undefined) query.set('claim', input.claimId);
  return `/app/claims?${query.toString()}`;
}

async function createAndSubmitClaim(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const cookie = (await cookies()).toString();
  const headers = { 'content-type': 'application/json', cookie, origin: webOrigin() };
  const sourceResponse = await fetch(
    `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/evidence-sources`,
    {
      method: 'POST',
      cache: 'no-store',
      headers,
      body: JSON.stringify({
        sourceType: requiredText(formData, 'sourceType'),
        title: requiredText(formData, 'title'),
        uri: requiredText(formData, 'uri'),
        license: requiredText(formData, 'license'),
        publicity: requiredText(formData, 'publicity'),
      }),
    },
  );
  const base = ledgerLocation({ tenantId, workspaceId });
  if (!sourceResponse.ok) redirect(`${base}&error=source`);
  const source = ((await sourceResponse.json()) as EvidenceSourceEnvelope).data.source;

  // Read uploaded file and convert to base64 — server computes hash/objectRef
  const file = formData.get('evidenceFile');
  if (!(file instanceof File) || file.size === 0) {
    redirect(`${base}&error=file`);
  }
  const fileBuffer = Buffer.from(await file.arrayBuffer());
  const contentBase64 = fileBuffer.toString('base64');
  const contentType = file.type || 'application/octet-stream';

  const snapshotResponse = await fetch(
    `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/evidence-sources/${source.id}/snapshots`,
    {
      method: 'POST',
      cache: 'no-store',
      headers,
      body: JSON.stringify({
        contentBase64,
        contentType,
      }),
    },
  );
  if (!snapshotResponse.ok) redirect(`${base}&error=snapshot`);
  const snapshot = ((await snapshotResponse.json()) as EvidenceSnapshotEnvelope).data.snapshot;

  const numericText = optionalText(formData, 'numericValue');
  const unitText = optionalText(formData, 'unit');
  const expiryDate = requiredText(formData, 'expiresAt');
  const claimResponse = await fetch(
    `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/claims`,
    {
      method: 'POST',
      cache: 'no-store',
      headers,
      body: JSON.stringify({
        statement: requiredText(formData, 'statement'),
        numericValue: numericText.length === 0 ? null : Number(numericText),
        unit: unitText.length === 0 ? null : unitText,
        scope: requiredText(formData, 'scope'),
        conditions: requiredText(formData, 'conditions')
          .split(/\r?\n/)
          .map((value) => value.trim())
          .filter(Boolean),
        expiresAt: new Date(`${expiryDate}T00:00:00.000Z`).toISOString(),
        evidence: [
          {
            snapshotId: snapshot.id,
            snippet: requiredText(formData, 'snippet'),
          },
        ],
      }),
    },
  );
  if (!claimResponse.ok) redirect(`${base}&error=claim`);
  const claim = ((await claimResponse.json()) as ClaimEnvelope).data;
  const submitResponse = await fetch(
    `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/claims/${claim.claim.id}/revisions/${claim.revision.id}/submit`,
    { method: 'POST', cache: 'no-store', headers, body: '{}' },
  );
  if (!submitResponse.ok) redirect(`${base}&claim=${claim.claim.id}&error=submit`);
  redirect(
    `${ledgerLocation({ tenantId, workspaceId, claimId: claim.claim.id })}&notice=submitted`,
  );
}

async function reviewClaim(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const claimId = requiredText(formData, 'claimId');
  const revisionId = requiredText(formData, 'revisionId');
  const response = await fetch(
    `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/claims/${claimId}/revisions/${revisionId}/reviews`,
    {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        cookie: (await cookies()).toString(),
        origin: webOrigin(),
      },
      body: JSON.stringify({
        decision: requiredText(formData, 'decision'),
        note: requiredText(formData, 'note'),
      }),
    },
  );
  const base = ledgerLocation({ tenantId, workspaceId, claimId });
  redirect(`${base}&${response.ok ? 'notice=reviewed' : 'error=review'}`);
}

interface ClaimsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ClaimsPage({ searchParams }: ClaimsPageProps) {
  const query = await searchParams;
  const tenantId = typeof query.tenant === 'string' ? query.tenant : undefined;
  const workspaceId = typeof query.workspace === 'string' ? query.workspace : undefined;
  if (tenantId === undefined || workspaceId === undefined) redirect('/app');
  const cookie = (await cookies()).toString();
  const workspaceResponse = await fetch(`${apiOrigin()}/api/v1/tenants`, {
    cache: 'no-store',
    headers: { cookie },
  });
  if (!workspaceResponse.ok) redirect('/login');
  const workspaceList = (await workspaceResponse.json()) as WorkspaceListEnvelope;
  const membership = workspaceList.data.workspaces.find(
    (entry) => entry.tenant.id === tenantId && entry.workspace.id === workspaceId,
  );
  if (membership === undefined) redirect('/app');
  const claimId = typeof query.claim === 'string' ? query.claim : undefined;
  const claimRevisionId = typeof query.claimRevision === 'string' ? query.claimRevision : undefined;
  const selectedSourceId = typeof query.source === 'string' ? query.source : undefined;
  const selectedSnapshotId = typeof query.snapshot === 'string' ? query.snapshot : undefined;
  let current: ClaimEnvelope['data'] | undefined;
  let drillDown: ClaimEvidenceDrillDownEnvelope['data']['evidence'] = [];
  if (claimId !== undefined) {
    const claimPath =
      claimRevisionId === undefined
        ? `claims/${claimId}`
        : `claims/${claimId}/revisions/${claimRevisionId}`;
    const claimResponse = await fetch(
      `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/${claimPath}`,
      { cache: 'no-store', headers: { cookie } },
    );
    if (claimResponse.ok) {
      const responseBody = (await claimResponse.json()) as unknown;
      current =
        claimRevisionId === undefined
          ? (responseBody as ClaimCurrentStateEnvelope).data
          : (responseBody as ClaimEnvelope).data;
    }
    if (current !== undefined) {
      const evidenceResponse = await fetch(
        `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/claims/${claimId}/revisions/${current.revision.id}/evidence`,
        { cache: 'no-store', headers: { cookie } },
      );
      if (evidenceResponse.ok) {
        drillDown = ((await evidenceResponse.json()) as ClaimEvidenceDrillDownEnvelope).data
          .evidence;
      }
    }
  }
  const selectedEvidence =
    selectedSourceId === undefined && selectedSnapshotId === undefined
      ? undefined
      : drillDown.find(
          (entry) =>
            (selectedSourceId === undefined || entry.source.id === selectedSourceId) &&
            (selectedSnapshotId === undefined || entry.snapshot.id === selectedSnapshotId),
        );

  return (
    <main>
      <p className="eyebrow">AEO Studio</p>
      <h1>Evidence / Claim Ledger</h1>
      <p>
        公开 URL 只登记来源；只有 exact snapshot/hash/snippet、适用范围与 expiry
        齐全时才能提交独立审核。
      </p>

      {claimRevisionId !== undefined && current === undefined ? (
        <section className="shell-card">
          <h2>Exact Claim revision</h2>
          <p>Exact Claim revision ID：{claimRevisionId}</p>
          <p className="warning-message">该 exact Claim revision 当前不可读取。</p>
        </section>
      ) : null}

      {(selectedSourceId !== undefined || selectedSnapshotId !== undefined) &&
      current === undefined ? (
        <section className="shell-card">
          <h2>Selected exact Evidence</h2>
          {selectedSourceId === undefined ? null : (
            <p>Selected exact Evidence Source：{selectedSourceId}</p>
          )}
          {selectedSnapshotId === undefined ? null : (
            <p>Selected exact Evidence Snapshot：{selectedSnapshotId}</p>
          )}
          <p className="warning-message">该 exact Evidence 当前不可读取。</p>
        </section>
      ) : null}

      {current === undefined && ['OWNER', 'ADMIN', 'EDITOR'].includes(membership.activeRole) ? (
        <section className="shell-card">
          <h2>登记 Evidence 并提议 Claim</h2>
          <form action={createAndSubmitClaim} className="stacked-form">
            <input name="tenantId" type="hidden" value={tenantId} />
            <input name="workspaceId" type="hidden" value={workspaceId} />
            <label htmlFor="evidence-type">来源类型</label>
            <select defaultValue="UPLOAD" id="evidence-type" name="sourceType">
              <option value="UPLOAD">Upload</option>
              <option value="CRAWL">Verified crawl</option>
              <option value="PUBLIC">Public source</option>
            </select>
            <label htmlFor="evidence-title">Evidence 标题</label>
            <input id="evidence-title" name="title" required />
            <label htmlFor="evidence-uri">Evidence URI</label>
            <input id="evidence-uri" name="uri" required type="url" />
            <label htmlFor="evidence-license">License</label>
            <input id="evidence-license" name="license" required />
            <label htmlFor="evidence-publicity">Publicity</label>
            <select defaultValue="PUBLIC" id="evidence-publicity" name="publicity">
              <option value="PUBLIC">Public</option>
              <option value="PRIVATE">Private</option>
              <option value="RESTRICTED">Restricted</option>
            </select>
            <label htmlFor="evidence-file">Evidence 文件（服务端计算 SHA-256 和 objectRef）</label>
            <input
              accept=".txt,.md,.pdf,.csv,.png,.jpg,.jpeg,.webp,text/plain,text/markdown,application/pdf,text/csv,image/*"
              id="evidence-file"
              name="evidenceFile"
              required
              type="file"
            />
            <p className="field-help">
              支持文本、Markdown、PDF、CSV 和常见图片。上传后由服务端计算 hash 和 objectRef，浏览器不提交自称可信的
              hash。
            </p>
            <label htmlFor="claim-statement">Claim statement</label>
            <textarea id="claim-statement" name="statement" required />
            <label htmlFor="numeric-value">数值</label>
            <input id="numeric-value" name="numericValue" step="any" type="number" />
            <label htmlFor="claim-unit">单位</label>
            <input id="claim-unit" name="unit" />
            <label htmlFor="claim-scope">适用范围</label>
            <textarea id="claim-scope" name="scope" required />
            <label htmlFor="claim-conditions">适用条件</label>
            <textarea id="claim-conditions" name="conditions" required />
            <label htmlFor="claim-expiry">Expiry</label>
            <input id="claim-expiry" name="expiresAt" required type="date" />
            <label htmlFor="claim-snippet">Exact evidence snippet</label>
            <textarea id="claim-snippet" name="snippet" required />
            <button className="primary-action" type="submit">
              创建并提交独立审核
            </button>
          </form>
        </section>
      ) : null}

      {current === undefined ? null : (
        <>
          <section className="shell-card">
            <h2>Claim revision {current.revision.revision}</h2>
            <p>Exact Claim revision ID：{current.revision.id}</p>
            <p>{current.revision.statement}</p>
            <p>
              状态：<strong data-testid="claim-status">{current.revision.status}</strong>
            </p>
            <p>Content hash：{current.revision.contentHash}</p>
            <p>适用范围：{current.revision.scope}</p>
            <p>Expiry：{current.revision.expiresAt}</p>
            <p>创建者不可自批；必须由独立 Reviewer 审核 exact revision/hash。</p>
          </section>
          <section className="shell-card">
            <h2>Exact Evidence drill-down</h2>
            {selectedSourceId === undefined ? null : (
              <p>Selected exact Evidence Source：{selectedSourceId}</p>
            )}
            {selectedSnapshotId === undefined ? null : (
              <p>Selected exact Evidence Snapshot：{selectedSnapshotId}</p>
            )}
            {(selectedSourceId !== undefined || selectedSnapshotId !== undefined) &&
            selectedEvidence === undefined ? (
              <p className="warning-message">所选 exact Evidence 不属于该 Claim revision。</p>
            ) : null}
            {drillDown.map((entry) => {
              const isSelected =
                selectedEvidence !== undefined && entry.link.id === selectedEvidence.link.id;
              return (
                <article className={isSelected ? 'nested-card' : undefined} key={entry.link.id}>
                  {isSelected ? (
                    <p>
                      <strong>Selected exact Evidence</strong>
                    </p>
                  ) : null}
                  <h3>{entry.source.title}</h3>
                  <p>Evidence Source ID：{entry.source.id}</p>
                  <p>Evidence Snapshot ID：{entry.snapshot.id}</p>
                  <p>
                    License/Publicity：{entry.source.license} / {entry.source.publicity}
                  </p>
                  <p>Snapshot/source hash：{entry.snapshot.contentHash}</p>
                  <blockquote>{entry.link.snippet}</blockquote>
                  <p>Object ref：{entry.snapshot.objectRef}</p>
                </article>
              );
            })}
          </section>
          {membership.activeRole === 'REVIEWER' && current.revision.status === 'IN_REVIEW' ? (
            <section className="shell-card">
              <h2>独立审核</h2>
              <form action={reviewClaim} className="stacked-form">
                <input name="tenantId" type="hidden" value={tenantId} />
                <input name="workspaceId" type="hidden" value={workspaceId} />
                <input name="claimId" type="hidden" value={current.claim.id} />
                <input name="revisionId" type="hidden" value={current.revision.id} />
                <label htmlFor="review-note">审核备注</label>
                <textarea id="review-note" name="note" required />
                <button name="decision" type="submit" value="APPROVE">
                  批准 exact revision
                </button>
                <button name="decision" type="submit" value="REJECT">
                  拒绝
                </button>
              </form>
            </section>
          ) : null}
        </>
      )}
    </main>
  );
}
