#!/bin/sh
# PROTOTYPE. Exact refuses sources outside the app folder and symlinks, so Apollo's pure
# transcript modules are copied in unchanged. Rerun after editing them in src/.
set -e
cd "$(dirname "$0")/.."
for f in features/relay/transcript.ts features/relay/activity.ts features/relay/types.ts features/cloud/card-text.ts lib/run-state.ts lib/types.ts lib/attachments.ts; do
  mkdir -p "apollo/$(dirname "$f")"
  cp "../../src/$f" "apollo/$f"
done
