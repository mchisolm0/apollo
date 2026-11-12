#!/bin/sh
# PROTOTYPE. Exact refuses sources outside the app folder and symlinks, so Apollo's pure modules
# are copied into apollo/, mirroring the repo layout so their relative imports resolve. The only
# rewrite is session-inbox.ts's `@/lib` barrel, which pulls in React. Rerun after editing them.
set -e
cd "$(dirname "$0")/.."
rm -rf apollo
for f in \
  src/features/relay/transcript.ts src/features/relay/activity.ts src/features/relay/types.ts \
  src/features/relay/session-inbox.ts src/features/cloud/card-text.ts src/features/cloud/cards.ts \
  src/features/cloud/inbox-rows.ts src/lib/run-state.ts src/lib/types.ts src/lib/attachments.ts \
  src/lib/endpoint.ts cloud/src/contract.ts; do
  mkdir -p "apollo/$(dirname "$f")"
  cp "../../$f" "apollo/$f"
done
sed -i '' "s#from '@/lib'#from '../../lib/types.ts'#" apollo/src/features/relay/session-inbox.ts
# Exact refuses ambient time in data code, so Date.now() defaults read a clock app.ts sets from
# the time the view passes in.
cat > apollo/clock.ts <<'TS'
let current = 0;
export const clockNow = () => current;
export const setClock = (ms: number) => { current = ms; };
TS
for f in apollo/src/features/relay/session-inbox.ts apollo/src/features/cloud/inbox-rows.ts; do
  sed -i '' 's/Date\.now()/clockNow()/g' "$f"
  printf "import { clockNow } from '../../../clock.ts';\n%s\n" "$(cat "$f")" > "$f"
done
