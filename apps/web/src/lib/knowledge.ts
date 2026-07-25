import { cookies } from 'next/headers';

/** API 内部地址（服务端组件直连 API，避免走公网）。 */
export function apiOrigin(): string {
  return process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:3200';
}

/** Web 自身来源（作为 origin 头发送，满足 API 的 CSRF 校验）。 */
export function webOrigin(): string {
  return process.env.WEB_ORIGIN ?? 'http://127.0.0.1:3100';
}

/** 读取必填文本字段，缺失时抛出异常以中断 server action。 */
export function requiredText(formData: FormData, name: string): string {
  const value = formData.get(name);
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`INVALID_${name.toUpperCase()}`);
  }
  return value.trim();
}

/** 读取可选文本字段，缺失时返回空字符串。 */
export function optionalText(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** 将多行文本解析为字符串数组（每行一项，自动去空白、去空行）。 */
export function textList(formData: FormData, name: string): string[] {
  const value = formData.get(name);
  if (typeof value !== 'string') return [];
  return value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** 将多选 checkbox / 多行文本解析为 ID 数组（支持逗号与换行分隔）。 */
export function idList(formData: FormData, name: string): string[] {
  return formData
    .getAll(name)
    .flatMap((entry) => (typeof entry === 'string' ? entry.split(/[\r\n,]+/) : []))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** 读取布尔 checkbox（未勾选时 FormData 中不存在该键）。 */
export function checkboxValue(formData: FormData, name: string): boolean {
  return formData.get(name) === 'on';
}

export interface WorkspaceEntry {
  tenant: { id: string; name: string };
  workspace: { id: string; name: string };
  activeRole: string;
}

/** 拉取当前会话可访问的全部 tenant/workspace。 */
export async function fetchWorkspaces(): Promise<WorkspaceEntry[]> {
  try {
    const response = await fetch(`${apiOrigin()}/api/v1/workspaces`, {
      cache: 'no-store',
      headers: { cookie: (await cookies()).toString() },
    });
    if (!response.ok) return [];
    const result = (await response.json()) as { data: { workspaces: WorkspaceEntry[] } };
    return result.data.workspaces;
  } catch {
    return [];
  }
}

/** 解析当前工作空间上下文；找不到时返回 null（由调用方 redirect）。 */
export function resolveWorkspace(
  workspaces: WorkspaceEntry[],
  params: { tenant?: string; workspace?: string },
): WorkspaceEntry | undefined {
  return (
    workspaces.find(
      (entry) => entry.tenant.id === params.tenant && entry.workspace.id === params.workspace,
    ) ?? workspaces[0]
  );
}

/** 通用知识列表拉取（GET，携带会话 Cookie）。失败时返回空数组。 */
export async function fetchKnowledgeList<T>(path: string, key: string): Promise<T[]> {
  try {
    const response = await fetch(path, {
      cache: 'no-store',
      headers: { cookie: (await cookies()).toString() },
    });
    if (!response.ok) return [];
    const result = (await response.json()) as { data: Record<string, T[]> };
    return result.data[key] ?? [];
  } catch {
    return [];
  }
}

/** 通用知识创建（POST，携带会话 Cookie 与 origin 头）。返回是否成功。 */
export async function postKnowledge(path: string, body: unknown): Promise<boolean> {
  try {
    const response = await fetch(path, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        cookie: (await cookies()).toString(),
        origin: webOrigin(),
      },
      body: JSON.stringify(body),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** 拼接知识 API 基础路径。 */
export function knowledgeBase(tenantId: string, workspaceId: string): string {
  return `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}`;
}
