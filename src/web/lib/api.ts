import type { ContextBlock, ContextPack, HandoffListItem, HandoffPacket, UiStatus } from "../../types";

export type TaskSummary = { task: string; handoffCount: number; latestAt: string };

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, headers: init.body ? { "content-type": "application/json" } : undefined });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

export const fetchStatus = () => api<UiStatus>("/api/status");
export const fetchHandoffs = () => api<{ handoffs: HandoffListItem[] }>("/api/handoffs?view=list").then((data) => data.handoffs);
export const fetchHandoff = (id: string) => api<{ handoff: HandoffPacket }>(`/api/handoffs/${encodeURIComponent(id)}`).then((data) => data.handoff);
export const fetchTasks = () => api<{ tasks: TaskSummary[] }>("/api/tasks").then((data) => data.tasks);
export const fetchPacks = () => api<{ packs: ContextPack[] }>("/api/context-packs").then((data) => data.packs);
export const fetchBlocks = (handoffId: string) => api<{ blocks: ContextBlock[] }>(`/api/context-blocks?handoff=${encodeURIComponent(handoffId)}`).then((data) => data.blocks);
export const savePack = (pack: ContextPack) => api<{ pack: ContextPack }>("/api/context-packs", { method: "POST", body: JSON.stringify(pack) }).then((data) => data.pack);
export const deletePack = (id: string) => api(`/api/context-packs/${encodeURIComponent(id)}`, { method: "DELETE" });

export type FileView = { ok: true; path: string; size: number; language: string; content: string; redacted?: boolean } | { ok: false; error: string };

export function fetchFileView(repoPath: string, path: string): Promise<FileView> {
  return fetch(`/api/files/view?repoPath=${encodeURIComponent(repoPath)}&path=${encodeURIComponent(path)}`).then((response) => response.json() as Promise<FileView>);
}

export function openInEditor(repoPath: string, path: string): Promise<{ ok: boolean; method?: string; error?: string }> {
  return api("/api/files/open", { method: "POST", body: JSON.stringify({ repoPath, path }) });
}
