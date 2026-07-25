import type { WorkspaceListEnvelope } from '@aeostudio/contracts';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import type { ReactNode } from 'react';

import { makeT } from '../../lib/i18n';
import { getLocale } from '../../lib/i18n/get-locale';
import { AppShell } from './app-shell';

function apiOrigin(): string {
  return process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:3200';
}

export default async function AppLayout({ children }: Readonly<{ children: ReactNode }>) {
  const locale = await getLocale();
  const t = makeT(locale);
  const cookieHeader = (await cookies()).toString();
  const sessionResponse = await fetch(`${apiOrigin()}/api/v1/auth/session`, {
    cache: 'no-store',
    headers: { cookie: cookieHeader },
  });
  if (!sessionResponse.ok) {
    redirect('/login');
  }
  const workspaceResponse = await fetch(`${apiOrigin()}/api/v1/tenants`, {
    cache: 'no-store',
    headers: { cookie: cookieHeader },
  });
  const workspaceList = workspaceResponse.ok
    ? ((await workspaceResponse.json()) as WorkspaceListEnvelope)
    : undefined;

  return (
    <Suspense fallback={<div className="app-shell-loading">{t('common.loading')}</div>}>
      <AppShell workspaces={workspaceList?.data.workspaces ?? []} locale={locale}>
        {children}
      </AppShell>
    </Suspense>
  );
}
