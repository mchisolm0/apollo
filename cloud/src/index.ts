// The Worker in front of the inbox Durable Object. It routes, validates bodies
// and hashes the bearer token; the object does auth and everything stateful.
// Contract: ./contract.ts and docs/cloud-inbox.md.
import { type } from 'arktype';

import type { ApiError, CardResponse } from './contract';
import { secretsMatch, sha256Hex } from './crypto';
import { Inbox, TOKEN_HASH_HEADER, type Reply } from './inbox';
import * as schema from './schema';

export { Inbox };

/** One inbox for now. Everything is keyed by inbox name so more can follow. */
const INBOX_NAME = 'owner';
const MAX_BODY_LENGTH = 64 * 1024;

interface Base {
  request: Request;
  url: URL;
  inbox: DurableObjectStub<Inbox>;
}
interface Authed extends Base {
  /** SHA-256 of the caller's bearer token. */
  auth: string;
}

const error = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } } satisfies ApiError, { status });

const send = (reply: Reply<unknown>) =>
  reply.status === 204 ? new Response(null, { status: 204 }) : Response.json(reply.body, { status: reply.status });

const bearer = (request: Request) => request.headers.get('authorization')?.match(/^Bearer (\S+)$/)?.[1];

/** Parses and validates a JSON body, or returns the 4xx response to send instead. */
async function readBody<T>(request: Request, validate: (data: unknown) => T | type.errors): Promise<T | Response> {
  const text = await request.text();
  if (text.length > MAX_BODY_LENGTH) return error(413, 'body_too_large', 'body is too large');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return error(400, 'invalid_json', 'body must be JSON');
  }
  const out = validate(data);
  return out instanceof type.errors ? error(400, 'invalid_body', out.summary) : out;
}

// `/v1/cards/:id/respond` -> { id: string }
type ParamNames<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? Name | ParamNames<`/${Rest}`>
  : P extends `${string}:${infer Name}`
    ? Name
    : never;
type Params<P extends string> = { [K in ParamNames<P>]: string };

/** A tiny URLPattern router whose handlers get typed path params. */
function router<C>() {
  type Route = { method: string; pattern: URLPattern; handle: (c: C, groups: Record<string, string>) => Promise<Response> };
  const routes: Route[] = [];
  const self = {
    on<const P extends string>(method: string, path: P, handle: (c: C, params: Params<P>) => Promise<Response>) {
      // URLPattern guarantees every named group in `path` is present.
      routes.push({ method, pattern: new URLPattern({ pathname: path }), handle: (c, groups) => handle(c, groups as Params<P>) });
      return self;
    },
    match(method: string, url: URL) {
      for (const route of routes) {
        const groups = route.method === method ? route.pattern.exec(url)?.pathname.groups : undefined;
        if (!groups) continue;
        const params = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, decodeURIComponent(v ?? '')]));
        return (c: C) => route.handle(c, params);
      }
    },
  };
  return self;
}

const v1 = router<Authed>()
  .on('POST', '/v1/cards', async ({ request, inbox, auth }) => {
    const input = await readBody(request, schema.CardInput);
    return input instanceof Response ? input : send(await inbox.upsertCard(auth, input));
  })
  .on('GET', '/v1/cards', async ({ inbox, auth }) => send(await inbox.listCards(auth)))
  .on('PATCH', '/v1/cards/:id', async ({ request, inbox, auth }, { id }) => {
    const patch = await readBody(request, schema.CardPatch);
    return patch instanceof Response ? patch : send(await inbox.patchCard(auth, id, patch));
  })
  .on('POST', '/v1/cards/:id/respond', async ({ request, inbox, auth }, { id }) => {
    const key = schema.IdempotencyKey(request.headers.get('idempotency-key'));
    if (key instanceof type.errors) return error(400, 'idempotency_key_required', 'send an Idempotency-Key header');
    const response = await readBody(request, schema.CardResponse);
    if (response instanceof Response) return response;
    // Hash a canonical form so key order in the client's JSON doesn't matter.
    const canonical: CardResponse = 'actionId' in response ? { actionId: response.actionId } : { pick: response.pick, done: response.done };
    const bodyHash = await sha256Hex(JSON.stringify(canonical));
    return send(await inbox.respond(auth, id, canonical, { key, bodyHash }));
  })
  .on('GET', '/v1/events', async ({ url, inbox, auth }) => {
    const query = schema.EventsQuery(Object.fromEntries(url.searchParams));
    if (query instanceof type.errors) return error(400, 'invalid_query', query.summary);
    return send(await inbox.listEvents(auth, query));
  })
  .on('GET', '/v1/stream', async ({ request, url, inbox, auth }) => {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return error(426, 'upgrade_required', 'expected a WebSocket upgrade');
    return inbox.fetch(new Request(url, { headers: { upgrade: 'websocket', [TOKEN_HASH_HEADER]: auth } }));
  })
  .on('POST', '/v1/devices', async ({ request, inbox, auth }) => {
    const registration = await readBody(request, schema.DeviceRegistration);
    return registration instanceof Response ? registration : send(await inbox.registerDevice(auth, registration));
  })
  .on('DELETE', '/v1/devices/self', async ({ inbox, auth }) => send(await inbox.unregisterDevice(auth)))
  .on('POST', '/v1/device-tokens', async ({ request, inbox, auth }) => {
    const body = await readBody(request, schema.DeviceTokenRequest);
    return body instanceof Response ? body : send(await inbox.mintDeviceToken(auth, body));
  })
  .on('DELETE', '/v1/device-tokens/:name', async ({ inbox, auth }, { name }) => send(await inbox.revokeDeviceToken(auth, name)));

const admin = router<Base>()
  .on('POST', '/admin/tokens', async ({ request, inbox }) => {
    const body = await readBody(request, schema.TokenRequest);
    return body instanceof Response ? body : Response.json(await inbox.createToken(body), { status: 201 });
  })
  .on('GET', '/admin/tokens', async ({ inbox }) => Response.json(await inbox.listTokens()))
  .on('DELETE', '/admin/tokens/:id', async ({ inbox }, { id }) =>
    (await inbox.revokeToken(id)) ? new Response(null, { status: 204 }) : error(404, 'not_found', 'token not found'),
  );

async function isAdmin(request: Request, env: Env) {
  const presented = bearer(request);
  if (!presented || !env.ADMIN_SECRET) return false;
  return secretsMatch(presented, env.ADMIN_SECRET);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/v1/health') return Response.json({ ok: true });

    try {
      const inbox = env.INBOX.getByName(INBOX_NAME);
      const adminRoute = admin.match(request.method, url);
      if (adminRoute) {
        return (await isAdmin(request, env)) ? await adminRoute({ request, url, inbox }) : error(401, 'unauthorized', 'admin secret required');
      }
      const route = v1.match(request.method, url);
      if (!route) return error(404, 'not_found', 'no such route');
      const token = bearer(request);
      if (!token) return error(401, 'unauthorized', 'bearer token required');
      return await route({ request, url, inbox, auth: await sha256Hex(token) });
    } catch (cause) {
      console.error(cause);
      return error(500, 'internal', 'internal error');
    }
  },
} satisfies ExportedHandler<Env>;
