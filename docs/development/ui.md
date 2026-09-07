# Ekho UI

Direction A uses true black, white primary text, white primary actions and blue links, system type, quiet progress disclosures, and controls near the thumb.

Use relay-ui.tsx for colors, type/spacing tokens, RelayHeader, IconButton, RelayButton and form inputs. Headers share icon size, hit targets, and typography. Thread titles use a compact fixed header with the machine and status beneath. User messages align right on a dark bubble; assistant replies retain the full reading width. Use session-list.tsx for the full-screen thread inbox; keep search, section collapsing and row actions there. Keep run projection and inbox ordering out of visual components.

Session navigation uses the native stack in `(sessions)/_layout.tsx`. The index is the full-width thread inbox; threads push onto it and Back to threads dismisses to that inbox. Pairing and settings remain on the root stack. The inbox uses already-loaded sessions, with no navigation-time fetch. Needs you includes approvals and unread results, Open includes idle conversations, and Finished uses the existing explicit settle ledger. Finishing a thread does not stop a run.

Runtime sessions live in memory. AsyncStorage persists drafts and the read/settle ledgers. Ordinary transcript changes preserve inbox row identities. Add another persistence engine only after a measured storage bottleneck.

Native action sheets expose secondary session actions; swipe and accessibility actions provide alternate access. Settings must scroll and wrap values at larger text sizes. Assistant content uses Enriched Markdown. A compatible native build is required; Metro cannot install native views. Rebuild the development client after adding or changing native dependencies.

Run typecheck, lint and test:mobile before the focused test-ekho-mobile pass. See mobile-performance.md for the distinction between projection guards and device frame-time measurements.

Markdown follows treatment A: 16/24 body text, 16pt paragraph spacing, quieter inline code, 13/21 fenced code on #151517, and a muted syntax palette. Syntax colors have at least 5.99:1 contrast against that background. Use the installed native highlighter and configured language subset; do not add a JS parser per streamed update. Enriched Markdown owns the code-block copy header, which has no public hide/style override in the installed version.

Keyboard resizing preserves the transcript reading position. Follow-to-end runs for new data and item layout changes, not viewport layout changes. Keep approvals above the composer and retain editable drafts while offline. Pairing errors dismiss the keyboard and scroll to the recovery action.

The inbox has floating filter, search, and compose controls at the bottom. Use the existing native GlassView on supported iOS versions, with a dark solid fallback elsewhere. Agent switching stays in the top header. Finished rows use muted, smaller titles without previews; larger accessibility text can wrap.

Tool groups show the first three calls plus every running or failed call. Each row expands independently into selectable details; Show all reveals the rest. Disclosures suspend automatic following so reading tool output does not jump to the bottom. Keep tool names and preview text tied to the received data.

Sending the first message promotes the current new-thread route with setParams. Keep Session and RunScreen mounted while the ID changes so the composer and keyboard stay in place. Move the draft to the created thread key before updating the route parameters.
