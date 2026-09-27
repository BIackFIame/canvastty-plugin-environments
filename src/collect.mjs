// Collect changes: the work an agent did in a worktree or on a server ends up in ONE place, the person's local
// repository, as a new local branch `canvastty/<first 8 of the card id>-<slug of the title>` based on the commit the
// agent started from. Nothing is merged, and the person's current branch and working tree are never touched:
// collection only adds a branch.
//
// - On a server: over ssh, a temporary commit of the remote working tree (tracked and untracked files, .gitignore
//   respected, credential files left out) is made with a temporary index, streamed back as a `git bundle` on stdout
//   and fetched into the new local branch. The temporary index folder and ref are removed on the server; nothing is
//   written there outside the repository's own object store.
// - In a worktree: the worktree shares the local repository, so its working tree is committed the same way (its own
//   HEAD and index stay as they are) and the branch points at that commit.
//
// Ported from the CanvasTTY chain (L31 ChangeCollection), unchanged in behaviour except for the time budget.
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCredentialPath } from "./credentials.mjs";
import { sshBatchArgs, shellQuote } from "./hosts.mjs";

/** A collection the same request cannot pass on retry: not a Git folder, unrelated history, committed credentials… */
export class CollectionRefusal extends Error {}

const MAX_INSPECT_BYTES = 32 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
const MAX_ANCESTORS = 256;
const COMMIT = /^[0-9a-f]{40,64}$/u;
const COMMIT_MESSAGE = "CanvasTTY: collected working tree of an agent";

// Every script starts here: no inherited Git location, no prompts, no optional locks, and none of the repository's
// own commands (fsmonitor, hooks, filter drivers) run while the plugin reads or commits an agent's folder: the agent
// could have configured them.
const PRELUDE = String.raw`set -u
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_NAMESPACE GIT_CONFIG_PARAMETERS
export GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 GIT_LFS_SKIP_SMUDGE=1 LC_ALL=C
g() { git -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.untrackedCache=false -c submodule.recurse=false -c core.quotepath=false "$@"; }
cd -- "$1" 2>/dev/null || { echo 'CTTY_ERR no-folder' >&2; exit 3; }
if ! top=$(g rev-parse --show-toplevel 2>&1); then
  case $top in *"dubious ownership"*) echo 'CTTY_ERR unsafe-owner' >&2;; *) echo 'CTTY_ERR not-git' >&2;; esac
  exit 4
fi
cd -- "$top" || exit 3
filters=$(g config --name-only --get-regexp '^filter\.' 2>/dev/null | sed -E 's/\.[^.]*$//' | sort -u)
n=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  for k in clean smudge process; do eval "GIT_CONFIG_KEY_$n=\$f.$k GIT_CONFIG_VALUE_$n="; export "GIT_CONFIG_KEY_$n" "GIT_CONFIG_VALUE_$n"; n=$((n+1)); done
  eval "GIT_CONFIG_KEY_$n=\$f.required GIT_CONFIG_VALUE_$n=false"; export "GIT_CONFIG_KEY_$n" "GIT_CONFIG_VALUE_$n"; n=$((n+1))
done <<CTTY_FILTERS
$filters
CTTY_FILTERS
export GIT_CONFIG_COUNT=$n
head=$(g rev-parse --verify -q 'HEAD^{commit}') || { echo 'CTTY_ERR no-commit' >&2; exit 5; }
`;

/** $1 folder. Prints HEAD's recent commits (newest first), a "--" line, then the NUL-separated paths a commit of the
 *  working tree would change: tracked changes against HEAD and untracked files .gitignore does not hide. */
export const INSPECT = PRELUDE + String.raw`g rev-list --max-count=${MAX_ANCESTORS} "$head" || exit 6
echo --
g diff --name-only --no-renames -z "$head" -- || exit 6
g ls-files -z --others --exclude-standard || exit 6
`;

/** $1 folder, $2 base commit, $3 temporary ref, $4 "bundle" or "tip"; stdin: NUL-separated pathspecs for `git add`.
 *  Commits the working tree with a temporary index (HEAD and the agent's own index stay), then prints the byte length
 *  of the changed-path list, the NUL-separated list (base..tip) and either the bundle (base..tip) or the tip commit. */
