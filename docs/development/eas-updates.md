# Builds, versions, and OTA updates

Apollo uses fingerprint runtimes and EAS-managed native build numbers, following Scryve's setup.

| App | Build profile | EAS environment | Update channel | Bundle ID / Android package | URL scheme |
| --- | --- | --- | --- | --- | --- |
| Apollo Dev | `development:device` | `development` | `apollo-dev` | `com.matthewchisolm.apollo.dev` | `apollo-dev` |
| Apollo Preview | `preview:device` | `preview` | `preview` | `com.matthewchisolm.apollo.preview` | `apollo-preview` |
| Apollo | `production` or `production:internal` | `production` | `production` | `com.matthewchisolm.apollo` | `apollo` |

Each app has separate pairing and draft storage. Preview is a Release build that runs without Metro. It now installs alongside Apollo Dev instead of replacing it. Production internal builds use the production identity and update channel.

## First build

Build and install a new binary for each target before using this update setup. Existing installations cannot acquire their native channel or update configuration through an OTA update.

```sh
pnpm build:ios:preview
pnpm build:android:preview
pnpm build:ios:production
pnpm build:android:production
```

For internal iOS distribution with the production identity, use `pnpm build:ios:internal`. Internal iOS devices must be provisioned. Production builds use store distribution; building does not submit them to a store.

## Publish an update

```sh
pnpm update:preview --message "Describe the change"
pnpm update:production --message "Describe the change"
```

These commands publish both platforms. Add `--platform ios` or `--platform android` to target one. Review on preview first, then publish the same source revision to production with its own command. The app identities produce different runtimes, so publish separately for each variant.

The scripts select both `APOLLO_APP_VARIANT` and the matching EAS environment. Build profiles supply the same variant. Do not set a conflicting `APOLLO_APP_VARIANT` in EAS environment variables. SDK 57 update exports use the selected EAS environment; configure any required app variables there.

Launch the installed app online to download a compatible update, then close and reopen it to apply it. The app does not force a reload during a task. An update with a different fingerprint will not load in that binary. Build and install a new binary when native inputs change.

## Fingerprints and versions

`app.json` uses the `fingerprint` runtime policy for every variant. `fingerprint.config.js` skips package scripts and `.gitignore`, matching Scryve. JavaScript-only changes, documentation, and script edits can share an existing native runtime. Native dependencies, Expo plugins, permissions, and other native configuration remain fingerprint inputs.

The root `package.json` also contains `enriched-markdown` options that control native compilation. The fingerprint explicitly includes that block. Do not ignore the entire package file or native dependency sources.

The user-facing version remains in `app.json`, currently `1.0.0`. Bump it intentionally for store releases and keep the root package version in sync. EAS stores native `buildNumber` and `versionCode` remotely and increments them for production builds, including production internal builds. Preview and development do not auto-increment. OTA publishing does not increment a native build number. If the store already has a higher build number than EAS, initialize it with `eas build:version:set` before the next store build.

See Expo's [fingerprint configuration](https://docs.expo.dev/versions/v57.0.0/sdk/fingerprint/), [app version management](https://docs.expo.dev/build-reference/app-versions/), and [EAS environment usage](https://docs.expo.dev/eas/environment-variables/usage/).

## Local development

For local iteration, use `pnpm ios:dev` once after native changes, then `pnpm start:dev` for Metro and Fast Refresh.

For Metro over Tailscale, start it with a tailnet-reachable advertised host:

```sh
REACT_NATIVE_PACKAGER_HOSTNAME=mini pnpm start:dev
```

Tailscale must be running and connected before this command. On the phone, open `http://mini:8085` in the development client. This installed development build permits the short local hostname; its App Transport Security policy rejected the full MagicDNS name and Tailscale IP in the simulator. Use a separate localhost Metro port for simulator checks when the Mac's short-name DNS resolves elsewhere. A localhost hostname override makes Expo advertise `127.0.0.1` in the manifest even when the phone connects through MagicDNS. On a phone, that bundle address points at the phone itself. After correcting the server hostname, use the development client's Go home action and open the server again to replace the cached bundle URL.

Use `pnpm update:dev --message "Describe the change"` to publish to the dedicated `apollo-dev` channel for compatible development clients.
