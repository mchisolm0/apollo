import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import { parseCapabilities } from './pairing';

import type { AgentRecord, AgentTransport } from './types';
import { isJsonObject, numberValue, stringValue } from './protocol';

export interface MetadataStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface SecretStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

const metadataKey = 'ekho.agent-catalog.v1';

const defaultMetadataStore: MetadataStore = {
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: (key) => AsyncStorage.removeItem(key),
};

const defaultSecretStore: SecretStore = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  deleteItem: (key) => SecureStore.deleteItemAsync(key),
};

function secretKey(agentId: string): string {
  return `ekho.agent-token.${encodeURIComponent(agentId)}`;
}

function parseAgent(value: unknown): AgentRecord | undefined {
  if (!isJsonObject(value) || !isJsonObject(value.endpoint)) return undefined;
  const id = stringValue(value.id);
  const label = stringValue(value.label);
  const url = stringValue(value.endpoint.url);
  const rawTransport = stringValue(value.endpoint.transport);
  if (!id || !label || !url) return undefined;
  const transport: AgentTransport =
    rawTransport === 'tailscale' || rawTransport === 'lan' || rawTransport === 'https'
      ? rawTransport
      : 'https';
  return {
    id,
    label,
    hostname: stringValue(value.hostname),
    endpoint: { url, transport },
    createdAt: numberValue(value.createdAt) ?? Date.now(),
    lastConnectedAt: numberValue(value.lastConnectedAt),
    activeRunId: stringValue(value.activeRunId),
    capabilities: parseCapabilities(value.capabilities),
  };
}

export class CredentialStore {
  private readonly store: SecretStore;

  constructor(store: SecretStore = defaultSecretStore) {
    this.store = store;
  }

  get(agentId: string): Promise<string | null> {
    return this.store.getItem(secretKey(agentId));
  }

  set(agentId: string, token: string): Promise<void> {
    return this.store.setItem(secretKey(agentId), token);
  }

  remove(agentId: string): Promise<void> {
    return this.store.deleteItem(secretKey(agentId));
  }
}

export class AgentCatalog {
  private readonly metadata: MetadataStore;
  readonly credentials: CredentialStore;
  private agents: AgentRecord[] = [];
  private loaded = false;

  constructor(options: { metadata?: MetadataStore; credentials?: CredentialStore } = {}) {
    this.metadata = options.metadata ?? defaultMetadataStore;
    this.credentials = options.credentials ?? new CredentialStore();
  }

  async load(): Promise<readonly AgentRecord[]> {
    const raw = await this.metadata.getItem(metadataKey);
    try {
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      this.agents = Array.isArray(parsed)
        ? parsed.map(parseAgent).filter((agent): agent is AgentRecord => agent !== undefined)
        : [];
    } catch {
      this.agents = [];
    }
    this.loaded = true;
    return this.list();
  }

  list(): readonly AgentRecord[] {
    return this.agents.map((agent) => ({ ...agent, endpoint: { ...agent.endpoint } }));
  }

  get(agentId: string): AgentRecord | undefined {
    return this.agents.find((agent) => agent.id === agentId);
  }

  async upsert(agent: AgentRecord, token?: string): Promise<void> {
    if (!agent.id || !agent.label || !agent.endpoint.url) throw new Error('Agent id, label, and endpoint are required');
    if (!this.loaded) await this.load();
    const index = this.agents.findIndex((item) => item.id === agent.id);
    if (index === -1) this.agents.push(agent);
    else this.agents[index] = agent;
    await this.persist();
    if (token !== undefined) await this.credentials.set(agent.id, token);
  }

  async update(agentId: string, patch: Partial<AgentRecord>): Promise<AgentRecord> {
    const current = this.get(agentId);
    if (!current) throw new Error(`Unknown agent: ${agentId}`);
    const next: AgentRecord = {
      ...current,
      ...patch,
      id: current.id,
      endpoint: patch.endpoint ?? current.endpoint,
    };
    await this.upsert(next);
    return next;
  }

  async remove(agentId: string): Promise<void> {
    if (!this.loaded) await this.load();
    this.agents = this.agents.filter((agent) => agent.id !== agentId);
    await this.persist();
    await this.credentials.remove(agentId);
  }

  private async persist(): Promise<void> {
    await this.metadata.setItem(metadataKey, JSON.stringify(this.agents));
  }
}
