#!/usr/bin/env node
// NEXA-882: classify and resolve the server/ slice of an in-progress stage merge.
//
// Run inside the scratch clone while the replay has left a stage merge in
// progress (replay-upstream-sync.mjs exits 3 and writes the full ledger).
//
//   node scripts/upstream-sync/resolve-server-conflicts.mjs            # report only
//   node scripts/upstream-sync/resolve-server-conflicts.mjs --apply    # take upstream for mechanical candidates
//   node scripts/upstream-sync/resolve-server-conflicts.mjs --apply --json > stage-notes.json
//
// Classification (NEXA-882 triage, see the issue's server-conflict-inventory):
//   semantic   = a post-snapshot fork commit touched the path, OR the fork blob
//                still carries a NEXA-* marker. A human must re-apply the fork
//                behaviour on top of upstream; this tool never takes a side.
//   mechanical = neither of the above. The fork side is the previous sync
//                snapshot, so the upstream side is taken and the result is
//                recorded for the stage notes.
//
// Safety: refuses to run outside a merge, only touches paths under --prefix,
// never commits, and leaves semantic conflicts unmerged so the stage cannot
// advance by accident.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const apply = has('--apply');
const json = has('--json');
const prefix = valueOf('--prefix', 'server/');
const snapshot = valueOf('--snapshot', '13ac9450');
const forkTip = valueOf('--fork-tip', 'origin/master');

const git = (gitArgs, opts = {}) =>
  execFileSync('git', gitArgs, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });

function fail(message, code = 2) {
  if (json) process.stdout.write(JSON.stringify({ ok: false, error: message }) + '\n');
  else process.stderr.write(`resolve-server-conflicts: ${message}\n`);
  process.exit(code);
}

try {
  git(['rev-parse', '--show-toplevel']);
} catch {
  fail('not inside a git worktree');
}

let mergeHead;
try {
  mergeHead = git(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).trim();
} catch {
  fail('no merge in progress (MERGE_HEAD absent); run the replay until it exits 3 first');
}
for (const [flag, ref] of [['--snapshot', snapshot], ['--fork-tip', forkTip]]) {
  try {
    git(['rev-parse', '-q', '--verify', `${ref}^{commit}`]);
  } catch {
    fail(`${flag} ref not found: ${ref}`);
  }
}

const unmerged = git(['diff', '--name-only', '--diff-filter=U', '-z'])
  .split('\0')
  .filter(Boolean)
  .filter((path) => path.startsWith(prefix));

// One log walk and one grep instead of two git processes per conflicted path.
// `git log --name-only` with an empty format prints only the changed paths.
const touchedLines = git([
  'log',
  '--no-merges',
  '--format=',
  '--name-only',
  `${snapshot}..${forkTip}`,
  '--',
  prefix,
])
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);
const forkTouched = new Set(touchedLines);

let markedOutput = '';
try {
  markedOutput = git(['grep', '-l', '-E', 'NEXA-[0-9]+', forkTip, '--', prefix]);
} catch (error) {
  // git grep exits 1 when there are no matches; that is a valid empty set.
  if (error.status !== 1) throw error;
}
const markedLines = markedOutput.split('\n').filter(Boolean);
const forkMarked = new Set(
  markedLines.map((line) => line.slice(line.indexOf(':') + 1)),
);

const mechanical = [];
const semantic = [];
for (const path of unmerged) {
  const touched = forkTouched.has(path);
  const marked = forkMarked.has(path);
  if (touched || marked) {
    semantic.push({
      path,
      reason: touched ? 'post-snapshot-fork-commit' : 'fork-nexa-marker',
    });
  } else {
    mechanical.push({ path });
  }
}

const taken = [];
if (apply && mechanical.length > 0) {
  // `git checkout --theirs` fails for a modify/delete conflict where upstream
  // deleted the path (no stage 3). Read the unmerged index once and split the
  // mechanical set into "take upstream content" and "take upstream deletion".
  const indexEntries = git(['ls-files', '-u', '-z', '--', prefix]).split('\0').filter(Boolean);
  const stagesByPath = new Map();
  for (const entry of indexEntries) {
    // format: "<mode> <object> <stage>\t<path>"
    const tab = entry.indexOf('\t');
    const stage = entry.slice(0, tab).trim().split(/\s+/)[2];
    const path = entry.slice(tab + 1);
    if (!stagesByPath.has(path)) stagesByPath.set(path, new Set());
    stagesByPath.get(path).add(stage);
  }

  const takeContent = [];
  const takeDeletion = [];
  for (const entry of mechanical) {
    const stages = stagesByPath.get(entry.path) ?? new Set();
    if (stages.has('3')) takeContent.push(entry);
    else takeDeletion.push(entry);
  }

  // Chunk the git calls; argv limits are far below this.
  const chunk = 80;
  for (let i = 0; i < takeContent.length; i += chunk) {
    const paths = takeContent.slice(i, i + chunk).map((entry) => entry.path);
    git(['checkout', '--theirs', '--', ...paths]);
    git(['add', '--', ...paths]);
  }
  for (let i = 0; i < takeDeletion.length; i += chunk) {
    const paths = takeDeletion.slice(i, i + chunk).map((entry) => entry.path);
    git(['rm', '-f', '--', ...paths]);
  }

  const markerRe = /NEXA-\d+/g;
  for (const entry of takeContent) {
    const result = readFileSync(entry.path, 'utf8');
    taken.push({
      path: entry.path,
      takenFrom: 'upstream',
      resultNexaMarkers: (result.match(markerRe) ?? []).length,
    });
  }
  for (const entry of takeDeletion) {
    taken.push({ path: entry.path, takenFrom: 'upstream-deletion', resultNexaMarkers: 0 });
  }
}

const remaining = git(['diff', '--name-only', '--diff-filter=U', '-z'])
  .split('\0')
  .filter(Boolean)
  .filter((path) => path.startsWith(prefix));

const result = {
  ok: true,
  mode: apply ? 'apply' : 'report',
  prefix,
  mergeHead,
  snapshot,
  forkTip,
  serverConflicts: unmerged.length,
  mechanical: mechanical.map((entry) => entry.path),
  semantic,
  taken,
  remainingServerConflicts: remaining,
};

if (json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
else {
  process.stdout.write(
    `server conflicts: ${unmerged.length} (mechanical ${mechanical.length}, semantic ${semantic.length})\n`,
  );
  if (apply) {
    process.stdout.write(`took upstream for ${taken.length} mechanical paths\n`);
  } else if (mechanical.length > 0) {
    process.stdout.write('mechanical candidates (rerun with --apply to take upstream):\n');
    for (const entry of mechanical) process.stdout.write(`  ${entry.path}\n`);
  }
  if (semantic.length > 0) {
    process.stdout.write('semantic conflicts, resolve by hand (fork behaviour):\n');
    for (const entry of semantic) {
      process.stdout.write(`  ${entry.path}  [${entry.reason}]\n`);
    }
  }
  if (remaining.length > 0) {
    process.stdout.write(`remaining unmerged server paths: ${remaining.length}\n`);
  }
}

// A dry run is informative and always succeeds. An apply run that still has
// semantic conflicts exits 3 so the replay cannot treat the stage as resolved.
process.exit(apply && remaining.length > 0 ? 3 : 0);
