export type NotificationDestination = {
  pathname: '/session/[id]';
  params: { id: string; agentId: string; runId: string };
};

const ID = /^[A-Za-z0-9._~-]{1,256}$/u;
const KINDS = new Set(['approval', 'completed', 'failed']);

export function notificationDestination(data: unknown): NotificationDestination | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  const value = data as Record<string, unknown>;
  if (!KINDS.has(value.kind as string) || typeof value.agent_id !== 'string' || !ID.test(value.agent_id) ||
      typeof value.session_id !== 'string' || !ID.test(value.session_id) ||
      typeof value.run_id !== 'string' || !ID.test(value.run_id)) return;
  return { pathname: '/session/[id]', params: { id: value.session_id, agentId: value.agent_id, runId: value.run_id } };
}
