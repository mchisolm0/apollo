import { ActionSheetIOS, Alert, Platform } from 'react-native';

type Action = { label: string; onPress: () => void };

/** Use the system action sheet for secondary actions, including screen-reader access. */
export function showSessionActions(title: string, actions: readonly Action[]) {
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions({ title, options: [...actions.map((action) => action.label), 'Cancel'], cancelButtonIndex: actions.length }, (index) => actions[index]?.onPress());
  } else {
    Alert.alert(title, undefined, [...actions.map((action) => ({ text: action.label, onPress: action.onPress })), { text: 'Cancel', style: 'cancel' }]);
  }
}