export const COLLECT = PRELUDE + String.raw`base=$2 ref=$3
work=$(mktemp -d "${"${TMPDIR:-/tmp}"}/canvastty-collect.XXXXXX") || exit 7
trap 'rm -rf "$work"; g update-ref -d "$ref" >/dev/null 2>&1' EXIT
trap 'exit 1' HUP INT TERM
g merge-base --is-ancestor "$base" "$head" || { echo 'CTTY_ERR base-moved' >&2; exit 8; }
GIT_INDEX_FILE=$work/index g read-tree "$head" || exit 9
GIT_INDEX_FILE=$work/index g add -A --pathspec-from-file=- --pathspec-file-nul || exit 9
tree=$(GIT_INDEX_FILE=$work/index g write-tree) || exit 9
if [ "$tree" = "$(g rev-parse "$head^{tree}")" ]; then tip=$head
else tip=$(GIT_AUTHOR_NAME=CanvasTTY GIT_AUTHOR_EMAIL=canvastty@localhost GIT_COMMITTER_NAME=CanvasTTY GIT_COMMITTER_EMAIL=canvastty@localhost g commit-tree "$tree" -p "$head" -m '${COMMIT_MESSAGE}') || exit 9
fi
[ "$tip" != "$base" ] || { echo 'CTTY_NOTHING' >&2; exit 10; }
g diff --name-only --no-renames -z "$base" "$tip" -- > "$work/paths" || exit 9
wc -c < "$work/paths" | tr -d ' '
cat "$work/paths"
if [ "$4" = tip ]; then echo "$tip"; exit 0; fi
g update-ref "$ref" "$tip" || exit 9
g bundle create --quiet - "$ref" "^$base" || exit 11
`;

const REFUSALS = {
  "no-folder": "The agent's folder no longer exists there.",
  "not-git": "The agent's folder is not a Git repository, so its changes cannot be collected (only Git working copies are collected, never arbitrary files).",
  // Git itself refuses a repository another user owns (safe.directory): its config could run that user's commands.
  "unsafe-owner": "The agent's folder is a Git repository owned by another user than the one ssh connects as, so Git refuses to work in it (safe.directory). Give the folder to that user and collect again.",
  "no-commit": "The agent's repository has no commit yet, so there is no base to collect against.",
  "base-moved": "The agent's repository no longer contains the commit it started from."
};

function refusal(run, what) {
  if (run.timedOut) return new Error(`${what} did not finish in time.`);
  const code = run.stderr.match(/CTTY_ERR ([a-z-]+)/u)?.[1];
  if (code && REFUSALS[code]) return new CollectionRefusal(REFUSALS[code]);
  const detail = run.stderr.replace(/\s+/gu, " ").trim().slice(0, 300);
  return new Error(`${what} failed${detail ? `: ${detail}` : "."}`);
}

/** Runs one script on this computer (`sh -c`); the script gets args as $1…, input on stdin. */
export const localTransport = (script, args, input, timeoutMs) =>
  runProcess("/bin/sh", ["-c", script, "canvastty-collect", ...args], input, timeoutMs, cleanEnvironment());

/** Runs one script on the server over ssh, as the card's own session does, but with key or agent auth only and no tty. */
export function sshTransport(host, { ssh = "ssh" } = {}) {
  return (script, args, input, timeoutMs) => runProcess(ssh,
    sshBatchArgs(host, ["sh", "-c", script, "canvastty-collect", ...args].map(shellQuote).join(" "), 10),
    input, timeoutMs, process.env);
}

function runProcess(command, args, input, timeoutMs, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env });
    const chunks = [];
    let size = 0, stderr = "", over = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, Math.max(1, timeoutMs));
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BUNDLE_BYTES + MAX_INSPECT_BYTES) { over = true; child.kill("SIGKILL"); return; }
      chunks.push(chunk);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { if (stderr.length < 8_192) stderr += chunk; });
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: null, stdout: Buffer.alloc(0), stderr: error.message, timedOut }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: over || timedOut ? null : code, stdout: Buffer.concat(chunks), timedOut,
        stderr: over ? "The agent's changes exceed the collection limit (256 MiB)." : stderr });
    });
    child.stdin.end(input);
  });
}

function cleanEnvironment() {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), GIT_TERMINAL_PROMPT: "0" };
}

/** Git in the person's own repository: only read, or add a new ref; none of its hooks or fsmonitor run. */
function git(cwd, args, { input, timeoutMs = 30_000 } = {}) {
  const command = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.quotepath=false", "-C", cwd, ...args];
  return new Promise((resolve, reject) => {
    const child = execFile("git", command, { env: cleanEnvironment(), timeout: Math.max(1, timeoutMs), maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) => (error ? reject(error) : resolve(stdout)));
    child.stdin?.end(input ?? "");
  });
}

