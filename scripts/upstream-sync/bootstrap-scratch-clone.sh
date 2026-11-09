#!/usr/bin/env bash
# Create a scratch clone for the upstream fork-sync replay.
#
# The clone is deliberately outside the shared checkout: the shared checkout
# carries uncommitted recovery/heartbeat edits that a merge replay must not
# touch. Remotes are asymmetric on purpose:
#   - fork      : fetch and push (the only remote that may ever be pushed)
#   - upstream  : fetch only; its push URL is disabled so a stray `git push`
#                 cannot land on paperclipai/paperclip.
#
# Usage:
#   scripts/upstream-sync/bootstrap-scratch-clone.sh [target-dir] [options]
#
# Options:
#   --fork-url <url>      default https://github.com/jjude80/paperclip.git
#   --upstream-url <url>  default https://github.com/paperclipai/paperclip.git
#   --branch <name>       default sync/upstream-2026-11-09
#   --no-branch           configure remotes only; do not create the branch
#
# Exit codes: 0 ok, 2 usage/preflight failure, 3 git clone/fetch failure.

set -euo pipefail

FORK_URL="https://github.com/jjude80/paperclip.git"
UPSTREAM_URL="https://github.com/paperclipai/paperclip.git"
BRANCH="sync/upstream-2026-11-09"
CREATE_BRANCH=1
TARGET=""

usage() {
  sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --fork-url) FORK_URL="${2:?--fork-url requires a value}"; shift 2 ;;
    --upstream-url) UPSTREAM_URL="${2:?--upstream-url requires a value}"; shift 2 ;;
    --branch) BRANCH="${2:?--branch requires a value}"; shift 2 ;;
    --no-branch) CREATE_BRANCH=0; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) [ -z "$TARGET" ] || { echo "target directory given twice" >&2; exit 2; }; TARGET="$1"; shift ;;
  esac
done

if [ -z "$TARGET" ]; then
  echo "usage: $0 <target-dir> [options]" >&2
  exit 2
fi
if [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
  echo "refusing to use non-empty target: $TARGET" >&2
  exit 2
fi
if [ "$FORK_URL" = "$UPSTREAM_URL" ]; then
  echo "fork and upstream URLs must differ" >&2
  exit 2
fi

echo "[bootstrap] cloning $FORK_URL -> $TARGET"
if ! git clone --no-tags "$FORK_URL" "$TARGET"; then
  echo "[bootstrap] clone failed" >&2
  exit 3
fi
cd "$TARGET"

git remote add upstream "$UPSTREAM_URL"
# Fetch-only upstream: a disabled push URL makes accidental pushes fail loudly.
git remote set-url --push upstream "DISABLED-upstream-is-fetch-only"

echo "[bootstrap] fetching $UPSTREAM_URL master"
if ! git fetch --no-tags upstream master; then
  echo "[bootstrap] upstream fetch failed" >&2
  exit 3
fi
git fetch --no-tags origin master

if [ "$CREATE_BRANCH" -eq 1 ]; then
  if [ "$BRANCH" = "master" ] || [ "$BRANCH" = "main" ]; then
    echo "refusing to create an integration branch named $BRANCH" >&2
    exit 2
  fi
  git checkout -B "$BRANCH" --no-track origin/master
fi

echo
echo "[bootstrap] remotes"
git remote -v
echo
echo "[bootstrap] fork master        $(git rev-parse --short origin/master)"
echo "[bootstrap] upstream master    $(git rev-parse --short upstream/master)"
echo "[bootstrap] merge base         $(git merge-base origin/master upstream/master)"
read -r ahead behind < <(git rev-list --count --left-right origin/master...upstream/master | awk '{print $1" "$2}')
echo "[bootstrap] fork ahead/behind  ${ahead}/${behind}"
echo "[bootstrap] branch             $(git symbolic-ref --quiet --short HEAD || echo '<detached>')"
echo
echo "[bootstrap] next: node scripts/upstream-sync/replay-upstream-sync.mjs --plan"
