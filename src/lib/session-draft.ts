import { isDraftAttachment, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, type DraftAttachment } from './attachments.ts';

export type DraftStorage = Readonly<{
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}>;

export type SessionDraftState = Readonly<{
  draft: string;
  attachments: readonly DraftAttachment[];
  loaded: boolean;
  error?: string;
}>;

export type PreparedDraft = Readonly<{
  id: string;
  sessionId: string;
  text: string;
  attachments: readonly DraftAttachment[];
}>;

export type SessionDraftStoreOptions = Readonly<{
  storage: DraftStorage;
  uuid: () => string;
}>;

type DraftRecord = {
  version: 2;
  draft: string;
  attachments: DraftAttachment[];
  receipts: string[];
  prepared?: PreparedDraft;
};
type Listener = () => void;

const VERSION = 2;
const MAX_RECEIPTS = 1000;
const stores = new Map<string, SessionDraftStore>();
const queues = new Map<string, Promise<void>>();
let reloadPending = false;
let draftsHeld = false;

export function draftKey(agentId: string, sessionId: string): string {
  return `ekho.draft.v2.${encodeURIComponent(agentId)}.${encodeURIComponent(sessionId)}`;
}

function legacyDraftKey(agentId: string, sessionId: string): string {
  return `ekho.draft.${encodeURIComponent(agentId)}.${encodeURIComponent(sessionId)}`;
}

function validateDraft(draft: string, attachments: readonly DraftAttachment[]): void {
  if (draft.length > 8000) throw new Error('Drafts must be 8,000 characters or shorter.');
  if (attachments.length > MAX_ATTACHMENTS) throw new Error(`You can attach up to ${MAX_ATTACHMENTS} files per message.`);
  if (!attachments.every(isDraftAttachment)) throw new Error('One or more attachments are invalid.');
  if (attachments.some((file) => file.size > MAX_ATTACHMENT_BYTES)) throw new Error('Choose files no larger than 10 MB each.');
}

function validPrepared(value: unknown): value is PreparedDraft {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string' && item.id.length > 0
    && typeof item.sessionId === 'string' && item.sessionId.length > 0
    && typeof item.text === 'string' && item.text.length <= 8000 && Array.isArray(item.attachments)
    && item.attachments.length <= MAX_ATTACHMENTS && item.attachments.every(isDraftAttachment);
}

function validRecord(value: unknown): value is DraftRecord {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return item.version === VERSION && typeof item.draft === 'string'
    && Array.isArray(item.attachments) && item.attachments.length <= MAX_ATTACHMENTS && item.attachments.every(isDraftAttachment) && Array.isArray(item.receipts)
    && item.receipts.length <= MAX_RECEIPTS
    && item.receipts.every((receipt) => typeof receipt === 'string' && receipt.length > 0)
    && (item.prepared === undefined || validPrepared(item.prepared));
}

