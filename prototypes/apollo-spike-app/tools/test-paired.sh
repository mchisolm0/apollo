#!/bin/sh
# PROTOTYPE. Runs tests/*.test.contract, the paired flows, on an iOS simulator against
# tools/fixture.mjs: re-copies Apollo's shared modules first, starts the fixture unless one is
# already up (restart yours after editing it), and stops the one it started. Extra arguments go to
# `bun exact.mjs test ios` (`--sim <name>`, a single file).
set -e
cd "$(dirname "$0")/.."
sh tools/sync-apollo.sh
up() { curl -sf -o /dev/null http://127.0.0.1:19111/.well-known/apollo/agent; }
if ! up; then
  mkdir -p .exact
  node tools/fixture.mjs > .exact/fixture.log 2>&1 &
  fixture=$!
  trap 'kill $fixture' EXIT
  tries=0
  until up; do
    tries=$((tries + 1))
    [ "$tries" -gt 50 ] && { cat .exact/fixture.log; exit 1; }
    sleep 0.2
  done
fi
case " $* " in
  *.test.contract*) bun exact.mjs test ios "$@" ;;
  *) bun exact.mjs test ios tests/*.test.contract "$@" ;;
esac
