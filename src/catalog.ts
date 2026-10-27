import type { SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };

async function sdk() {
  return import("@anthropic-ai/claude-agent-sdk");
}

export async function listProjectSessions(dir: string): Promise<SDKSessionInfo[]> {
  const api = await sdk();
  return api.listSessions({ dir, limit: 40, includeProgrammatic: true });
}

export async function readSession(dir: string, id: string): Promise<SessionMessage[]> {
  const api = await sdk();
  return api.getSessionMessages(id, { dir });
}

export async function readSessionInfo(dir: string, id: string): Promise<SDKSessionInfo | undefined> {
  const api = await sdk();
  return api.getSessionInfo(id, { dir });
}

export async function removeSession(dir: string, id: string): Promise<void> {
  const api = await sdk();
  await api.deleteSession(id, { dir });
}

export function sessionTitle(
  info: { summary?: string; customTitle?: string; firstPrompt?: string } | undefined,
  fallback = "Session",
): string {
  const raw = info?.customTitle || info?.summary || info?.firstPrompt || fallback;
  const line = raw.split("\n").map((part) => part.trim()).find(Boolean) || fallback;
  return line.length > 72 ? `${line.slice(0, 72)}…` : line;
}
