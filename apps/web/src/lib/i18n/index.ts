import { en } from './locales/en';
import { zh } from './locales/zh';

/** 支持的界面语言。 */
export type Locale = 'zh' | 'en';

/** 默认语言（简体中文），保证既有中文 e2e 断言无需修改。 */
export const DEFAULT_LOCALE: Locale = 'zh';

/** 语言偏好 Cookie 名称。 */
export const LOCALE_COOKIE = 'aeo_locale';

/** 全部文案键（由 zh 字典推导，en 必须完全一致）。 */
export type MessageKey = keyof typeof zh;

const dictionaries: Record<Locale, Record<MessageKey, string>> = { zh, en };

export type TFunction = (key: MessageKey, vars?: Record<string, string | number>) => string;

/**
 * 生成指定语言的翻译函数。
 *
 * 支持 `{name}` 插值：`t('onboarding.completeness', { percent: 80 })`。
 * 本模块不依赖 next/headers，服务端与客户端组件均可安全导入；
 * 服务端读取 Cookie 请使用 ./get-locale 中的 getLocale()。
 */
export function makeT(locale: Locale): TFunction {
  const dictionary = dictionaries[locale];
  return (key, vars) => {
    let text: string = dictionary[key];
    if (vars !== undefined) {
      for (const [name, value] of Object.entries(vars)) {
        text = text.replaceAll(`{${name}}`, String(value));
      }
    }
    return text;
  };
}
