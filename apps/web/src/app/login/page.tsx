import { makeT } from '../../lib/i18n';
import { getLocale } from '../../lib/i18n/get-locale';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const apiOrigin = process.env.API_PUBLIC_ORIGIN ?? 'http://127.0.0.1:3200';
  const t = makeT(await getLocale());

  return (
    <main>
      <h1>{t('login.title')}</h1>
      <p>{t('login.lede')}</p>
      <a className="primary-action" href={`${apiOrigin}/api/v1/auth/login`}>
        {t('login.action')}
      </a>
    </main>
  );
}
