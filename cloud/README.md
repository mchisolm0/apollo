# Apollo cloud inbox

A Cloudflare Worker in front of one `Inbox` Durable Object per inbox (just `owner` for now). The object keeps tokens, cards, the response log and push registrations in its own SQLite database, holds the phone's hibernatable WebSocket, and sends Expo push. The API is in [`docs/cloud-inbox.md`](../docs/cloud-inbox.md) and [`src/contract.ts`](src/contract.ts).

- `src/index.ts`: routing, body validation (ArkType), token hashing, the admin secret check
- `src/inbox.ts`: the Durable Object: auth, cards, events, stream, alarm
- `src/push.ts`: Expo messages and send
- `cli.ts`: token CLI

## Develop and test

```sh
pnpm install
echo 'ADMIN_SECRET=dev-secret' > cloud/.dev.vars
pnpm --filter @apollo/cloud dev      # http://localhost:8787
pnpm test:cloud                      # typecheck + Vitest in workerd
```

After changing `wrangler.jsonc`, run `pnpm --filter @apollo/cloud types` and commit `worker-configuration.d.ts`.

## Deploy

```sh
cd cloud
pnpm exec wrangler secret put ADMIN_SECRET         # e.g. openssl rand -base64 32
pnpm exec wrangler secret put EXPO_ACCESS_TOKEN    # only if Expo push security is on
pnpm exec wrangler deploy
```

The first deploy creates the `Inbox` class from the `v1` migration. Keep the admin secret in a password manager; nothing else needs it.

## Tokens

```sh
export APOLLO_CLOUD_URL=https://apollo-cloud.<account>.workers.dev
export APOLLO_CLOUD_ADMIN_SECRET=...

node cloud/cli.ts create producer nobara    # prints the token once
node cloud/cli.ts create connector mini
node cloud/cli.ts list
node cloud/cli.ts revoke <id>
```

Phones get `device` tokens from the connector during pairing, not from the CLI.
