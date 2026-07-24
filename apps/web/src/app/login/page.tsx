export const dynamic = 'force-dynamic';

export default function LoginPage() {
  const apiOrigin = process.env.API_PUBLIC_ORIGIN ?? 'http://127.0.0.1:3200';

  return (
    <main>
      <h1>登录</h1>
      <p>使用企业身份提供商安全登录 AEO Studio。</p>
      <a className="primary-action" href={`${apiOrigin}/api/v1/auth/login`}>
        安全登录
      </a>
    </main>
  );
}
