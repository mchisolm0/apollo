/** Only a completed user scroll or an explicit jump may resume live following. */
export function followAfterScroll(current: boolean, event: 'begin' | 'end' | 'layout' | 'jump', atEnd: boolean): boolean {
  if (event === 'begin') return false;
  if (event === 'jump') return true;
  if (event === 'end') return atEnd;
  return current;
}
