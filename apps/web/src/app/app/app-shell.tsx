'use client';

import type { WorkspaceListEnvelope } from '@aeostudio/contracts';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, useState, useEffect } from 'react';

import { makeT } from '../../lib/i18n';
import type { Locale, MessageKey } from '../../lib/i18n';

type WorkspaceEntry = WorkspaceListEnvelope['data']['workspaces'][number];
type Role = WorkspaceEntry['activeRole'];
type UiMode = 'novice' | 'expert';

const UI_MODE_COOKIE = 'aeo_ui_mode';

function getInitialMode(): UiMode {
  if (typeof document === 'undefined') return 'expert';
  const match = document.cookie.match(new RegExp(`${UI_MODE_COOKIE}=([^;]+)`));
  return match?.[1] === 'novice' ? 'novice' : 'expert';
}

function setModeCookie(mode: UiMode): void {
  document.cookie = `${UI_MODE_COOKIE}=${mode};path=/;max-age=${365 * 24 * 60 * 60};samesite=lax`;
}

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

const WIZARD_NAV_GROUP: NavGroup = {
  titleKey: 'navGroup.wizard',
  items: [
    { path: '/app/start', labelKey: 'nav.wizard.start' },
    { path: '/app/company', labelKey: 'nav.wizard.company' },
    { path: '/app/products', labelKey: 'nav.wizard.products' },
    { path: '/app/audiences', labelKey: 'nav.wizard.audiences' },
    { path: '/app/evidence', labelKey: 'nav.wizard.evidence' },
    { path: '/app/strategy', labelKey: 'nav.wizard.strategy' },
    { path: '/app/channels-wizard', labelKey: 'nav.wizard.channels' },
    { path: '/app/content', labelKey: 'nav.wizard.content' },
  ],
};

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
  const [uiMode, setUiMode] = useState<UiMode>('expert');

  useEffect(() => {
    setUiMode(getInitialMode());
  }, []);

  const handleModeChange = (mode: UiMode) => {
    setUiMode(mode);
    setModeCookie(mode);
  };

  const tenantParam = searchParams.get('tenant');
  const workspaceParam = searchParams.get('workspace');
  const current =
    workspaces.find(
      (entry) => entry.tenant.id === tenantParam && entry.workspace.id === workspaceParam,
    ) ?? workspaces[0];
  const contextQuery =
    current === undefined ? '' : `?tenant=${current.tenant.id}&workspace=${current.workspace.id}`;

  const expertGroups = visibleGroups(current?.activeRole);
  const groups =
    uiMode === 'novice'
      ? [{ ...WIZARD_NAV_GROUP }, ...expertGroups.filter((g) => g.titleKey === 'navGroup.overview')]
      : expertGroups;

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
        <div className="sidebar-mode-switcher">
          <button
            type="button"
            className={uiMode === 'novice' ? 'mode-button active' : 'mode-button'}
            onClick={() => handleModeChange('novice')}
            aria-pressed={uiMode === 'novice'}
          >
            {t('navGroup.wizard')}
          </button>
          <button
            type="button"
            className={uiMode === 'expert' ? 'mode-button active' : 'mode-button'}
            onClick={() => handleModeChange('expert')}
            aria-pressed={uiMode === 'expert'}
          >
            {t('navGroup.governance')}
          </button>
        </div>
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
