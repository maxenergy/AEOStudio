import type {
  CreateTenantEnvelope,
  MembershipEnvelope,
  SessionEnvelope,
  WorkspaceListEnvelope,
} from '@aeostudio/contracts';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { WorkspaceSwitcher } from './workspace-switcher';

const ROLE_LABELS = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  EDITOR: 'Editor',
  REVIEWER: 'Reviewer',
  PUBLISHER: 'Publisher',
  ANALYST: 'Analyst',
  VIEWER: 'Viewer',
} as const;

function apiOrigin(): string {
  return process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:3200';
}

function webOrigin(): string {
  return process.env.WEB_ORIGIN ?? 'http://127.0.0.1:3100';
}

async function createWorkspace(formData: FormData): Promise<never> {
  'use server';
  const tenantName = formData.get('tenantName');
  const workspaceName = formData.get('workspaceName');
  if (typeof tenantName !== 'string' || typeof workspaceName !== 'string') {
    redirect('/app?error=invalid-input');
  }
  const response = await fetch(`${apiOrigin()}/api/v1/tenants`, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'content-type': 'application/json',
      cookie: (await cookies()).toString(),
      origin: webOrigin(),
    },
    body: JSON.stringify({ tenantName, workspaceName }),
  });
  if (!response.ok) {
    redirect('/app?error=create-failed');
  }
  const created = (await response.json()) as CreateTenantEnvelope;
  redirect(
    `/app?tenant=${created.data.tenant.id}&workspace=${created.data.workspace.id}&notice=created`,
  );
}

async function inviteMember(formData: FormData): Promise<never> {
  'use server';
  const tenantId = formData.get('tenantId');
  const workspaceId = formData.get('workspaceId');
  const email = formData.get('email');
  const role = formData.get('role');
  if (
    typeof tenantId !== 'string' ||
    typeof workspaceId !== 'string' ||
    typeof email !== 'string' ||
    typeof role !== 'string'
  ) {
    redirect('/app?error=invalid-input');
  }
  const response = await fetch(
    `${apiOrigin()}/api/v1/tenants/${encodeURIComponent(tenantId)}/workspaces/${encodeURIComponent(workspaceId)}/invitations`,
    {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        cookie: (await cookies()).toString(),
        origin: webOrigin(),
      },
      body: JSON.stringify({ email, role }),
    },
  );
  if (!response.ok) {
    redirect(`/app?tenant=${tenantId}&workspace=${workspaceId}&error=invite-failed`);
  }
  const invited = (await response.json()) as MembershipEnvelope;
  const query = new URLSearchParams({
    tenant: tenantId,
    workspace: workspaceId,
    notice: 'invited',
    invitation: invited.data.membership.id,
    invitationEmail: invited.data.membership.email,
  });
  redirect(`/app?${query.toString()}`);
}

async function acceptMembership(formData: FormData): Promise<never> {
  'use server';
  const tenantId = formData.get('tenantId');
  const workspaceId = formData.get('workspaceId');
  const membershipId = formData.get('membershipId');
  if (
    typeof tenantId !== 'string' ||
    typeof workspaceId !== 'string' ||
    typeof membershipId !== 'string'
  ) {
    redirect('/app?error=invalid-invitation');
  }
  const response = await fetch(
    `${apiOrigin()}/api/v1/tenants/${encodeURIComponent(tenantId)}/workspaces/${encodeURIComponent(workspaceId)}/memberships/${encodeURIComponent(membershipId)}/accept`,
    {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        cookie: (await cookies()).toString(),
        origin: webOrigin(),
      },
      body: '{}',
    },
  );
  if (!response.ok) redirect('/app?error=invitation-accept-failed');
  redirect(`/app?tenant=${tenantId}&workspace=${workspaceId}&notice=accepted`);
}

