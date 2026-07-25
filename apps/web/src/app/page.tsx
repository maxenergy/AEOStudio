import { makeT } from '../lib/i18n';
import { getLocale } from '../lib/i18n/get-locale';

export default async function HomePage() {
  const t = makeT(await getLocale());
  return (
    <main>
      <h1>{t('home.title')}</h1>
      <p>{t('home.lede')}</p>
    </main>
  );
}
