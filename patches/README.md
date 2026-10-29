# Native patches

Adapted from T3 Code checkout `08463e2c4`. See [T3-LICENSE](./T3-LICENSE).

- `react-native-screens@4.26.2`: UIKit Mail-style search toolbar, header item stability, and back-gesture fixes. Expo Router 57 passes the toolbar through `unstable_nativeProps.headerConfig`. Screens must build from source.
- `react-native-nitro-modules@0.35.9`: registers the iOS TurboModule provider for React Native 0.86 codegen.
- `expo-paste-input@0.1.15`: the composer's text-change scan only turns attachments with real image data into pasted images. It used to snapshot any attachment, so iOS dictation's placeholder became a blank pasted image. Drop this patch when the native composer replaces `TextInputWrapper`.

This patch and the local renderer modules require a native rebuild. Review upstream changes and repeat renderer checks before removing or rebasing the patch.
