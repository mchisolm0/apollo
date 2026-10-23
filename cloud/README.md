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

## Store reviews

A cron (every 15 minutes) pulls App Store and Google Play reviews for the apps in `REVIEW_APPS` (`wrangler.jsonc`) into `reviews` cards. Replying on a card posts the reply to the store right away; a store outage retries on the next run. Play only lists reviews from the last 7 days, and caps replies at 350 characters. A review's card settles 30 days after the review was written or last edited; an edit after that doesn't reopen it.

```sh
node cloud/cli.ts create producer store-reviews --source reviews   # prints the token once
pnpm exec wrangler secret put REVIEWS_TOKEN            # that token
pnpm exec wrangler secret put ASC_ISSUER_ID            # App Store Connect > Users and Access > Integrations
pnpm exec wrangler secret put ASC_KEY_ID               # a Team key with the Customer Support role
pnpm exec wrangler secret put ASC_PRIVATE_KEY < AuthKey_XXXX.p8
pnpm exec wrangler secret put GOOGLE_SERVICE_ACCOUNT < service-account.json
```

The Google service account needs the Android Publisher API enabled in its Cloud project, and an invite in Play Console (Users and permissions) with "Reply to reviews" for each app. Either store can be left out; its secrets just stay unset.
