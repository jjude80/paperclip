#!/usr/bin/env bash
# Make a fresh checkout, or a tree created with `git worktree add`, able to run
# the test suite.
#
# NEXA-722. The workspace packages build into `dist/`, and every `dist/` is
# gitignored. `pnpm install` lays out `node_modules` but compiles nothing, so a
# new worktree fails before the first test runs with:
#
#   Error: Failed to resolve entry for package "@paperclipai/plugin-sdk".
#   The package may have incorrect main/module/exports specified in its package.json.
#
# That message names the package's `package.json`, so it reads like a broken
# exports map or like the diff under review broke the build. It is neither: the
# package has simply never been built in this tree. Roughly seven of eight
# server suites fail on that one import chain, and their red says nothing about
# the change being verified.
#
# This script runs the two steps a fresh tree needs, both idempotent:
#
#   1. `pnpm install --frozen-lockfile`, only when this tree has no usable
#      install (no `vitest`, no `typescript`).
#   2. `pnpm --filter @paperclipai/plugin-sdk ensure-build-deps`, the same
#      fingerprint-cached build the root `test:run*` scripts already run. It
#      compiles `@paperclipai/shared` and `@paperclipai/plugin-sdk`, the
#      workspace packages whose exports resolve into `dist/`.
#
# It never invokes git, so it also works in a worktree whose git metadata the
# current user cannot read.
#
# Usage:
#   scripts/worktree-bootstrap.sh [--offline] [--skip-install]
#
#   --offline       pass --offline to pnpm install (warm pnpm store, no network)
#   --skip-install  never install dependencies; only ensure the build outputs
#
# Exit: 0 the tree can run the suite, 1 bootstrap failed, 2 bad usage.
set -euo pipefail

usage() {
  sed -n 's/^# \{0,1\}//p' "$0" | sed -n '/^Usage:/,/^Exit:/p'
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
offline=0
skip_install=0

for arg in "$@"; do
  case "$arg" in
    --offline) offline=1 ;;
    --skip-install) skip_install=1 ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "worktree-bootstrap: unknown option: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

cd "$repo_root"

if [[ ! -f package.json || ! -f pnpm-lock.yaml ]]; then
  echo "worktree-bootstrap: $repo_root is not a Paperclip workspace (no package.json + pnpm-lock.yaml)" >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "worktree-bootstrap: pnpm is not on PATH; install the pnpm version named by packageManager and re-run" >&2
  exit 1
fi

# `vitest` and `typescript` are what the two steps below actually need, so a
# partial install (`--prod`, an interrupted run) counts as not installed.
install_needed=0
[[ -x node_modules/.bin/vitest ]] || install_needed=1
[[ -f node_modules/typescript/bin/tsc ]] || install_needed=1

if [[ "$skip_install" -eq 1 ]]; then
  install_needed=0
fi

if [[ "$install_needed" -eq 1 ]]; then
  install_args=(--frozen-lockfile)
  [[ "$offline" -eq 1 ]] && install_args=(--offline --frozen-lockfile)
  echo "worktree-bootstrap: installing dependencies: pnpm install ${install_args[*]}"
  pnpm install "${install_args[@]}"
else
  echo "worktree-bootstrap: dependencies already installed"
fi

if [[ ! -f node_modules/typescript/bin/tsc ]]; then
  echo "worktree-bootstrap: TypeScript is missing from node_modules; run pnpm install (drop --skip-install) first" >&2
  exit 1
fi

echo "worktree-bootstrap: building workspace packages that resolve into dist/"
pnpm --filter @paperclipai/plugin-sdk ensure-build-deps

echo "worktree-bootstrap: ready; npx vitest run server/src/__tests__/<suite>.test.ts now resolves workspace packages"
