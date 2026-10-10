import type { Card, CardResponse, CardSnapshot, DeviceRegistration } from '../../../cloud/src/contract.ts';

import { parseCard, parseSnapshot } from './cards.ts';

/** Where and how this phone reaches the cloud inbox. `agentId` is the connector that granted it. */
export type CloudCredential = { url: string; token: string; agentId: string };

/** A failed cloud or connector request. `card` carries the current card on `409 card_closed`. */
export class CloudRequestError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly card?: Card;

  constructor(message: string, details: { status?: number; code?: string; card?: Card } = {}) {
    super(message);
    this.name = 'CloudRequestError';
    this.status = details.status;
    this.code = details.code;
    this.card = details.card;
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Accepts HTTPS, or HTTP on loopback for local development. Returns the URL without a trailing slash. */
export function normalizeCloudUrl(value: string): string | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) return undefined;
  return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`;
}

/** Reads the connector's optional `cloud: { url, token }` from pair exchange or `/v1/apollo/cloud-token`. */
export function parseCloudGrant(body: unknown): { url: string; token: string } | undefined {
  if (!body || typeof body !== 'object' || !('cloud' in body)) return undefined;
  const cloud = body.cloud;
  if (!cloud || typeof cloud !== 'object' || !('url' in cloud) || !('token' in cloud)) return undefined;
  const url = typeof cloud.url === 'string' ? normalizeCloudUrl(cloud.url) : undefined;
  return url && typeof cloud.token === 'string' && cloud.token ? { url, token: cloud.token } : undefined;
}

async function failure(response: Response): Promise<CloudRequestError> {
  const body: unknown = await response.json().catch(() => undefined);
  const error = body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object' ? body.error : undefined;
  const code = error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  const message = error && 'message' in error && typeof error.message === 'string' ? error.message : `Cloud request failed (${response.status})`;
  const card = error && 'card' in error ? parseCard(error.card) : undefined;
  return new CloudRequestError(message, { status: response.status, code, card });
}

export function createCloudClient({ url, token, fetchImpl = fetch, timeoutMs = 10_000 }: {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}) {
  const request = async (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${url}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) throw await failure(response);
      return response.status === 204 ? undefined : await response.json().catch(() => undefined);
    } catch (error) {
      if (error instanceof CloudRequestError) throw error;
      throw new CloudRequestError(controller.signal.aborted ? 'The cloud inbox did not respond.' : 'The cloud inbox is unreachable.');
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    async cards(): Promise<CardSnapshot> {
      const snapshot = parseSnapshot(await request('GET', '/v1/cards'));
      if (!snapshot) throw new CloudRequestError('The cloud inbox sent an invalid card list.');
      return snapshot;
    },
    async respond(cardId: string, response: CardResponse, idempotencyKey: string): Promise<Card> {
      const card = parseCard(await request('POST', `/v1/cards/${encodeURIComponent(cardId)}/respond`, response, { 'idempotency-key': idempotencyKey }));
      if (!card) throw new CloudRequestError('The cloud inbox sent an invalid card.');
      return card;
    },
    async registerDevice(registration: DeviceRegistration): Promise<void> {
      await request('POST', '/v1/devices', registration);
    },
    async unregisterDevice(): Promise<void> {
      await request('DELETE', '/v1/devices/self');
    },
    streamUrl: () => `${url.replace(/^http/u, 'ws')}/v1/stream`,
  };
}

export type CloudClient = ReturnType<typeof createCloudClient>;
