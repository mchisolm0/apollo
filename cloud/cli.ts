#!/usr/bin/env node
// Token CLI for the cloud inbox. Dependency-free; Node runs it directly.
// It calls /admin/* with the admin secret, which never leaves this machine.
import type { ApiError, TokenRole } from './src/contract.ts';

type TokenInfo = { id: string; role: TokenRole; name: string; createdAt: string };

const ROLES: readonly string[] = ['device', 'producer', 'connector'] satisfies TokenRole[];

function usage() {
  console.log(`Apollo cloud tokens

  node cloud/cli.ts create <device|producer|connector> <name>
  node cloud/cli.ts list
  node cloud/cli.ts revoke <id>

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
    const [role, name] = args;
    if (!role || !ROLES.includes(role) || !name) {
      usage();
      process.exit(1);
    }
    const created: TokenInfo & { token: string } = await (await admin('POST', '/admin/tokens', { role, name })).json();
    console.log(`Created ${created.role} token "${created.name}" (${created.id}).`);
    console.log(`\n${created.token}\n`);
    console.log('This is the only time the token is shown.');
  } else if (command === 'list') {
    const tokens: TokenInfo[] = await (await admin('GET', '/admin/tokens')).json();
    for (const t of tokens) console.log(`${t.id}  ${t.role.padEnd(9)}  ${t.createdAt}  ${t.name}`);
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
