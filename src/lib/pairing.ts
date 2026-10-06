import { normalizeEndpoint } from './endpoint.ts';
import type {
  PairingDescriptor,
  PairingInput,
  PairingResult,
  HermesCapabilities,
} from './types';
import {
  booleanValue,
  errorMessage,
  isJsonObject,
  numberValue,
  pathUrl,
  stringValue,
} from './protocol.ts';

export function normalizePairingCode(code: string): string {
  return code.trim().toUpperCase().replace(/[\s-]/g, '');
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Parses only the explicit apollo://pair deep link shape. */
export function parsePairingLink(link: string): PairingInput {
  let parsed: URL;
  try {
    parsed = new URL(link.trim());
  } catch {
    throw new Error('Invalid pairing link');
  }
  if (parsed.protocol !== 'apollo:' || parsed.hostname !== 'pair') {
    throw new Error('Pairing link must use apollo://pair');
  }

  const endpointValue = parsed.searchParams.get('host') ?? parsed.searchParams.get('endpoint');
  const rawFragment = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
  const fragmentParams = new URLSearchParams(rawFragment);
  const token = fragmentParams.get('token') ?? (rawFragment.startsWith('token=') ? rawFragment.slice(6) : rawFragment);
  if (!endpointValue || !token) {
    throw new Error('Pairing link is missing its endpoint or one-time token');
  }
  return { endpoint: normalizeEndpoint(endpointValue), bootstrapToken: fragmentParams.has('token') ? token : decode(token) };
}

export function parseCapabilities(value: unknown): HermesCapabilities | undefined {
  if (!isJsonObject(value)) return undefined;
  const rawFeatures = value.features;
  const features: Record<string, boolean | string | Record<string, unknown>> = {};
  if (isJsonObject(rawFeatures)) {
    for (const [key, feature] of Object.entries(rawFeatures)) {
      if (typeof feature === 'boolean' || typeof feature === 'string' || isJsonObject(feature)) {
        features[key] = feature;
      }
    }
  } else if (Array.isArray(rawFeatures)) {
    for (const feature of rawFeatures) {
      if (typeof feature === 'string') features[feature] = true;
    }
  }
  return {
    object: stringValue(value.object),
    platform: stringValue(value.platform),
    model: stringValue(value.model),
    auth: isJsonObject(value.auth)
      ? { type: stringValue(value.auth.type), required: booleanValue(value.auth.required) }
      : undefined,
    features,
  };
}

export function parsePairingDescriptor(value: unknown, fallbackEndpoint?: string): PairingDescriptor {
  if (!isJsonObject(value)) throw new Error('Pairing descriptor was not an object');
  const id = stringValue(value.id) ?? stringValue(value.agent_id);
  const label = stringValue(value.label) ?? stringValue(value.name);
  if (!id || !label) throw new Error('Pairing descriptor is missing an id or label');
  const auth = isJsonObject(value.auth) ? value.auth : undefined;
  const pairing = isJsonObject(value.pairing) ? value.pairing : undefined;
  const exchangePath =
    (pairing && stringValue(pairing.exchange_path)) ??
    (auth && stringValue(auth.exchange_path)) ??
    stringValue(value.exchange_path) ??
    '/oauth/token';
  if (!exchangePath.startsWith('/')) throw new Error('Pairing descriptor has an invalid exchange path');
  return {
    id,
    label,
    hostname: stringValue(value.hostname) ?? (fallbackEndpoint ? new URL(fallbackEndpoint).hostname : undefined),
    connectorVersion: stringValue(value.connector_version) ?? stringValue(value.version),
    capabilities: parseCapabilities(value.capabilities),
    exchangePath,
  };
}

export class PairingClient {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  async describe(endpoint: string): Promise<PairingDescriptor> {
    const baseUrl = normalizeEndpoint(endpoint);
    const response = await this.fetchImpl(pathUrl(baseUrl, '/.well-known/apollo/agent'));
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw new Error(errorMessage(body, `Descriptor request failed (${response.status})`));
    return parsePairingDescriptor(body, baseUrl);
  }

  /** Exchanges the QR bootstrap token for a revocable device token. */
  async exchange(endpoint: string, bootstrapToken: string, deviceName?: string): Promise<PairingResult> {
    const baseUrl = normalizeEndpoint(endpoint);
    const descriptor = await this.describe(baseUrl);
    const response = await this.fetchImpl(pathUrl(baseUrl, descriptor.exchangePath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ token: bootstrapToken, device_name: deviceName }),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw new Error(errorMessage(body, `Pairing exchange failed (${response.status})`));
    if (!isJsonObject(body)) throw new Error('Pairing exchange returned an invalid response');
    const accessToken = stringValue(body.access_token) ?? stringValue(body.token);
    if (!accessToken) throw new Error('Pairing exchange did not return an access token');
    return {
      descriptor,
      accessToken,
      deviceId: stringValue(body.device_id),
      expiresIn: numberValue(body.expires_in),
    };
  }
}
