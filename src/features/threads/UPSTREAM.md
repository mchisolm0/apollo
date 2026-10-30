# Upstream Attribution

Thread swipe-to-settle/snooze, snooze presets, and the undo notice port T3 Code
at commit `0fcd5f9061`:

- `src/features/relay/snooze-presets.ts` ports `resolveSnoozePresets` from
  `packages/client-runtime/src/state/threadSettled.ts` (In 1 hour, In 3 hours,
  This evening, Tomorrow 9 AM, Next week Monday 9 AM), returning unix seconds
  for Apollo's local snooze ledger instead of ISO strings.
- `custom-snooze-sheet.tsx` follows `apps/mobile/src/features/threads/CustomSnoozeSheet*.tsx`,
  keeping only the date-and-time mode with `@expo/ui`'s `DateTimePicker`.
- `src/features/relay/undo-toast.tsx` follows `apps/web/src/hooks/showThreadUndoNotice.ts`
  (5 second Undo after Settled/Snoozed). Apollo shows one notice at a time instead
  of grouping consecutive actions.
- Row swipes in `src/features/relay/session-list.tsx` follow
  `apps/mobile/src/features/home/thread-swipe-actions.tsx`. T3 shows Settle and a
  Snooze menu on the same side; Apollo settles on a left swipe and snoozes on a
  right swipe.

T3 Code is Copyright (c) 2026 T3 Tools Inc. and licensed under the MIT License
included as `T3CODE_LICENSE`.
