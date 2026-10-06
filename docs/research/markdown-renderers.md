# React Native Markdown renderer research

Research date: 2026-09-05. Sources are upstream repositories and package documentation. Version claims are time-sensitive; the versions below are the versions visible in the checked sources.

## What Apollo and T3 Code do today

Apollo currently uses `react-native-enriched-markdown` `^1.0.2` in [package.json](../../package.json), with GitHub flavor, selectable text, an HTTP(S)-only link handler, and native image/code styles in [message-content.tsx](../../src/features/relay/message-content.tsx). Enriched Markdown was selected after this comparison. The temporary plain-text compatibility fallback has been removed; development clients must contain the native renderer.

The current T3 Code mobile source at commit [`f8b4c464b4760d73e0ece7e68011c738803d8b69`](https://github.com/pingdotgg/t3code/tree/f8b4c464b4760d73e0ece7e68011c738803d8b69) is more specialized than any of these general packages. Its mobile package uses `react-native-nitro-markdown` plus a local `modules/t3-markdown-text` native module, `@legendapp/list`, Shiki, and custom link/media adapters. [ThreadFeed.tsx](https://github.com/pingdotgg/t3code/blob/f8b4c464b4760d73e0ece7e68011c738803d8b69/apps/mobile/src/features/threads/ThreadFeed.tsx) renders assistant messages inside `KeyboardAwareLegendList`; the Markdown component is a row child, and fixed heights are supplied only for known chrome rows while message rows remain measured/estimated. It splits Codex artifact-template directives into separate native views, rewrites file citations to ordinary Markdown for native rendering, and supplies custom image/link handlers. This is a useful architecture reference, but its Nitro module is not a drop-in choice for Apollo.

## Candidate comparison

| Renderer | Runtime and native build | Markdown, links, images, code | Streaming and lists | Fit for Apollo |
|---|---|---|---|---|
| [`react-native-enriched-markdown`](https://github.com/software-mansion/react-native-enriched-markdown) 1.0.x | C++/native Fabric renderer using md4c; supports iOS, Android, macOS and a WebAssembly web path. Native platforms require New Architecture. Expo requires `expo prebuild` and a rebuilt custom client; it does not work in Expo Go. Install-time `postinstall` downloads code-highlighting grammars and optional iOS RaTeX assets; pnpm must allow the build script. The upstream compatibility table marks 1.0.0 compatible with RN 0.83-0.87 and incompatible with 0.82. | CommonMark plus GFM flavor: tables, task lists, strikethrough, headings, lists, blockquotes and fenced code. Native selectable text/copy, link press/long press, image press, image caching and native copy-image-URL actions are documented. Code highlighting is tree-sitter based and feature/language selection is build-time. | Core component has native streaming-related props; upstream recommends `react-native-streamdown` for token-by-token input. Streamdown repairs partial Markdown with `remend` and can process off-JS with Worklets Bundle Mode. GFM tables and code blocks have progressive/hidden modes. It is a single Markdown view (GitHub flavor splits block views internally), so the app still owns message-level virtualization. | Best fit for the existing Apollo direction and current RN 0.86/New Architecture setup, subject to rebuilt-client validation. Its native build and install assets are the main operational cost. |
| [`react-native-marked`](https://github.com/gmsgowtham/react-native-marked) 8.2.0 | JavaScript renderer powered by `marked.js`; package declares peer RN `>=0.76` and `react-native-svg >=12.3`, and asks users to install both. The repository contains platform directories/podspec for packaging, but its renderer is JS/React components and has no documented custom Markdown native view or New Architecture requirement. No prebuild/native asset download is documented. | Supports headings, paragraphs, emphasis/strikethrough, links, images, blockquotes, inline/fenced code, ordered/unordered lists, rules and tables. HTML is treated as plain text. Relative links can use `baseUrl`; default handlers call `Linking.openURL`. Custom renderer/hooks allow custom image and code components/highlighters. | The `<Markdown>` component renders parsed elements through an underlying `FlatList`; `flatListProps` exposes list tuning while reserving data/renderItem/horizontal. `useMarkdown` returns elements for a caller-owned list. No streaming option is documented, so each changing value reparses/rerenders in JS unless the app adds its own buffering. | Lowest native integration risk and has built-in virtualization, but JS parsing and React tree work are likely more expensive for long, frequently changing assistant messages. A credible fallback if native rebuild constraints dominate. |
| [`markdown-to-jsx`](https://github.com/quantizor/markdown-to-jsx) 9.10.2 (npm latest on research date) | React package (`react` peer `>=16`) with a `/native` entry point that maps Markdown to core React Native `View`, `Text`, `Image` and `Pressable`. No native module, Fabric requirement or Expo prebuild is documented. | GFM/CommonMark toolchain. Native entry supports styles, link press/long press, images, tables, task checkboxes, custom overrides and `renderRule`; dangerous HTML tags and unsafe URL schemes are filtered by default. Fenced code gets a `codeBlock` AST node; syntax highlighting must be supplied by `renderRule`/an override. | `optimizeForStreaming` suppresses incomplete emphasis, code, links, HTML and tables while content is incomplete. This is a JS parser/compiler option, not off-JS parsing. It has no built-in list; caller must put the resulting element in `FlatList`/LegendList and must decide message/block granularity. | Most flexible JS escape hatch and easiest to customize, but the app owns both performance and code highlighting. Good for a controlled prototype or fallback, not a proven native chat renderer. |

## Native and Expo implications

For Apollo's Expo SDK 57 / RN 0.86.3 app, enriched-markdown's published compatibility table is favorable for 1.0.x, and Apollo already has the package configuration disabling math and narrowing highlight languages. The relevant build sequence is install (including assets), `expo prebuild`, CocoaPods/native build, then a custom dev client or release build. Changing feature flags requires the corresponding reinstall and native rebuild; iOS applies the configuration at `pod install`. A JS bundle refresh cannot create the missing native view, which explains why a guard/fallback is useful during development.

The other two candidates avoid that native module step, but this is a trade: their Markdown parse, AST-to-React work, and block layout execute in JS and produce many React Native elements. They can run in Expo Go, but that does not establish acceptable frame time for a long streaming transcript.

## Selection, links, images and code

Enriched Markdown is the only candidate here whose documented text selection and copy behavior is native by design. Its `selectable` prop, per-platform selection menus, copy-as-Markdown and copy-image-URL behavior map closely to a chat transcript. `onLinkPress` receives `{ url }`; image taps have a separate callback, except an image inside a link preserves link behavior. Apollo currently supplies a stricter HTTP(S) handler, which should remain regardless of renderer.

Marked and markdown-to-jsx both render normal React Native primitives. Marked's default `onLinkPress` calls `Linking.openURL`, and its renderer can be replaced for a FastImage or code highlighter. Markdown-to-jsx exposes `onLinkPress`, `onLinkLongPress`, typed native styles, and overrides/render rules. Neither package supplies the native text-selection system that enriched-markdown documents, so selectable behavior should be verified on device rather than inferred from `Text` nesting.

All three represent Markdown images as remote URLs. A production chat needs an image policy independent of the parser: URL scheme validation, request/auth headers where needed, bounded dimensions, caching, tap-to-preview, and behavior for failed loads. T3 Code's source explicitly separates Markdown URL classification from image/video preview and passes a custom `renderMarkdownImage`, which is a sound seam for Apollo.

## Streaming and virtualization

There are two separate update problems: parsing a growing message and virtualizing many messages. A renderer's streaming option addresses only the first. The outer transcript should remain a virtualized list of message rows, with one stable key per message and a bounded update cadence (for example, coalesce token updates per animation frame or 30-60 Hz). Replacing the complete Markdown string on every token can still invalidate measurement and rerender the visible row.

T3 Code's implementation is evidence of the needed separation: `KeyboardAwareLegendList` owns the transcript; Markdown is inside a row; message heights are measured/estimated, while fixed sizes are used only for truly fixed rows. It also splits block-like artifacts out of Markdown so large native blocks do not get forced into a single text node. `react-native-marked`'s internal `FlatList` virtualizes parsed blocks within each Markdown value, but nesting one list per chat message is a design to measure carefully. Markdown-to-jsx gives no list and leaves all virtualization to the app. Enriched-markdown does not claim to virtualize messages; use it as the row renderer inside Apollo's existing feed.

## Isolated parser benchmark

I ran a small Node-only benchmark in a temporary directory (`/tmp`, outside the repository) on 2026-09-05. The reproducible harness is [`markdown-renderer-benchmark.mjs`](./markdown-renderer-benchmark.mjs), and its raw output is [`markdown-renderer-benchmark.json`](./markdown-renderer-benchmark.json). It generated the same 16,108-byte document for each run: 80 headings, paragraphs with bold/link/image syntax, lists, TypeScript fences and GFM tables. After 10 warmups, 30 timed iterations were measured with `performance.now()` on Node 24.19.0.

| Operation | Median | p95 | Minimum |
|---|---:|---:|---:|
| `marked@18.0.11` lexer | 0.973 ms | 1.185 ms | 0.803 ms |
| `markdown-to-jsx@9.10.2` parser | 0.279 ms | 0.385 ms | 0.232 ms |

These are parser-only timings from one Node 24.19 process. They are not a ranking of renderer performance: the operations return different AST representations and do not include React reconciliation, Yoga/layout, image loading, syntax highlighting, accessibility, selection, or incremental update behavior. I did not claim a comparable enriched-markdown number because its important parser/render path is native and the package's native assets were not installed for this isolated experiment.

To reproduce without changing Apollo's dependencies, copy the script into a temporary directory, install `marked@18.0.11`, `markdown-to-jsx@9.10.2`, and `react@19.2.3` there, then run `node markdown-renderer-benchmark.mjs`. The script measures Node's parser path, not React Native's Hermes engine.

## Measurement plan before choosing

Use one Expo custom release build of Apollo and test each candidate in the same screen, device, OS build, font scale, color scheme, and list settings. Keep a fixture corpus with (a) short prose, (b) a 100-200 KB code-heavy answer, (c) 100 messages with mixed blocks, (d) a 10-second token stream, (e) tables and nested lists, (f) links/images including failed loads, and (g) selectable text.

Record at least:

1. Cold mount time and time-to-first-visible-content for one message.
2. JS parse/compiler duration per update, JS FPS, UI FPS, dropped frames and commit count during a token stream.
3. Peak/steady RSS and JS heap where tooling exposes them, plus image cache/network bytes.
4. Scroll p50/p95 frame time while flinging through 100 mixed messages, blank/incorrect rows, and height correction count.
5. Number of React/native views mounted at rest and while scrolling, and visible-row rerender count.
6. Functional checks for link routing, image preview/failure, code language handling, tables, selection/copy and accessibility.

Run 5 cold and 10 warm repetitions per fixture, report median and p95, and publish raw traces plus device/build metadata. Compare the same outer list and update cadence across candidates. Parser-only results should remain labeled parser-only; the decision should be based on device traces and functional behavior.

## Sources

- [Apollo package.json](../../package.json) and [current message renderer](../../src/features/relay/message-content.tsx)
- [T3 Code mobile package](https://github.com/pingdotgg/t3code/blob/f8b4c464b4760d73e0ece7e68011c738803d8b69/apps/mobile/package.json) and [ThreadFeed](https://github.com/pingdotgg/t3code/blob/f8b4c464b4760d73e0ece7e68011c738803d8b69/apps/mobile/src/features/threads/ThreadFeed.tsx)
- [Enriched Markdown README](https://github.com/software-mansion/react-native-enriched-markdown/blob/main/packages/react-native-enriched-markdown/README.md), [Text docs](https://github.com/software-mansion/react-native-enriched-markdown/blob/main/docs/TEXT.md), [API reference](https://github.com/software-mansion/react-native-enriched-markdown/blob/main/docs/API_REFERENCE.md), [native assets](https://github.com/software-mansion/react-native-enriched-markdown/blob/main/docs/NATIVE_ASSETS.md), [streaming](https://github.com/software-mansion/react-native-enriched-markdown/blob/main/docs/MARKDOWN_STREAMING.md)
- [react-native-marked README](https://github.com/gmsgowtham/react-native-marked/blob/main/README.md), [package manifest](https://github.com/gmsgowtham/react-native-marked/blob/main/package.json), [performance fixture](https://github.com/gmsgowtham/react-native-marked/blob/main/src/lib/__perf__/Markdown.perf-test.tsx)
- [markdown-to-jsx README](https://github.com/quantizor/markdown-to-jsx/blob/main/README.md), [package manifest](https://github.com/quantizor/markdown-to-jsx/blob/main/package.json)
