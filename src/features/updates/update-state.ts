export type ReadyUpdate = { id: string; createdAt?: Date; notes: string[]; rollback: boolean };
export type UpdateState =
  | { status: 'idle' | 'checking' }
  | { status: 'downloading'; progress?: number }
  | { status: 'ready'; update: ReadyUpdate };

type UpdateSnapshot = {
  isChecking: boolean;
  isDownloading: boolean;
  downloadProgress?: number;
  isUpdatePending: boolean;
  downloadedUpdate?: { updateId?: string; createdAt: Date; manifest?: unknown };
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

export function releaseNotes(manifest: unknown): string[] {
  if (!isObject(manifest) || !isObject(manifest.extra)) return [];
  const client = manifest.extra.expoClient;
  if (!isObject(client) || !isObject(client.extra)) return [];
  const notes = client.extra.releaseNotes;
  return Array.isArray(notes) ? notes.filter((note): note is string => typeof note === 'string' && note.trim().length > 0) : [];
}

export function updateState(enabled: boolean, snapshot: UpdateSnapshot): UpdateState {
  if (!enabled) return { status: 'idle' };
  const downloaded = snapshot.downloadedUpdate;
  if (snapshot.isUpdatePending && downloaded) return {
    status: 'ready',
    update: {
      id: downloaded.updateId ?? `embedded:${downloaded.createdAt.toISOString()}`,
      createdAt: downloaded.createdAt,
      notes: releaseNotes(downloaded.manifest),
      rollback: !downloaded.updateId,
    },
  };
  if (snapshot.isDownloading) return { status: 'downloading', progress: snapshot.downloadProgress };
  return { status: snapshot.isChecking ? 'checking' : 'idle' };
}

export function shouldNoticeUpdate(state: UpdateState, noticedId: string | null, active: boolean, keyboardVisible: boolean): boolean {
  return active && !keyboardVisible && state.status === 'ready' && state.update.id !== noticedId;
}

/** Counts only time spent displaying a notice, resuming after keyboard or app hiding. */
export function createUpdateNoticeTimer() {
  let id: string | undefined;
  let remaining = 8_000;
  let shownAt: number | undefined;
  return {
    show(updateId: string, now: number) {
      if (id !== updateId) { id = updateId; remaining = 8_000; }
      shownAt = now;
      return remaining;
    },
    hide(now: number) {
      if (shownAt === undefined) return;
      remaining = Math.max(0, remaining - Math.max(0, now - shownAt));
      shownAt = undefined;
    },
  };
}

export const FOREGROUND_CHECK_INTERVAL_MS = 60 * 60 * 1000;

type UpdateEnvironment = {
  enabled: boolean;
  now(): number;
  appState(): string;
  state(): UpdateState;
  check(): Promise<{ isAvailable: boolean; isRollBackToEmbedded: boolean }>;
  fetch(): Promise<unknown>;
  withDraftReloadSafety(apply: () => Promise<boolean>): Promise<boolean>;
  withReloadSafety(apply: () => Promise<boolean>): Promise<boolean>;
  reload(): Promise<void>;
};

/** Coordinates foreground checks and reloads without depending on React Native. */
export function createUpdateController(env: UpdateEnvironment) {
  let lastCheck = env.now();
  let checking = false;
  let restarting = false;
  let transition = 0;

  async function restart(quiet: boolean): Promise<boolean> {
    if (!env.enabled || restarting || env.state().status !== 'ready') return false;
    restarting = true;
    const startedAtTransition = transition;
    const pending = env.state();
    let applied = false;
    try {
      applied = await env.withReloadSafety(() => env.withDraftReloadSafety(async () => {
        const current = env.state();
        if (current.status !== 'ready' || pending.status !== 'ready' || current.update.id !== pending.update.id) return false;
        if (quiet && (env.appState() !== 'background' || startedAtTransition !== transition)) return false;
        await env.reload();
        return true;
      }));
      return applied;
    } catch {
      return false;
    } finally {
      if (!applied) restarting = false;
    }
  }

  async function onAppState(state: string): Promise<void> {
    transition += 1;
    if (!env.enabled) return;
    if (state === 'background') {
      await restart(true);
      return;
    }
    if (state !== 'active' || checking || restarting || env.state().status !== 'idle') return;
    const now = env.now();
    if (now - lastCheck < FOREGROUND_CHECK_INTERVAL_MS) return;
    lastCheck = now;
    checking = true;
    try {
      const result = await env.check();
      if (result.isAvailable || result.isRollBackToEmbedded) await env.fetch();
    } catch {
      // Offline checks can wait until the next foreground interval.
    } finally {
      checking = false;
    }
  }

  return { onAppState, restart: () => restart(false) };
}

export function relativeUpdateAge(createdAt: Date | undefined, now: number): string | undefined {
  if (!createdAt || !Number.isFinite(createdAt.getTime())) return undefined;
  const minutes = Math.max(0, Math.floor((now - createdAt.getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

export function buildSummary(info: { version: string | null; build: string | null; channel?: string | null; development: boolean; embedded: boolean; updateId?: string; createdAt?: Date }, now: number): string {
  const version = `${info.version ?? 'Unknown'}${info.build ? ` (${info.build})` : ''}`;
  const update = info.development ? 'development' : info.embedded || !info.updateId ? 'embedded' : `update ${info.updateId.slice(0, 6)}`;
  return [version, info.channel, update, relativeUpdateAge(info.createdAt, now)].filter(Boolean).join(' · ');
}
