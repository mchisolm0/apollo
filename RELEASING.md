# Publishing updates

OTA updates require the same native fingerprint as the installed build. Native
dependencies or configuration changes need a new build first. Each variant has
its own runtime and channel; publish with its existing script.

Set `RELEASE_NOTES` to one note per line when publishing. Notes appear in the
downloaded update's details dialog. The EAS `--message` is internal release
metadata, not the notes shown in the app.

```sh
RELEASE_NOTES=$'Update notices\nNative build information in Settings' pnpm update:dev --message "Update notices"
RELEASE_NOTES=$'Update notices\nNative build information in Settings' pnpm update:preview --message "Update notices"
RELEASE_NOTES=$'Update notices\nNative build information in Settings' pnpm update:production --message "Update notices"
```

These publish to `apollo-dev`, `preview`, and `production`, respectively. Run the
checks and verify a preview build before publishing production. Development
clients connected to Metro skip OTA checks and notices; use a release build to
verify an actual download.

`fingerprint.config.js` excludes the Expo config `extra` section, matching Scryve.
Keep `extra` limited to JavaScript metadata. Release notes do not change the
native fingerprint, and omitting `RELEASE_NOTES` publishes no notes. Adding
`expo-application` and this fingerprint policy requires a new native build
before the first update using this change.
