import { TenantDeletionReceiptSchema } from '@aeostudio/contracts/privacy-audit';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { makeT } from '../../../lib/i18n';
import { getLocale } from '../../../lib/i18n/get-locale';

const DELETION_RECEIPT_COOKIE = '__Host-aeo_deletion_receipt';

function apiOrigin(): string {
  return process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:3200';
}

export default async function DeletionReceiptPage() {
  const t = makeT(await getLocale());
  const cookieStore = await cookies();
  const token = cookieStore.get(DELETION_RECEIPT_COOKIE)?.value;
  if (token === undefined) redirect('/login');
  const response = await fetch(`${apiOrigin()}/api/v1/privacy/deletion-receipts/current`, {
    cache: 'no-store',
    headers: { cookie: `${DELETION_RECEIPT_COOKIE}=${encodeURIComponent(token)}` },
  });
  if (!response.ok) redirect('/login');
  const payload = (await response.json().catch(() => null)) as {
    data?: { receipt?: unknown };
  } | null;
  const parsed = TenantDeletionReceiptSchema.safeParse(payload?.data?.receipt);
  if (!parsed.success) redirect('/login');

  return (
    <main>
      <p className="eyebrow">{t('deletionReceipt.eyebrow')}</p>
      <h1>{t('deletionReceipt.title')}</h1>
      <p>{t('deletionReceipt.lede')}</p>
      <section className="shell-card">
        <h2>{t('deletionReceipt.ackHeading')}</h2>
        <dl>
          <dt>{t('deletionReceipt.requestId')}</dt>
          <dd className="monospace break-anywhere">{parsed.data.id}</dd>
          <dt>{t('deletionReceipt.scope')}</dt>
          <dd>{parsed.data.scope}</dd>
          <dt>{t('deletionReceipt.requestedAt')}</dt>
          <dd>{parsed.data.requestedAt}</dd>
          <dt>{t('deletionReceipt.secretDeadline')}</dt>
          <dd data-testid="secret-delete-deadline">{parsed.data.secretForceDeleteBy}</dd>
          <dt>{t('deletionReceipt.activeDeadline')}</dt>
          <dd data-testid="active-delete-deadline">{parsed.data.activeDeleteBy}</dd>
          <dt>{t('deletionReceipt.backupDeadline')}</dt>
          <dd data-testid="backup-delete-deadline">{parsed.data.backupDeleteBy}</dd>
        </dl>
      </section>
      <a href="/login">{t('deletionReceipt.backToLogin')}</a>
    </main>
  );
}
