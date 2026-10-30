# Upstream Attribution

`app-shortcuts.ts` and `AppShortcuts.tsx` port T3 Code's launcher shortcuts from
`apps/mobile/src/features/shortcuts/appShortcuts.ts` and `useAppShortcuts.ts`
at commit `0fcd5f9061`, including the `expo-quick-actions` plugin config from
`apps/mobile/app.config.ts`.

T3 Code only enables them on Android. Apollo enables them on iOS too (SF Symbol
icons), keys threads by agent and session instead of environment and thread,
carries structured params instead of an `href`, stores recents in AsyncStorage,
and routes "New thread" to the agent of the latest recent thread, else the
first paired agent. Taps wait for agents and recents to load.

T3 Code is Copyright (c) 2026 T3 Tools Inc. and licensed under the MIT License
included as `T3CODE_LICENSE`.
