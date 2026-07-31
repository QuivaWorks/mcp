#!/bin/sh
# Read a file from myevari/evari-olympus without cloning it.
#
#   engine/fetch.sh workspaces-service/handler/tasks.go
#   engine/fetch.sh hub-service/handler/agents.go | sed -n '380,460p'
#   engine/fetch.sh records-service/model/api.go main
#
# Defaults to the main branch; pass a branch, tag or sha as the second argument.
# Requires the `gh` CLI authenticated with read access to the repository (any
# member of the myevari org has it).
#
# This is the intended way for an agent working in THIS repo to answer a
# spec-vs-engine question. Nearly every gotcha encoded here is a SILENT failure
# — the API returns 200 and does nothing — which cannot be found by probing the
# API from outside. Someone has to read the handler.

set -e

REPO="${ENGINE_REPO:-myevari/evari-olympus}"
PATH_IN_REPO="$1"
REF="${2:-main}"

if [ -z "$PATH_IN_REPO" ]; then
  echo "usage: engine/fetch.sh <path-in-repo> [ref]" >&2
  echo "" >&2
  echo "Cited paths (what this repo makes claims about):" >&2
  echo "  node engine/sync.mjs --list" >&2
  exit 64
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "engine/fetch.sh requires the gh CLI: https://cli.github.com" >&2
  exit 69
fi

# --raw gives the file bytes directly; the contents API would base64-encode them
# and silently cap out at 1 MB.
gh api "repos/$REPO/contents/$PATH_IN_REPO?ref=$REF" \
  -H 'Accept: application/vnd.github.raw' 2>/dev/null && exit 0

echo "Could not read $PATH_IN_REPO at $REPO@$REF." >&2
echo "Either the path has moved (run: node engine/sync.mjs) or your gh token" >&2
echo "lacks read access to $REPO." >&2
exit 1
