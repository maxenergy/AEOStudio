'use client';

import type { WorkspaceListEnvelope } from '@aeostudio/contracts';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';

import { makeT } from '../../lib/i18n';
import type { Locale, MessageKey } from '../../lib/i18n';

type WorkspaceEntry = WorkspaceListEnvelope['data']['workspaces'][number];
type Role = WorkspaceEntry['activeRole'];

interface NavItem {
  path: string;
  labelKey: MessageKey;
  roles?: readonly Role[];
}

interface NavGroup {
  titleKey: MessageKey;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    titleKey: 'navGroup.overview',
    items: [{ path: '/app', labelKey: 'nav.workbench' }],
  },
  {
    titleKey: 'navGroup.knowledge',
    items: [
      {
        path: '/app/onboarding',
        labelKey: 'nav.onboarding',
        roles: ['OWNER', 'ADMIN', 'EDITOR'],
      },
    ],
  },
  {
    titleKey: 'navGroup.evidence',
    items: [
      {
        path: '/app/claims',
        labelKey: 'nav.claims',
        roles: ['OWNER', 'ADMIN', 'EDITOR', 'REVIEWER'],
      },
      {
        path: '/app/prompts',
        labelKey: 'nav.prompts',
        roles: ['OWNER', 'ADMIN', 'EDITOR', 'REVIEWER', 'ANALYST'],
      },
      {
        path: '/app/plans',
        labelKey: 'nav.plans',
        roles: ['OWNER', 'ADMIN', 'EDITOR', 'REVIEWER'],
      },
    ],
  },
  {
    titleKey: 'navGroup.publish',
    items: [
      { path: '/app/artifacts', labelKey: 'nav.artifacts' },
      { path: '/app/channels', labelKey: 'nav.channels' },
      { path: '/app/experiments', labelKey: 'nav.experiments' },
    ],
  },
  {
    titleKey: 'navGroup.governance',
    items: [{ path: '/app/privacy', labelKey: 'nav.privacy', roles: ['OWNER'] }],
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
  locale,
  children,
}: {
  workspaces: WorkspaceEntry[];
  locale: Locale;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const t = makeT(locale);
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
      <aside className="app-sidebar" aria-label={t('sidebar.navPrimary')}>
        <div className="sidebar-header">
          <p className="sidebar-brand">{t('sidebar.brand')}</p>
          {current === undefined ? (
            <p className="sidebar-workspace">{t('sidebar.noWorkspace')}</p>
          ) : (
            <>
              <p className="sidebar-workspace">{current.workspace.name}</p>
              <p className="sidebar-role">{current.activeRole}</p>
            </>
          )}
        </div>
        {workspaces.length > 1 && current !== undefined ? (
          <div className="sidebar-switcher">
            <label htmlFor="sidebar-workspace-switcher">{t('sidebar.switchWorkspace')}</label>
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
        <nav className="sidebar-nav" aria-label={t('sidebar.navModules')}>
          {groups.map((group) => (
            <div className="sidebar-group" key={group.titleKey}>
              <p className="sidebar-group-title">{t(group.titleKey)}</p>
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
                        {t(item.labelKey)}
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
