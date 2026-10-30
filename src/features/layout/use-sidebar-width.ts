import { useWindowDimensions } from 'react-native';

import { sidebarWidth } from './split-layout';

/** The sidebar width for the current window, or undefined on iPhone and narrow iPad windows. */
export function useSidebarWidth() {
  return sidebarWidth(useWindowDimensions());
}
