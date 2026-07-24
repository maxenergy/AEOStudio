import { TenantDeletionReceiptSchema } from '@aeostudio/contracts/privacy-audit';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

const DELETION_RECEIPT_COOKIE = '__Host-aeo_deletion_receipt';

function apiOrigin(): string {
  return process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:3200';
}

export default async function DeletionReceiptPage() {
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
      <p className="eyebrow">Deletion lifecycle receipt</p>
      <h1>删除请求已冻结访问</h1>
      <p>
        当前业务 Session、Job 与 Connector 已进入立即撤销/冻结边界。此收据只陈述生命周期时限；具名
        Legal Hold 仍只作用于被批准的确切对象版本。
      </p>
      <section className="shell-card">
        <h2>Request acknowledgement</h2>
        <dl>
          <dt>Request ID</dt>
          <dd className="monospace break-anywhere">{parsed.data.id}</dd>
          <dt>Scope</dt>
          <dd>{parsed.data.scope}</dd>
          <dt>Requested at</dt>
          <dd>{parsed.data.requestedAt}</dd>
          <dt>Secret force-delete deadline（24 小时）</dt>
          <dd data-testid="secret-delete-deadline">{parsed.data.secretForceDeleteBy}</dd>
          <dt>Active data deadline（30 天）</dt>
          <dd data-testid="active-delete-deadline">{parsed.data.activeDeleteBy}</dd>
          <dt>Backup deadline（90 天）</dt>
          <dd data-testid="backup-delete-deadline">{parsed.data.backupDeleteBy}</dd>
        </dl>
      </section>
      <a href="/login">返回登录</a>
    </main>
  );
}
