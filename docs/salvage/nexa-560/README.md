# NEXA-560 — paperclip worktrees found under the trading clone's worktree dir

Thirteen entries in `/home/jjude/development/nexa-worktrees` were not worktrees
of the trading clone; their `.git` files pointed at
`/home/jjude/development/paperclip/.git/worktrees/...`. They are preserved here
so they could be removed from disk without losing working-tree bytes or
local-only commits.

Layout and method are identical to the trading repository's
`salvage/nexa-worktrees-20261024` branch: `README.md`, `commits.patch`,
`dirty.patch`, `untracked/` per source worktree under `paperclip/`.

The source branches remain in `/home/jjude/development/paperclip`; nothing here
is merged.