interface ApplicationPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ApplicationPage({ searchParams }: ApplicationPageProps) {
  const cookieHeader = (await cookies()).toString();
  const sessionResponse = await fetch(`${apiOrigin()}/api/v1/auth/session`, {
    cache: 'no-store',
    headers: { cookie: cookieHeader },
  });
  if (!sessionResponse.ok) {
    redirect('/login');
  }
  const session = (await sessionResponse.json()) as SessionEnvelope;
  const workspaceResponse = await fetch(`${apiOrigin()}/api/v1/tenants`, {
    cache: 'no-store',
    headers: { cookie: cookieHeader },
  });
  if (!workspaceResponse.ok) {
    throw new Error('WORKSPACE_LIST_UNAVAILABLE');
  }
  const workspaceList = (await workspaceResponse.json()) as WorkspaceListEnvelope;
  const query = await searchParams;
  const tenantId = typeof query.tenant === 'string' ? query.tenant : undefined;
  const workspaceId = typeof query.workspace === 'string' ? query.workspace : undefined;
  const invitationId = typeof query.invitation === 'string' ? query.invitation : undefined;
  const invitationEmail =
    typeof query.invitationEmail === 'string' ? query.invitationEmail : undefined;
  const membershipToAccept =
    typeof query.acceptMembership === 'string' ? query.acceptMembership : undefined;
  const current =
    workspaceList.data.workspaces.find(
      (entry) => entry.tenant.id === tenantId && entry.workspace.id === workspaceId,
    ) ?? workspaceList.data.workspaces[0];

