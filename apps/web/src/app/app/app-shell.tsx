'use client';

import type { WorkspaceListEnvelope } from '@aeostudio/contracts';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';

type WorkspaceEntry = WorkspaceListEnvelope['data']['workspaces'][number];
type Role = WorkspaceEntry['activeRole'];

interface NavItem {
  path: string;
  label: string;
  roles?: readonly Role[];
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    title: '概览',
    items: [{ path: '/app', label: '工作台' }],
  },
  {
    title: '知识建设',
    items: [
      {
        path: '/app/onboarding',
        label: '业务资料 Onboarding',
        roles: ['OWNER', 'ADMIN', 'EDITOR'],
      },
    ],
  },
  {
    title: '证据与内容',
    items: [
      {
        path: '/app/claims',
        label: 'Evidence / Claims',
        roles: ['OWNER', 'ADMIN', 'EDITOR', 'REVIEWER'],
      },
      {
        path: '/app/prompts',
        label: 'Prompt / Scenario Lab',
        roles: ['OWNER', 'ADMIN', 'EDITOR', 'REVIEWER', 'ANALYST'],
      },
      {
        path: '/app/plans',
        label: 'Content Plan / Briefs',
        roles: ['OWNER', 'ADMIN', 'EDITOR', 'REVIEWER'],
      },
    ],
  },
  {
    title: '发布与实验',
    items: [
      { path: '/app/artifacts', label: 'Artifact Studio' },
      { path: '/app/channels', label: 'Channel Packages' },
      { path: '/app/experiments', label: 'Experiment Comparison' },
    ],
  },
  {
    title: '治理',
    items: [{ path: '/app/privacy', label: 'Privacy & Audit', roles: ['OWNER'] }],
  },
];

function visibleGroups(role: Role | undefined): NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) => item.roles === undefined || (role !== undefined && item.roles.includes(role)),
    ),
  })).filter((group) => group.items.length > 0);
}

export function AppShell({
  workspaces,
  children,
}: {
  workspaces: WorkspaceEntry[];
  children: ReactNode;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const tenantParam = searchParams.get('tenant');
  const workspaceParam = searchParams.get('workspace');
  const current =
    workspaces.find(
      (entry) => entry.tenant.id === tenantParam && entry.workspace.id === workspaceParam,
    ) ?? workspaces[0];
  const contextQuery =
    current === undefined ? '' : `?tenant=${current.tenant.id}&workspace=${current.workspace.id}`;
  const groups = visibleGroups(current?.activeRole);

  return (
    <div className="app-shell">
      <aside className="app-sidebar" aria-label="主导航">
        <div className="sidebar-header">
          <p className="sidebar-brand">AEO Studio</p>
          {current === undefined ? (
            <p className="sidebar-workspace">尚未加入 Workspace</p>
          ) : (
            <>
              <p className="sidebar-workspace">{current.workspace.name}</p>
              <p className="sidebar-role">{current.activeRole}</p>
            </>
          )}
        </div>
        {workspaces.length > 1 && current !== undefined ? (
          <div className="sidebar-switcher">
            <label htmlFor="sidebar-workspace-switcher">切换 Workspace</label>
            <select
              id="sidebar-workspace-switcher"
              onChange={(event) => {
                const selected = workspaces.find(
                  (entry) => `${entry.tenant.id}:${entry.workspace.id}` === event.target.value,
                );
                if (selected !== undefined) {
                  router.push(
                    `/app?tenant=${selected.tenant.id}&workspace=${selected.workspace.id}`,
                  );
                }
              }}
              value={`${current.tenant.id}:${current.workspace.id}`}
            >
              {workspaces.map((entry) => (
                <option
                  key={`${entry.tenant.id}:${entry.workspace.id}`}
                  value={`${entry.tenant.id}:${entry.workspace.id}`}
                >
                  {entry.tenant.name} / {entry.workspace.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <nav className="sidebar-nav" aria-label="功能模块">
          {groups.map((group) => (
            <div className="sidebar-group" key={group.title}>
              <p className="sidebar-group-title">{group.title}</p>
              <ul>
                {group.items.map((item) => {
                  const active = pathname === item.path;
                  return (
                    <li key={item.path}>
                      <a
                        aria-current={active ? 'page' : undefined}
                        className={active ? 'sidebar-link active' : 'sidebar-link'}
                        href={`${item.path}${contextQuery}`}
                      >
                        {item.label}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      </aside>
      <div className="app-content">{children}</div>
    </div>
  );
}
