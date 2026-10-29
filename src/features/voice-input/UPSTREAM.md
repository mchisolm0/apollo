# Upstream Attribution

Ported from T3 Code at commit `960d5761c13f68a2f10635bcd26489a5fa404ec1`. T3 Code's MIT license is included as `T3CODE_LICENSE`. Identifiers keep T3's names so the port stays easy to audit and update.

- `controller.ts`, `transcription.ts`: `packages/client-runtime/src/voice-input`. `replaceTextRange` is inlined from `packages/shared/src/composerTrigger.ts`.
- `voiceInputMetering.ts`, `voiceInputPresentation.ts`: copied from `apps/mobile/src/features/voice-input`.
- `voiceInputSession.ts`, `lazyVoiceRecorder.ts`, `VoiceInputProvider.tsx`, `useVoiceInputController.ts`, `ComposerDictationControl.tsx`: trimmed from the same folder.
- `src/native/voiceTranscription.ios.ts` and `.ts`: copied from `apps/mobile/src/native`.
- `patches/@react-native-ai__apple@0.12.0.patch`: copied from T3's `patches/`.

Apollo's differences:

- No `GlobalVoiceInputControl` pill. A composer that unmounts, switches thread, or gives way to an approval card discards its dictation.
- The session is a lazy module singleton instead of an Effect atom, with no microphone priority preferences, shared audio-session registry, or showcase scene.
- The draft has no revision counter. The editor is read-only while recording, so a changed text is the staleness check.
- `ComposerDictationControl` uses Apollo's StyleSheet theme instead of Tailwind classes and drops the compact waveform and Android control sizing.
