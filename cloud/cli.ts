#!/usr/bin/env node
// Token CLI for the cloud inbox. Dependency-free; Node runs it directly.
// It calls /admin/* with the admin secret, which never leaves this machine.
import { parseArgs } from 'node:util';

import type { ApiError, TokenRole, TokenScope } from './src/contract.ts';

type TokenInfo = { id: string; role: TokenRole; name: string; createdAt: string; scope?: TokenScope };

const ROLES: readonly string[] = ['device', 'producer', 'connector'] satisfies TokenRole[];

function usage() {
  console.log(`Apollo cloud tokens

  node cloud/cli.ts create <device|producer|connector> <name>
  node cloud/cli.ts create producer <name> --source <source> --allow <prefix>...
  node cloud/cli.ts list
  node cloud/cli.ts revoke <id>

--source limits a producer to one source's cards and events. Each --allow is a
link prefix ending in /, e.g. scryve-preview:// or https://github.com/HashingSeeds/.

Reads APOLLO_CLOUD_URL and APOLLO_CLOUD_ADMIN_SECRET from the environment.`);
}

const isApiError = (data: unknown): data is ApiError => typeof data === 'object' && data !== null && 'error' in data;

/** Calls /admin/* and throws the server's error message on failure. */
async function admin(method: string, path: string, body?: unknown) {
  const base = process.env.APOLLO_CLOUD_URL;
  const secret = process.env.APOLLO_CLOUD_ADMIN_SECRET;
  if (!base || !secret) throw new Error('Set APOLLO_CLOUD_URL and APOLLO_CLOUD_ADMIN_SECRET.');
  const response = await fetch(new URL(path, base), {
    method,
    headers: { authorization: `Bearer ${secret}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => undefined);
    throw new Error(isApiError(data) ? data.error.message : `cloud returned ${response.status}`);
  }
  return response;
}

const [command = 'help', ...args] = process.argv.slice(2);

try {
  if (command === 'create') {
    const { positionals: [role, name], values } = parseArgs({
      args,
      allowPositionals: true,
      options: { source: { type: 'string' }, allow: { type: 'string', multiple: true } },
    });
    if (!role || !ROLES.includes(role) || !name || values.source === '' || (values.allow && !values.source)) {
      usage();
      process.exit(1);
    }
    const scope = values.source ? { source: values.source, urls: values.allow ?? [] } : undefined;
    const created: TokenInfo & { token: string } = await (await admin('POST', '/admin/tokens', { role, name, scope })).json();
    console.log(`Created ${created.role} token "${created.name}" (${created.id})${created.scope ? `, limited to ${created.scope.source}` : ''}.`);
    console.log(`\n${created.token}\n`);
    console.log('This is the only time the token is shown.');
  } else if (command === 'list') {
    const tokens: TokenInfo[] = await (await admin('GET', '/admin/tokens')).json();
    for (const t of tokens) console.log(`${t.id}  ${t.role.padEnd(9)}  ${t.createdAt}  ${t.name}${t.scope ? `  (${t.scope.source}: ${t.scope.urls.join(' ') || 'no links'})` : ''}`);
    if (tokens.length === 0) console.log('No tokens.');
  } else if (command === 'revoke') {
    const [id] = args;
    if (!id) {
      usage();
      process.exit(1);
    }
    await admin('DELETE', `/admin/tokens/${encodeURIComponent(id)}`);
    console.log(`Revoked ${id}.`);
  } else {
    usage();
    process.exit(command === 'help' || command === '--help' || command === '-h' ? 0 : 1);
  }
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exit(1);
}
