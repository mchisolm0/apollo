import { ActionSheetIOS, Alert, Platform } from 'react-native';

export type Action = { label: string; onPress: () => void; destructive?: boolean };

/** Use the system action sheet for secondary actions, including screen-reader access. */
export function showSessionActions(title: string, actions: readonly Action[]) {
  if (Platform.OS === 'ios') {
    const destructiveButtonIndex = actions.findIndex((action) => action.destructive);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title,
        options: [...actions.map((action) => action.label), 'Cancel'],
        cancelButtonIndex: actions.length,
        ...(destructiveButtonIndex >= 0 ? { destructiveButtonIndex } : {}),
      },
      (index) => actions[index]?.onPress(),
    );
  } else {
    Alert.alert(title, undefined, [
      ...actions.map((action) => ({
        text: action.label,
        style: (action.destructive ? 'destructive' : 'default') as 'destructive' | 'default',
        onPress: action.onPress,
      })),
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  }
}

export interface ThreadMenuSession {
  title: string;
  pinned?: boolean;
  settled?: boolean;
  snoozed?: boolean;
}

export interface ThreadMenuHandlers {
  onOpen(): void;
  onSettle?(): void;
  onReopen?(): void;
  onSnooze?(): void;
  onUnsnooze?(): void;
  onRegenerateTitle?(): void;
  onPin?(pinned: boolean): void;
  onDelete?(): void;
  onFork?(): void;
}

/** Thread menu (t3code parity). Snooze is a local-only ledger entry; the rest are backend-backed. */
export function threadMenuActions(session: ThreadMenuSession, handlers: ThreadMenuHandlers): Action[] {
  const actions: Action[] = [{ label: 'Open thread', onPress: handlers.onOpen }];
  if (session.settled ? handlers.onReopen : handlers.onSettle) {
    actions.push(session.settled
      ? { label: 'Reopen', onPress: () => handlers.onReopen?.() }
      : { label: 'Settle', onPress: () => handlers.onSettle?.() });
  }
  if (!session.settled) {
    if (session.snoozed ? handlers.onUnsnooze : handlers.onSnooze) {
      actions.push(session.snoozed
        ? { label: 'Unsnooze', onPress: () => handlers.onUnsnooze?.() }
        : { label: 'Snooze', onPress: () => handlers.onSnooze?.() });
    }
  }
  if (handlers.onRegenerateTitle) actions.push({ label: 'Regenerate title', onPress: handlers.onRegenerateTitle });
  if (handlers.onPin) {
    const pinned = session.pinned ?? false;
    actions.push({ label: pinned ? 'Unpin' : 'Pin', onPress: () => handlers.onPin?.(!pinned) });
  }
  if (handlers.onFork) actions.push({ label: 'New thread on branch', onPress: handlers.onFork });
  if (handlers.onDelete) {
    const onDelete = handlers.onDelete;
    actions.push({
      label: 'Delete',
      destructive: true,
      onPress: () => Alert.alert('Delete thread?', `"${session.title}" will be permanently removed.`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: onDelete },
      ]),
    });
  }
  return actions;
}

/** One-call menu for call sites that already resolved their handlers. */
export function showThreadMenu(session: ThreadMenuSession, handlers: ThreadMenuHandlers) {
  showSessionActions(session.title, threadMenuActions(session, handlers));
}
