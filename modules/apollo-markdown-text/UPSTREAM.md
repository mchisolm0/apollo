# Upstream Attribution

The Fabric attributed-text component in this module originated from
[`bluesky-social/react-native-uitextview`](https://github.com/bluesky-social/react-native-uitextview),
version `2.2.0`, commit `addc08fea303608f070fe1eeba4bc075f181c4af`.

The upstream project is Copyright (c) 2024-25 Bluesky PBC and licensed under
the MIT License included in this directory.

T3 Code has substantially modified and renamed the implementation, integrated
its markdown renderer, and owns the resulting module going forward. This is not
an upstream package dependency or a compatibility fork.

Apollo ported that T3 Code module at commit
`08463e2c401ce87858aaaebcb70ed86fb002fb5f`. T3 Code's MIT license is included
as `T3CODE_LICENSE`. Native identifiers retain the `T3MarkdownText` name so the
port remains easy to audit and update.

`src/pendingCodeHighlight.ts` and its test come from T3 Code commit
`7bd7f99e6cab940892ff9240549c507bfd066aee`
(`apps/mobile/modules/t3-markdown-text/src/pendingCodeHighlight.ts`). Apollo
wires it into `useHighlightedCode` in `NativeMarkdownBlock.ios.tsx` without
T3's synchronous `read` path, since Apollo's Prism highlighter is async only.