function sameAttachments(a: readonly DraftAttachment[], b: readonly DraftAttachment[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function enqueueKeys<T>(keys: readonly string[], task: () => Promise<T>): Promise<T> {
  const unique = [...new Set(keys)].sort();
  const prior = unique.map((key) => queues.get(key) ?? Promise.resolve());
  const next = Promise.all(prior).then(() => {
    if (draftsHeld) throw new Error('The app is restarting.');
    return task();
  });
  const settled = next.then(() => undefined, () => undefined);
  unique.forEach((key) => queues.set(key, settled));
  return next;
}

export class SessionDraftStore {
  readonly key: string;
  readonly agentId: string;
  readonly sessionId: string;
  private readonly legacyKey: string;
  private readonly listeners = new Set<Listener>();
  private state: SessionDraftState = { draft: '', attachments: [], loaded: false };
  private record: DraftRecord = { version: VERSION, draft: '', attachments: [], receipts: [] };
  private loadPromise?: Promise<void>;
  private edited = false;
  private saveFailed = false;
  private revision = 0;
  private persistenceKey: string;

  private readonly options: SessionDraftStoreOptions;

  constructor(agentId: string, sessionId: string, options: SessionDraftStoreOptions) {
    this.agentId = agentId;
    this.sessionId = sessionId;
    this.options = options;
    this.key = draftKey(agentId, sessionId);
    this.persistenceKey = this.key;
    this.legacyKey = legacyDraftKey(agentId, sessionId);
  }

  getSnapshot = (): SessionDraftState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(patch: Partial<SessionDraftState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  load(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this.restore();
    return this.loadPromise;
  }

  retryLoad(): Promise<void> {
    if (this.state.loaded) return this.saveFailed ? this.saveCurrent() : Promise.resolve();
    this.loadPromise = undefined;
    return this.load();
  }

  /** Confirms the latest draft is durable before an update tears down JS. */
  async flush(): Promise<boolean> {
    await this.load();
    if (!this.state.loaded || this.state.error) return false;
    const revision = this.revision;
    await this.saveCurrent();
    const barrier = queues.get(this.persistenceKey);
    await barrier;
    return barrier === queues.get(this.persistenceKey) && revision === this.revision && !this.saveFailed && !this.state.error;
  }

  private async restore(): Promise<void> {
    try {
      const saved = await this.options.storage.getItem(this.key);
      if (saved !== null) {
        const parsed: unknown = JSON.parse(saved);
        if (!validRecord(parsed)) throw new Error('Saved draft is invalid.');
        validateDraft(parsed.draft, parsed.attachments);
        if (parsed.prepared && (parsed.prepared.text !== parsed.draft || !sameAttachments(parsed.prepared.attachments, parsed.attachments))) parsed.prepared = undefined;
        this.record = this.edited
          ? { ...parsed, draft: this.record.draft, attachments: this.record.attachments, prepared: undefined }
          : parsed;
      } else {
        const oldDraft = await this.options.storage.getItem(this.legacyKey);
        const oldFiles = await this.options.storage.getItem(`${this.legacyKey}:attachments`);
        if (oldDraft !== null || oldFiles !== null) {
          const attachments: DraftAttachment[] = oldFiles ? JSON.parse(oldFiles) : [];
          validateDraft(oldDraft ?? '', attachments);
          const migrated: DraftRecord = { version: VERSION, draft: oldDraft ?? '', attachments, receipts: [] };
          if (draftsHeld) throw new Error('The app is restarting.');
          await this.options.storage.setItem(this.key, JSON.stringify(migrated));
          await this.options.storage.removeItem(this.legacyKey);
          await this.options.storage.removeItem(`${this.legacyKey}:attachments`);
          this.record = this.edited
            ? { ...migrated, draft: this.record.draft, attachments: this.record.attachments }
            : migrated;
        }
      }
      if (this.edited) this.publish({ loaded: true });
      else this.publish({ draft: this.record.draft, attachments: this.record.attachments, loaded: true, error: undefined });
    } catch (reason) {
      this.publish({ loaded: false, error: reason instanceof Error ? reason.message : 'Could not restore the saved draft.' });
    }
  }

  setDraft(value: string): void {
    if (draftsHeld) return;
    try {
      validateDraft(value, this.state.attachments);
    } catch (reason) {
      this.publish({ error: reason instanceof Error ? reason.message : 'Draft is too large.' });
      return;
    }
    this.edited = true;
    this.revision += 1;
    this.saveFailed = false;
    this.record = { ...this.record, draft: value, prepared: undefined };
    this.publish({ draft: value, error: undefined });
    void this.saveCurrent();
  }

  setAttachments(files: readonly DraftAttachment[]): void {
    if (draftsHeld) return;
    try {
      validateDraft(this.state.draft, files);
    } catch (reason) {
      this.publish({ error: reason instanceof Error ? reason.message : 'Attachments are invalid.' });
      return;
    }
    this.edited = true;
    this.revision += 1;
    this.saveFailed = false;
    this.record = { ...this.record, attachments: [...files], prepared: undefined };
    this.publish({ attachments: [...files], error: undefined });
    void this.saveCurrent();
  }

  private async saveCurrent(): Promise<void> {
    try {
      await this.load();
      if (!this.state.loaded) throw new Error(this.state.error ?? 'Saved draft is unavailable.');
      const queuedKey = this.persistenceKey;
      await enqueueKeys([queuedKey], async () => {
        const target = this.persistenceKey;
        if (target !== queuedKey) {
          await enqueueKeys([target], () => this.options.storage.setItem(target, JSON.stringify(this.record)));
          return;
        }
        await this.options.storage.setItem(target, JSON.stringify(this.record));
      });
      this.saveFailed = false;
      this.publish({ error: undefined });
    } catch (reason) {
      this.saveFailed = true;
      this.publish({ error: reason instanceof Error ? reason.message : 'Could not save the draft on this device.' });
    }
  }

  async appendShare(shareId: string, text: string, files: readonly DraftAttachment[]): Promise<void> {
    await this.load();
    if (!this.state.loaded) throw new Error(this.state.error ?? 'Saved draft is unavailable.');
    return enqueueKeys([this.persistenceKey], async () => {
      if (this.record.receipts.includes(shareId)) {
        if (this.saveFailed) await this.options.storage.setItem(this.persistenceKey, JSON.stringify(this.record));
        this.saveFailed = false;
        return;
      }
      const nextText = this.record.draft ? `${this.record.draft}\n\n${text}` : text;
      const nextFiles = [...this.record.attachments, ...files];
      validateDraft(nextText, nextFiles);
      const receipts = [...this.record.receipts.slice(-(MAX_RECEIPTS - 1)), shareId];
      this.record = { ...this.record, draft: nextText, attachments: nextFiles, receipts, prepared: undefined };
      this.edited = true;
      this.revision += 1;
      const revision = this.revision;
      this.publish({ draft: nextText, attachments: nextFiles, error: undefined });
      await this.options.storage.setItem(this.persistenceKey, JSON.stringify(this.record));
      if (revision !== this.revision) {
        await this.options.storage.setItem(this.persistenceKey, JSON.stringify(this.record));
      }
      this.saveFailed = false;
    }).catch((reason) => {
      this.saveFailed = true;
      this.publish({ error: reason instanceof Error ? reason.message : 'Could not save the shared content.' });
      throw reason;
    });
  }

  async prepareSend(): Promise<PreparedDraft> {
    await this.load();
    if (!this.state.loaded) throw new Error(this.state.error ?? 'Saved draft is unavailable.');
    return enqueueKeys([this.persistenceKey], async () => {
      validateDraft(this.record.draft, this.record.attachments);
      if (this.saveFailed) throw new Error(this.state.error ?? 'Save the draft before sending.');
      if (this.record.prepared && this.record.prepared.text === this.record.draft && sameAttachments(this.record.prepared.attachments, this.record.attachments)) return this.record.prepared;
      if (!this.record.draft.trim() && !this.record.attachments.length) throw new Error('Draft cannot be empty.');
      const prepared: PreparedDraft = { id: this.options.uuid(), sessionId: this.sessionId === 'new' ? this.options.uuid() : this.sessionId, text: this.record.draft, attachments: [...this.record.attachments] };
      this.record = { ...this.record, prepared };
      const revision = this.revision;
      await this.options.storage.setItem(this.persistenceKey, JSON.stringify(this.record));
      if (revision !== this.revision) throw new Error('The draft changed while preparing. Try Send again.');
      this.saveFailed = false;
      this.publish({ error: undefined });
      return prepared;
    }).catch((reason) => {
      this.saveFailed = true;
      this.publish({ error: reason instanceof Error ? reason.message : 'Could not prepare the draft.' });
      throw reason;
    });
  }

  async clear(): Promise<void> {
    await this.load();
    if (!this.state.loaded) throw new Error(this.state.error ?? 'Saved draft is unavailable.');
    const requestedRevision = this.revision;
    return enqueueKeys([this.persistenceKey], async () => {
      if (requestedRevision !== this.revision) throw new Error('The draft changed before it could be cleared.');
      const cleared = { ...this.record, draft: '', attachments: [], prepared: undefined };
      await this.options.storage.setItem(this.persistenceKey, JSON.stringify(cleared));
      if (requestedRevision !== this.revision) {
        await this.options.storage.setItem(this.persistenceKey, JSON.stringify(this.record));
        throw new Error('The draft changed while it was being cleared.');
      }
      this.record = cleared;
      this.edited = true;
      this.revision += 1;
      this.publish({ draft: '', attachments: [], error: undefined });
      this.saveFailed = false;
    }).catch((reason) => {
      const message = reason instanceof Error ? `${reason.message} Try clearing the draft again.` : 'Could not clear the saved draft. Try again.';
      this.publish({ error: message });
      throw new Error(message);
    });
  }

  async move(nextSessionId: string, value: string, files: readonly DraftAttachment[] = this.state.attachments): Promise<void> {
    await this.load();
    if (nextSessionId === this.sessionId) return;
    if (!this.state.loaded) throw new Error(this.state.error ?? 'Saved draft is unavailable.');
    validateDraft(value, files);
    const nextKey = draftKey(this.agentId, nextSessionId);
    const requestedRevision = this.revision;
    await enqueueKeys([this.key, nextKey], async () => {
      const draft = requestedRevision === this.revision ? value : this.record.draft;
      const attachments = requestedRevision === this.revision ? [...files] : this.record.attachments;
      let moved = { ...this.record, draft, attachments, prepared: undefined };
      await this.options.storage.setItem(nextKey, JSON.stringify(moved));
      if (requestedRevision !== this.revision) {
        moved = { ...this.record, prepared: undefined };
        await this.options.storage.setItem(nextKey, JSON.stringify(moved));
      }
      await this.options.storage.removeItem(this.key);
      if (requestedRevision === this.revision) {
        this.record = moved;
        this.edited = true;
        this.revision += 1;
        this.publish({ draft, attachments, error: undefined });
      }
      this.persistenceKey = nextKey;
      const destination = stores.get(nextKey);
      destination?.adopt(moved);
      if (stores.get(this.key) === this) stores.delete(this.key);
      this.saveFailed = false;
    }).catch((reason) => {
      const message = reason instanceof Error ? `${reason.message} Try opening the thread again.` : 'Could not move the saved draft. Try again.';
      this.publish({ error: message });
      throw new Error(message);
    });
  }

  private adopt(record: DraftRecord): void {
    this.loadPromise = Promise.resolve();
    this.edited = true;
    this.record = record;
    this.publish({ draft: record.draft, attachments: record.attachments, loaded: true, error: undefined });
  }
}

export function getSessionDraftStore(agentId: string, sessionId: string, options: SessionDraftStoreOptions): SessionDraftStore {
  const key = draftKey(agentId, sessionId);
  const existing = stores.get(key);
  if (existing) return existing;
  const store = new SessionDraftStore(agentId, sessionId, options);
  stores.set(key, store);
  return store;
}

async function flushDrafts(holdForReload: boolean): Promise<boolean> {
  const pending = [...stores.values()];
  const results = await Promise.allSettled(pending.map(async (store) => await store.flush() ? store.getSnapshot() : undefined));
  const barriers = [...queues.entries()];
  await Promise.all(barriers.map(([, barrier]) => barrier));
  // An edit or a new composer while another draft is saving cancels the reload.
  const flushed = barriers.length === queues.size && barriers.every(([key, barrier]) => queues.get(key) === barrier)
    && pending.length === stores.size && results.every((result, index) =>
    result.status === 'fulfilled' && result.value !== undefined
    && stores.get(pending[index].key) === pending[index] && pending[index].getSnapshot() === result.value);
  if (flushed && holdForReload) draftsHeld = true;
  return flushed;
}

export async function flushSessionDrafts(): Promise<boolean> {
  return flushDrafts(false);
}

/** Holds late async draft mutations until JS teardown, or releases them on failure. */
export async function withSessionDraftReloadSafety(apply: () => Promise<boolean>): Promise<boolean> {
  if (reloadPending) return false;
  reloadPending = true;
  let applied = false;
  try {
    if (!await flushDrafts(true)) return false;
    applied = await apply();
    return applied;
  } finally {
    if (!applied) {
      draftsHeld = false;
      reloadPending = false;
    }
  }
}
