# Ekho Dev updates

Ekho Dev uses `com.matthewchisolm.ekho.dev`, the `ekho-dev` URL scheme, and separate pairing and draft storage. Both development:device and preview:device explicitly select this variant. Production build configuration is unchanged.

For local iteration, use `pnpm ios:dev` once after native changes, then `pnpm start:dev` for Metro and Fast Refresh.

For Metro over Tailscale, start it with a tailnet-reachable advertised host:

```sh
REACT_NATIVE_PACKAGER_HOSTNAME=mini pnpm start:dev
```

Tailscale must be running and connected before this command. On the phone, open `http://mini:8085` in the development client. This installed development build permits the short local hostname; its App Transport Security policy rejected the full MagicDNS name and Tailscale IP in the simulator. Use a separate localhost Metro port for simulator checks when the Mac's short-name DNS resolves elsewhere. A localhost hostname override makes Expo advertise `127.0.0.1` in the manifest even when the phone connects through MagicDNS. On a phone, that bundle address points at the phone itself. After correcting the server hostname, use the development client's Go home action and open the server again to replace the cached bundle URL.

For on-device review without Metro:

1. Run `pnpm build:ios:preview` and install the internal Release build. This replaces any existing Ekho Dev installation, not Ekho. The device must be provisioned for internal distribution.
2. Run `pnpm update:dev --message "Describe the change"` to publish to the dedicated `ekho-dev` channel using the development EAS environment.
3. Launch Ekho Dev online to download an update, then close and reopen it to apply it. Default update loading does not force a reload during a task.

The fingerprint runtime policy matches updates to compatible native builds. JavaScript, styles, and assets can update without a rebuild when the native fingerprint is unchanged. Native dependencies, plugins, entitlements, and other fingerprint-changing inputs require a new build. Adding expo-updates itself requires that initial build.

Keep EKHO_APP_VARIANT=development for both builds and updates. The package script supplies it explicitly. Do not override it with a conflicting EAS environment variable. Neither build nor update commands target the production channel.

The configuration is prepared locally. No cloud build or OTA update was published during the visual exploration. Verify download and application on the new installed build before claiming end-to-end update delivery.
