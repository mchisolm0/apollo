/** Only a completed user scroll or an explicit jump may resume live following. */
export function followAfterScroll(current: boolean, event: 'begin' | 'end' | 'layout' | 'jump', atEnd: boolean): boolean {
  if (event === 'begin') return false;
  if (event === 'jump') return true;
  if (event === 'end') return atEnd;
  return current;
}

/** Follow content and viewport measurements only while the reader is pinned to the end. */
export function feedFollowOptions(following: boolean) {
  return following ? { on: { dataChange: true, itemLayout: true, layout: true } } : false;
}