/** The branch a collection names: canvastty/<first 8 of the card id>-<ASCII slug of the title>. */
export function collectionBranchName(sessionId, title) {
  const id = String(sessionId).replace(/[^A-Za-z0-9]/gu, "").slice(0, 8).toLowerCase() || "session";
  const slug = String(title).normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40).replace(/-+$/u, "");
  return `canvastty/${id}${slug ? `-${slug}` : ""}`;
}

async function freeBranch(repository, name) {
  for (let attempt = 1; attempt <= 99; attempt++) {
    const candidate = attempt === 1 ? name : `${name}-${attempt}`;
    try {
      await git(repository, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    } catch {
      await git(repository, ["check-ref-format", "--branch", candidate]);
      return candidate;
    }
  }
  throw new CollectionRefusal(`Branches ${name} … ${name}-99 already exist; delete old collections first.`);
}

async function localRepository(folder) {
  try {
    return (await git(folder, ["rev-parse", "--show-toplevel"])).replace(/\n$/u, "");
  } catch {
    throw new CollectionRefusal(`The project folder on this computer (${folder}) is not a Git repository, so there is no local repository to collect into.`);
  }
}

/** Parses the collect script's output: the changed paths, then the rest (a bundle, or the tip commit). */
function splitCollected(stdout) {
  const newline = stdout.indexOf(10);
  const length = newline > 0 ? Number(stdout.subarray(0, newline).toString("ascii")) : NaN;
  if (!Number.isSafeInteger(length) || length < 0 || newline + 1 + length > stdout.length) throw new Error("The agent's changes arrived incomplete.");
  const paths = stdout.subarray(newline + 1, newline + 1 + length).toString("utf8").split("\0").filter(Boolean);
  return { paths, rest: stdout.subarray(newline + 1 + length) };
}

/** Pathspecs for the commit: everything, except the credential files among the paths it would change. */
function pathspecs(changed) {
  const excluded = [...new Set(changed.filter((path) => isCredentialPath(path)))].sort();
  return { input: Buffer.from([".", ...excluded.map((path) => `:(exclude,literal)${path}`)].join("\0") + "\0", "utf8"), excluded };
}

async function inspect(transport, folder, budget) {
  const run = await transport(INSPECT, [folder], Buffer.alloc(0), budget());
  if (run.code !== 0) throw refusal(run, "Reading the agent's folder");
  if (run.stdout.length > MAX_INSPECT_BYTES) throw new CollectionRefusal("The agent's folder has too many changed files to collect.");
  const text = run.stdout.toString("utf8");
  const separator = text.indexOf("\n--\n");
  if (separator < 0) throw new Error("Reading the agent's folder returned no commit list.");
  const ancestors = text.slice(0, separator).split("\n").filter((line) => COMMIT.test(line));
  if (!ancestors.length) throw new Error("Reading the agent's folder returned no commit list.");
  return { ancestors, changed: text.slice(separator + 4).split("\0").filter(Boolean) };
}

async function summary(repository, base, tip, budget) {
  const commits = Number((await git(repository, ["rev-list", "--count", `${base}..${tip}`], { timeoutMs: budget() })).trim());
  const diffstat = (await git(repository, ["diff", "--stat=100", "--no-color", "--no-ext-diff", base, tip, "--"], { timeoutMs: budget() }))
    .trim().split("\n").slice(-40).join("\n");
  return { commits, diffstat };
}

function refuseCredentials(paths) {
  const found = paths.filter((path) => isCredentialPath(path));
  if (found.length) {
    throw new CollectionRefusal(`The agent committed files that look like credentials (${found.slice(0, 5).join(", ")}${found.length > 5 ? ", …" : ""}); nothing was collected. Remove them from its commits first.`);
  }
}

const budgetFrom = (timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  return () => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error("Collecting did not finish in time.");
    return left;
  };
};

