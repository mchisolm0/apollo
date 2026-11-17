#!/usr/bin/env bash
# Model-checks Approvals.tla and Steers.tla. Every app run must pass, every
# break must fail on the rule it names, which proves that rule can still catch
# a bug, and every gap must keep failing until the app closes it.
# Usage: check.sh            run everything (under a minute)
#        check.sh <run>      one run, with its full TLC output
set -euo pipefail
cd "$(dirname "$0")"

TLC_VERSION=1.7.4
TLC_SHA256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
jar="${XDG_CACHE_HOME:-$HOME/.cache}/apollo/tla2tools-$TLC_VERSION.jar"
if [ ! -f "$jar" ]; then
  mkdir -p "$(dirname "$jar")"
  curl -fsSL -o "$jar.part" \
    "https://github.com/tlaplus/tlaplus/releases/download/v$TLC_VERSION/tla2tools.jar"
  mv "$jar.part" "$jar"
fi
got=$({ sha256sum "$jar" 2>/dev/null || shasum -a 256 "$jar"; } | awk '{print $1}')
[ "$got" = "$TLC_SHA256" ] ||
  { echo "tla2tools.jar checksum mismatch: $jar" >&2; exit 2; }

approvals='Requests={r1,r2} AtOnce=FALSE Away=FALSE'
steers='A=A B=B AB=AB MaxSteers=4 OnTime=TRUE'

# name | spec | bounds | flags turned off | expected: pass, or the rule that must fail
runs="
answers       | Approvals | $approvals                    |                  | pass
away          | Approvals | ${approvals/Away=FALSE/Away=TRUE} |              | pass
blind         | Approvals | $approvals                    | AnswersById      | AnswerMatches
stale-cards   | Approvals | $approvals                    | ClosesStaleCards | CardsCurrent
two-at-once   | Approvals | ${approvals/AtOnce=FALSE/AtOnce=TRUE} |          | PendingVisible
steers        | Steers    | $steers                       |                  | pass
delete-start  | Steers    | $steers                       | KeepsUncertain   | KeepsStarted
no-reread     | Steers    | $steers                       | RereadsHistory   | UndeliveredExact
count-rows    | Steers    | $steers                       | CountsLines      | UndeliveredExact
no-since      | Steers    | $steers                       | UsesSince        | UndeliveredExact
late-reply    | Steers    | ${steers/OnTime=TRUE/OnTime=FALSE} |             | UndeliveredExact
"
flags() { case $1 in
  Approvals) echo "AnswersById ClosesStaleCards" ;;
  Steers) echo "KeepsUncertain RereadsHistory CountsLines UsesSince" ;;
esac; }
rules() { case $1 in
  Approvals) echo "AnswerMatches PendingVisible CardsCurrent" ;;
  Steers) echo "KeepsStarted UndeliveredExact" ;;
esac; }

run() { # name spec bounds off expected [verbose]
  local cfg meta out
  meta=$(mktemp -d) && cfg="$meta/run.cfg"
  {
    echo CONSTANTS
    echo "  NONE = NONE"
    for kv in $3; do echo "  ${kv/=/ = }"; done
    for f in $(flags "$2"); do
      [[ " $4 " == *" $f "* ]] && echo "  $f = FALSE" || echo "  $f = TRUE"
    done
    echo "SPECIFICATION Spec"
    echo "INVARIANTS $(rules "$2")"
  } >"$cfg"
  out=$(java -XX:+UseParallelGC -cp "$jar" tlc2.TLC -config "$cfg" -deadlock \
    -workers auto -metadir "$meta/states" "$2.tla" 2>&1 || true)
  rm -rf "$meta"
  [ -n "${6:-}" ] && echo "$out"
  local got
  if grep -q "Model checking completed. No error has been found." <<<"$out"; then got=pass
  else got=$(sed -n 's/^Error: Invariant \([A-Za-z]*\) is violated.*/\1/p' <<<"$out" | head -1)
  fi
  local states
  states=$(sed -n 's/.* \([0-9,]*\) distinct states found.*/\1/p' <<<"$out" | tail -1)
  if [ "$got" = "$5" ]; then printf 'ok    %-13s %-16s %s states\n' "$1" "$got" "$states"
  else printf 'FAIL  %-13s expected %s, got %s\n' "$1" "$5" "${got:-an error}"; return 1
  fi
}

status=0 matched=
while IFS='|' read -r name spec bounds off expected; do
  name=$(xargs <<<"$name"); [ -z "$name" ] && continue
  [ -n "${1:-}" ] && [ "$1" != "$name" ] && continue
  matched=1
  run "$name" "$(xargs <<<"$spec")" "$bounds" "$(xargs <<<"$off")" "$(xargs <<<"$expected")" "${1:-}" || status=1
done <<<"$runs"
[ -n "$matched" ] || { echo "no run named ${1:-}" >&2; exit 2; }
exit $status
