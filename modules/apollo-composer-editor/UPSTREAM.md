# Upstream attribution

Ported for Apollo from T3 Code's mobile composer editor
(`apps/mobile/modules/t3-composer-editor` and `apps/mobile/src/native/T3ComposerEditor.ios.tsx`,
`composerEditorRevision.ts`) at commit `0fcd5f90611451cca842689faea53b5450c022da`.

T3 Code is Copyright (c) 2026 T3 Tools Inc. and licensed under the MIT License
included as `T3CODE_LICENSE`. `LICENSE` is the Expo module template license T3
ships with the module. Native identifiers keep the `T3ComposerEditor` name so
the port stays easy to audit and update.

Apollo changes:

- iOS only. T3's Android view draws chips with its markdown module's
  `T3ContextChip`, which Apollo's markdown port does not include; Android and
  web use a plain `TextInput`.
- Removed T3 context clipboard fragments (`app.t3.context-fragment`), file
  mention icons, and pull request glyphs. Copy writes the plain serialized text.
- Chips take Apollo's theme (accent blended over the composer surface) and the
  system font.
- Typing past `maxInputChars` is refused, standing in for `TextInput.maxLength`.
- A controlled document that passes the revision guard always applies, echo or not, and a
  re-created view adopts the JS revision. T3 dropped mismatched echoes, which lost a restored
  draft when Fabric coalesced the parent edit with the echo render after it.
- The text view carries the accessibility label and hint, so the editor is not one opaque element.