  return (
    <main>
      <p className="eyebrow">AEO Studio</p>
      <h1>AEO Studio 工作台</h1>
      <p>已安全登录：{session.data.email}</p>

      {tenantId !== undefined && workspaceId !== undefined && membershipToAccept !== undefined ? (
        <section aria-labelledby="accept-invitation-heading" className="shell-card">
          <h2 id="accept-invitation-heading">接受 Workspace 邀请</h2>
          <p>系统会校验当前登录邮箱与邀请记录；不匹配时不会泄露 Workspace 信息。</p>
          <form action={acceptMembership}>
            <input name="tenantId" type="hidden" value={tenantId} />
            <input name="workspaceId" type="hidden" value={workspaceId} />
            <input name="membershipId" type="hidden" value={membershipToAccept} />
            <button className="primary-action" type="submit">
              接受 Workspace 邀请
            </button>
          </form>
        </section>
      ) : null}

      {workspaceList.data.workspaces.length > 0 && current !== undefined ? (
        <WorkspaceSwitcher workspaces={workspaceList.data.workspaces} current={current} />
      ) : null}

      <section aria-labelledby="workspace-heading" className="shell-card">
        {current === undefined ? (
          <>
            <h2 id="workspace-heading">Workspace 尚未创建</h2>
            <p>先建立一个行业中立的 Tenant 与 Workspace，之后再录入你的业务资料。</p>
          </>
        ) : (
          <>
            <p className="eyebrow">{current.tenant.name}</p>
            <h2 id="workspace-heading">{current.workspace.name}</h2>
            <p>当前角色：{ROLE_LABELS[current.activeRole]}</p>
            {['OWNER', 'ADMIN', 'EDITOR'].includes(current.activeRole) ? (
              <>
                <a
                  className="secondary-action"
                  href={`/app/onboarding?tenant=${current.tenant.id}&workspace=${current.workspace.id}`}
                >
                  开始业务资料 Onboarding
                </a>
                <a
                  className="secondary-action"
                  href={`/app/claims?tenant=${current.tenant.id}&workspace=${current.workspace.id}`}
                >
                  Evidence / Claim Ledger
                </a>
              </>
            ) : null}
            {current.activeRole === 'REVIEWER' ? (
              <a
                className="secondary-action"
                href={`/app/claims?tenant=${current.tenant.id}&workspace=${current.workspace.id}`}
              >
                Evidence / Claim Ledger
              </a>
            ) : null}
            {['OWNER', 'ADMIN', 'EDITOR', 'REVIEWER', 'ANALYST'].includes(current.activeRole) ? (
              <a
                className="secondary-action"
                href={`/app/prompts?tenant=${current.tenant.id}&workspace=${current.workspace.id}`}
              >
                Prompt / Scenario Lab
              </a>
            ) : null}
            {['OWNER', 'ADMIN', 'EDITOR', 'REVIEWER'].includes(current.activeRole) ? (
              <a
                className="secondary-action"
                href={`/app/plans?tenant=${current.tenant.id}&workspace=${current.workspace.id}`}
              >
                Content Plan / Briefs
              </a>
            ) : null}
            {['OWNER', 'ADMIN', 'EDITOR', 'REVIEWER', 'PUBLISHER', 'VIEWER'].includes(
              current.activeRole,
            ) ? (
              <a
                className="secondary-action"
                href={`/app/artifacts?tenant=${current.tenant.id}&workspace=${current.workspace.id}`}
              >
                Artifact Studio
              </a>
            ) : null}
            <a
              className="secondary-action"
              href={`/app/channels?tenant=${current.tenant.id}&workspace=${current.workspace.id}`}
            >
              Channel Packages / Publications
            </a>
            <a
              className="secondary-action"
              href={`/app/experiments?tenant=${current.tenant.id}&workspace=${current.workspace.id}`}
            >
              Experiment Comparison
            </a>
            {current.activeRole === 'OWNER' ? (
              <a
                className="secondary-action"
                href={`/app/privacy?tenant=${current.tenant.id}&workspace=${current.workspace.id}`}
              >
                Privacy &amp; Audit
              </a>
            ) : null}
            {query.notice === 'invited' ? (
              <>
                <p className="success-message" role="status">
                  邀请已创建，等待对方接受。
                </p>
                {invitationId === undefined || invitationEmail === undefined ? null : (
                  <a
                    href={`/app?tenant=${current.tenant.id}&workspace=${current.workspace.id}&acceptMembership=${invitationId}`}
                  >
                    {invitationEmail} 接受邀请链接
                  </a>
                )}
              </>
            ) : null}
            {query.notice === 'accepted' ? (
              <p className="success-message" role="status">
                Workspace 邀请已接受。
              </p>
            ) : null}
            {current.activeRole === 'OWNER' ? (
              <form action={inviteMember} className="stacked-form">
                <h3>邀请成员</h3>
                <input name="tenantId" type="hidden" value={current.tenant.id} />
                <input name="workspaceId" type="hidden" value={current.workspace.id} />
                <label htmlFor="invite-email">受邀人邮箱</label>
                <input id="invite-email" name="email" required type="email" />
                <label htmlFor="invite-role">角色</label>
                <select defaultValue="EDITOR" id="invite-role" name="role">
                  <option value="ADMIN">Admin</option>
                  <option value="EDITOR">Editor</option>
                  <option value="REVIEWER">Reviewer</option>
                  <option value="PUBLISHER">Publisher</option>
                  <option value="ANALYST">Analyst</option>
                  <option value="VIEWER">Viewer</option>
                </select>
                <button className="primary-action" type="submit">
                  发送邀请
                </button>
              </form>
            ) : null}
          </>
        )}
      </section>

      <section aria-labelledby="create-workspace-heading" className="shell-card">
        <h2 id="create-workspace-heading">创建 Tenant 与 Workspace</h2>
        <form action={createWorkspace} className="stacked-form">
          <label htmlFor="tenant-name">Tenant 名称</label>
          <input id="tenant-name" maxLength={120} name="tenantName" required />
          <label htmlFor="workspace-name">Workspace 名称</label>
          <input id="workspace-name" maxLength={120} name="workspaceName" required />
          <button className="primary-action" type="submit">
            创建 Workspace
          </button>
        </form>
      </section>
    </main>
  );
}
