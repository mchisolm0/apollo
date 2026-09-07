# EAS iOS device builds and repeated Apple login prompts

Research date: 2026-09-05

## Finding

Answering `n` is not a permanent "never use Apple" setting. The current EAS CLI prints that it may ask again if a later step needs Apple access. In the current source, `CredentialsContext.bestEffortAppStoreAuthenticateAsync()` returns immediately when `nonInteractive` is true, so `--non-interactive` is the right way to prevent the Apple login prompt during a build.

For Ekho, the command to try is:

```sh
EXPO_NO_KEYCHAIN=1 npx eas-cli@latest build \
  --profile development:device \
  --platform ios \
  --non-interactive \
  --freeze-credentials
```

As of this research, `eas-cli@latest` resolves to 23.2.0. Ekho's `eas.json` requires EAS CLI >= 20.2.0, so the current CLI satisfies the project constraint.

`--freeze-credentials` is useful here because it prevents credential updates in non-interactive mode. It does not create missing credentials. If the remote distribution certificate, provisioning profile, or registered device is missing or expired, an Apple-authorized team member must prepare or refresh them first with `eas credentials` or the EAS dashboard.

## What each option actually does

### `n`

Expo documents `n` as the path for a developer who does not have Apple Developer access. The build can continue with the last credentials uploaded to the project's Expo account. The same documentation also says the CLI may ask again if a later step needs Apple access. This explains why `n` can be followed by another Apple prompt.

### `--non-interactive`

The current EAS CLI exposes this flag for `eas build`. Its credential context skips the optional Apple authentication attempt when the flag is set. The build still needs usable signing credentials. Non-interactive mode is not a way to generate a first certificate or add a new device without Apple access.

The older `--skip-credentials-check` flag is hidden and deprecated in the current source. The CLI says credential validation is skipped automatically with `--non-interactive`, so it should not be needed here.

### `EXPO_NO_KEYCHAIN=1`

Expo documents this variable as disabling macOS Keychain support. It controls where an Apple password is stored. It does not disable Apple authentication and does not prevent the prompt. It is harmless in the non-interactive command, but it is not the fix for a prompt caused by answering `n`.

### Reusing credentials

Ekho's `development:device` profile does not set `credentialsSource`, so it uses the EAS default, `remote`. Expo's current guidance says a team member without Apple access can build when an authorized Apple user has already uploaded the distribution certificate and provisioning profile to the organization's Expo project. A physical-device development build also needs a suitable ad hoc provisioning profile containing the device UDID.

If the credentials are available as files instead, `credentialsSource: "local"` and `credentials.json` are supported. That changes where EAS obtains the credentials. It does not make Apple account access unnecessary when a profile or device still needs to be created or refreshed.

## macOS beta relevance

I found a current EAS CLI issue for macOS Tahoe 26 and Xcode 26, but it concerns `eas build --local`, not a cloud build. The reported failure is EAS's temporary-keychain identity check using `security find-identity -v`. The issue explicitly says changing `credentialsSource` does not avoid that local-build code path. The earlier workaround from the previous thread, avoiding `--local`, remains correct.

I found no primary Expo/EAS source tying repeated Apple prompts in a cloud build to macOS 27 beta. Because the Apple login and credential preparation happen in the local CLI before the cloud job starts, a macOS beta can still expose local Keychain or Apple-authentication bugs, but the available evidence does not make it the primary explanation for this exact symptom. The prompt behavior itself is explained by the EAS `n` flow.

## Recommended sequence

1. Confirm that the device is already registered with EAS and that remote iOS credentials exist for the project's bundle identifier. An Apple-authorized team member may need to run `eas device:create` and `eas credentials` once.
2. Run the non-interactive, frozen-credentials command above. Keep `EXPO_NO_KEYCHAIN=1` only if avoiding Keychain access is desirable.
3. If it fails, capture the first credential error. A failure saying credentials are missing, invalid, expired, or that the device is not in the provisioning profile means the setup needs an Apple-authorized refresh. A failure mentioning Keychain or Apple authentication is a separate local CLI issue.
4. Keep using a cloud build. Do not add `--local` on macOS beta while the Tahoe temporary-keychain issue remains relevant.

## Sources

- [Expo: Apple Developer Program roles and permissions for EAS Build](https://docs.expo.dev/app-signing/apple-developer-program-roles-and-permissions/)
- [Expo: Security](https://docs.expo.dev/app-signing/security/)
- [Expo: Using existing credentials](https://docs.expo.dev/app-signing/existing-credentials/)
- [Expo: Using local credentials](https://docs.expo.dev/app-signing/local-credentials/)
- [Expo: EAS CLI reference](https://docs.expo.dev/eas/cli/)
- [EAS CLI current `CredentialsContext` source](https://github.com/expo/eas-cli/blob/main/packages/eas-cli/src/credentials/context.ts)
- [EAS CLI current iOS credential provider source](https://github.com/expo/eas-cli/blob/main/packages/eas-cli/src/credentials/ios/IosCredentialsProvider.ts)
- [EAS CLI current build command source](https://github.com/expo/eas-cli/blob/main/packages/eas-cli/src/commands/build/index.ts)
- [EAS CLI issue: macOS Tahoe local-build keychain identity check](https://github.com/expo/eas-cli/issues/3678)
- [EAS CLI issue: Apple 2FA authentication failures and `EXPO_NO_KEYCHAIN`](https://github.com/expo/eas-cli/issues/2732)
