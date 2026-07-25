import { cookies } from 'next/headers';

import { DEFAULT_LOCALE, LOCALE_COOKIE } from './index';
import type { Locale } from './index';

/**
 * 服务端组件读取语言偏好 Cookie。
 *
 * 独立于 ./index 是因为 next/headers 为 server-only 模块，
 * 客户端组件（如 LocaleSwitcher）不能导入含它的入口。
 * 非 'en' 的取值一律回退默认中文。
 */
export async function getLocale(): Promise<Locale> {
  const value = (await cookies()).get(LOCALE_COOKIE)?.value;
  return value === 'en' ? 'en' : DEFAULT_LOCALE;
}
