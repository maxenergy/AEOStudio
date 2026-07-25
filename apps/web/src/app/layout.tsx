import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { getLocale } from '../lib/i18n/get-locale';
import { LocaleSwitcher } from '../lib/i18n/locale-switcher';

import './globals.css';

export const metadata: Metadata = {
  title: 'AEO Studio',
  description: '多租户 AEO/GEO/SEO 优化平台',
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const locale = await getLocale();
  return (
    <html lang={locale === 'zh' ? 'zh-CN' : 'en'}>
      <body>
        <LocaleSwitcher locale={locale} />
        {children}
      </body>
    </html>
  );
}
