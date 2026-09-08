# Ekho UI

The thread inbox and chat use a Discord-inspired layout with true black, white primary text, muted gray controls, blue links and violet agent avatars.

Use relay-ui.tsx for colors, type/spacing tokens, RelayHeader, IconButton, RelayButton and form inputs. Headers share icon size, hit targets, and typography. Thread titles use a compact fixed header with the machine and status beneath. Messages align left with an avatar and author name. User text and assistant Markdown share the same reading column. Use session-list.tsx for the full-screen thread inbox; keep search, section collapsing and row actions there. Keep run projection and inbox ordering out of visual components.

Session navigation uses the native stack in `(sessions)/_layout.tsx`. The index is the full-width thread inbox; threads push onto it and Back to threads dismisses to that inbox. Pairing and settings remain on the root stack. The inbox uses already-loaded sessions, with no navigation-time fetch. Needs you includes approvals and unread results, Open includes idle conversations, and Finished uses the existing explicit settle ledger. Finishing a thread does not stop a run.

Runtime sessions live in memory. AsyncStorage persists drafts and the read ledger. The connector persists settle timestamps shared by paired devices through `/v1/inbox`; they refresh on connection and foreground. Existing local settle entries import only when the server has no entry, including no reopen tombstone. New activity after the saved timestamp reopens a thread. Update the connector before using server-backed settle actions. Ordinary transcript changes preserve inbox row identities. Add another persistence engine only after a measured storage bottleneck.

Native action sheets expose secondary session actions; swipe and accessibility actions provide alternate access. Settings must scroll and wrap values at larger text sizes. Assistant content uses Enriched Markdown. A compatible native build is required; Metro cannot install native views. Rebuild the development client after adding or changing native dependencies.

Run typecheck, lint and test:mobile before the focused test-ekho-mobile pass. See mobile-performance.md for the distinction between projection guards and device frame-time measurements.

Markdown follows treatment A: 16/24 body text, 16pt paragraph spacing, quieter inline code, 13/21 fenced code on #151517, and a muted syntax palette. Syntax colors have at least 5.99:1 contrast against that background. Use the installed native highlighter and configured language subset where a grammar exists. Enriched Markdown owns the code-block copy header, which has no public hide/style override in the installed version.

Keyboard resizing preserves the transcript reading position. Follow-to-end runs for new data and item layout changes, not viewport layout changes. Keep approvals above the composer and retain editable drafts while offline. Pairing errors dismiss the keyboard and scroll to the recovery action.

The inbox has compact channel rows with a hash mark and single-line titles. Search, filter and new-thread controls sit directly below the agent header. Eligible open threads have a subtle Settle text button with a 44-point touch target, separate from the padded thread-opening target. Finish/reopen actions also remain available through swipe, long press and accessibility actions. Large accessibility text wraps titles.

Tool groups collapse to one activity row by default. Running activity names the current tool; failures remain explicit. Expanding a group reveals individual calls and selectable details. Disclosures suspend automatic following so reading tool output does not jump to the bottom.

Perl, pl and pearl code fences use a Perl-only Prism fallback because the native renderer has no Perl grammar. Other Markdown and supported code languages stay native. The fallback recognizes enclosing fences and highlights incomplete streamed Perl blocks.

Sending the first message promotes the current new-thread route with setParams. Keep Session and RunScreen mounted while the ID changes so the composer and keyboard stay in place. Move the draft to the created thread key before updating the route parameters.

Accepted sends appear before credential persistence completes. History reconciliation rejects older snapshots with fewer user messages, including snapshots received after the local message ID has been acknowledged. The Runs event stream connects immediately. New sessions request a Luna title through the connector in the background; an unavailable Codex leaves the initial title intact.

Disconnected Hermes streams are consumed, so the client closes SSE retries and polls status/history. Once durable history matches the completed run output and timestamp, it replaces stale live progress even if the terminal event was lost.

The composer stays one line, with a tail-truncated placeholder. Its plus button has a 44-point touch target; message text starts 52 points from the field edge. Thread press feedback includes the row's horizontal and vertical padding, including long presses.

Attachments use the system Photos or Files picker. Up to four files, 10 MiB each, can be added, previewed, and removed before sending. Drafts keep private local copies across navigation and relaunch. Upload failures preserve the draft, and successful uploads are reused on a send retry. Sending an attachment without text is supported. Sent images load from the authenticated connector; document names and sizes appear in the transcript. The connector and Hermes must share a filesystem because the Runs API receives the uploaded file paths. Image understanding depends on Hermes's image-reading tool.

Adding `expo-image-picker` and the direct `expo-file-system` dependency requires rebuilding the development client. An OTA update alone is insufficient for this change.
