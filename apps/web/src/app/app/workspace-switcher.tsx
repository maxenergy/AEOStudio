'use client';

import type { WorkspaceListEnvelope } from '@aeostudio/contracts';
import { useRouter } from 'next/navigation';

type WorkspaceEntry = WorkspaceListEnvelope['data']['workspaces'][number];

export function WorkspaceSwitcher({
  workspaces,
  current,
}: {
  workspaces: WorkspaceEntry[];
  current: WorkspaceEntry;
}) {
  const router = useRouter();
  return (
    <div className="workspace-switcher">
      <label htmlFor="workspace-switcher">切换 Workspace</label>
      <select
        id="workspace-switcher"
        onChange={(event) => {
          const selected = workspaces.find(
            (entry) => `${entry.tenant.id}:${entry.workspace.id}` === event.target.value,
          );
          if (selected !== undefined) {
            router.push(`/app?tenant=${selected.tenant.id}&workspace=${selected.workspace.id}`);
          }
        }}
        value={`${current.tenant.id}:${current.workspace.id}`}
      >
        {workspaces.map((entry) => (
          <option
            key={`${entry.tenant.id}:${entry.workspace.id}`}
            value={`${entry.tenant.id}:${entry.workspace.id}`}
          >
            {entry.tenant.name} / {entry.workspace.name}
          </option>
        ))}
      </select>
    </div>
  );
}