/** A card on a server: bundle its working tree back into a new local branch. */
export async function collectRemote({ sessionId, title, localFolder, remoteFolder, transport, timeoutMs = 120_000 }) {
  const budget = budgetFrom(timeoutMs);
  const repository = await localRepository(localFolder);
  const { ancestors, changed } = await inspect(transport, remoteFolder, budget);
  // The newest commit of the agent's history this repository also has: the agent started there or later.
  const known = await git(repository, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], { input: ancestors.join("\n") + "\n", timeoutMs: budget() });
  const present = new Set(known.split("\n").filter((line) => line.endsWith(" commit")).map((line) => line.split(" ")[0]));
  const base = ancestors.find((commit) => present.has(commit));
  if (!base) {
    throw new CollectionRefusal(`The server's repository shares no commit with ${repository} in its last ${MAX_ANCESTORS} commits; start the card from a clone of this repository, or fetch it by hand.`);
  }
  const { input: specs, excluded } = pathspecs(changed);
  const ref = `refs/canvastty/collect/${String(sessionId).replace(/[^A-Za-z0-9-]/gu, "").slice(0, 64) || "session"}`;
  const run = await transport(COLLECT, [remoteFolder, base, ref, "bundle"], specs, budget());
  if (run.code === 10) {
    return { state: "unchanged", source: "ssh-host", sessionId, repository, base, excluded,
      message: "The folder on the server has no changes against the commit it started from; nothing to collect." };
  }
  if (run.code !== 0) throw refusal(run, "Collecting the changes");
  const { paths, rest: bundle } = splitCollected(run.stdout);
  if (bundle.length > MAX_BUNDLE_BYTES) throw new CollectionRefusal("The changes exceed the collection limit (256 MiB).");
  // Its own commits can hold what the working-tree commit left out: refused before anything is written here.
  refuseCredentials(paths);
  const branch = await freeBranch(repository, collectionBranchName(sessionId, title));
  const temporary = await mkdtemp(join(tmpdir(), "canvastty-collect-"));
  try {
    const file = join(temporary, "changes.bundle");
    await writeFile(file, bundle, { mode: 0o600 });
    const heads = await git(repository, ["bundle", "list-heads", file], { timeoutMs: budget() });
    const tip = heads.split("\n").map((line) => line.split(" ")).find(([, name]) => name === ref)?.[0];
    if (!tip || !COMMIT.test(tip)) throw new Error("The changes arrived without their commit.");
    await git(repository, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-auto-maintenance", file, `${ref}:refs/heads/${branch}`],
      { timeoutMs: budget() });
    return { state: "collected", source: "ssh-host", sessionId, repository, branch, base, head: tip, excluded, ...await summary(repository, base, tip, budget),
      message: `Collected into branch ${branch} (based on ${base.slice(0, 12)}). Nothing was merged; merge it in the project when ready.` };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** A card in a worktree of this repository: commit its working tree (its HEAD and index stay) and name it. */
export async function collectWorktree({ sessionId, title, sourceFolder, worktreeFolder, baseCommit, transport = localTransport, timeoutMs = 120_000 }) {
  const budget = budgetFrom(timeoutMs);
  if (!COMMIT.test(String(baseCommit))) throw new CollectionRefusal("The worktree's starting commit is unknown.");
  const repository = await localRepository(sourceFolder);
  const { changed } = await inspect(transport, worktreeFolder, budget);
  const { input: specs, excluded } = pathspecs(changed);
  const run = await transport(COLLECT, [worktreeFolder, baseCommit, "refs/canvastty/unused", "tip"], specs, budget());
  if (run.code === 10) {
    return { state: "unchanged", source: "worktree", sessionId, repository, base: baseCommit, excluded,
      message: "The worktree has no changes against the commit it started from; nothing to collect." };
  }
  if (run.code !== 0) throw refusal(run, "Collecting the worktree's changes");
  const { paths, rest } = splitCollected(run.stdout);
  const tip = rest.toString("utf8").trim();
  if (!COMMIT.test(tip)) throw new Error("The worktree's changes produced no commit.");
  refuseCredentials(paths);
  try {
    await git(repository, ["cat-file", "-e", `${tip}^{commit}`], { timeoutMs: budget() });
  } catch {
    throw new CollectionRefusal("The worktree does not share this repository's objects; it cannot be collected here.");
  }
  const branch = await freeBranch(repository, collectionBranchName(sessionId, title));
  await git(repository, ["branch", "--no-track", "--", branch, tip], { timeoutMs: budget() });
  return { state: "collected", source: "worktree", sessionId, repository, branch, base: baseCommit, head: tip, excluded,
    ...await summary(repository, baseCommit, tip, budget),
    message: `Collected into branch ${branch} (based on ${baseCommit.slice(0, 12)}). Nothing was merged; merge it in the project when ready.` };
}
