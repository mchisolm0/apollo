# Native patches

Adapted from T3 Code checkout `08463e2c4`, rebased for Expo SDK 58 alongside T3's `8dc07f199c`. See [T3-LICENSE](./T3-LICENSE).

- `react-native-screens@4.30.1`: UIKit Mail-style search toolbar, header item stability, and back-gesture fixes. Expo Router 58 passes the toolbar through `unstable_nativeProps.headerConfig`. Screens must build from source. T3 has since moved to its own Screens 5 fork without Expo Router, so this patch now tracks the Screens version Expo 58 bundles.
- `react-native-nitro-modules@0.35.9`: registers the iOS TurboModule provider for React Native codegen and accepts the `CallInvoker` that React Native 0.87+ passes when installing JSI bindings.
- `expo-paste-input@0.1.15`: the composer's text-change scan only turns attachments with real image data into pasted images. It used to snapshot any attachment, so iOS dictation's placeholder became a blank pasted image. Drop this patch when the native composer replaces `TextInputWrapper`.
- `@react-native-ai/apple@0.12.0`: from T3 Code `960d5761c1`. On-device transcription waits for every final segment before resolving (upstream could resolve an empty or partial transcript), `prepare` resolves the supported locale, and unsupported locales reject with their own code.

These patches and the local renderer modules require a native rebuild. Review upstream changes and repeat renderer checks before removing or rebasing the patch.
