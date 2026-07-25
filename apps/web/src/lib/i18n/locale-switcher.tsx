'use client';

import { useRouter } from 'next/navigation';

import { LOCALE_COOKIE, makeT } from './index';
import type { Locale } from './index';

/**
 * 全局语言切换器（由根布局渲染，固定于右上角，覆盖全部页面）。
 *
 * 切换时写入语言 Cookie，再调用 router.refresh() 重跑服务端组件，
 * 使整页按新语言重新渲染（不丢失页面状态）。
 */
export function LocaleSwitcher({ locale }: { locale: Locale }) {
  const router = useRouter();
  const t = makeT(locale);
  return (
    <label className="locale-switcher">
      <span className="locale-switcher-label">{t('locale.label')}</span>
      <select
        aria-label={t('locale.label')}
        defaultValue={locale}
        onChange={(event) => {
          document.cookie = `${LOCALE_COOKIE}=${event.target.value}; path=/; max-age=31536000; samesite=lax`;
          router.refresh();
        }}
      >
        <option value="zh">中文</option>
        <option value="en">English</option>
      </select>
    </label>
  );
}
