// The `worktree` environment: each card gets `git worktree add` in this plugin's data folder, on a new branch
// (or a named one). CanvasTTY keeps the ref and the PTY; this only prepares, wraps (sets the folder), resumes,
// describes and releases. Grown from CanvasTTY's examples/plugins/env-worktree; the ref also records the commit the
// worktree started from, which "Collect changes" uses as the base.
import { execFile } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const git = async (cwd, ...args) => (await run("git", ["-C", cwd, ...args], { timeout: 10_000 })).stdout.trim();

/**
 * A worktree folder of this plugin: a direct child of `root` that, when it exists, is a real folder (no link, not
 * reached through one). A lexical prefix alone would let a link placed inside the data folder point anywhere.
 */
export function ownedWorktreeFolder(root, value) {
  const dir = typeof value === "string" ? resolve(value) : "";
  const refuse = () => { throw new Error("This worktree does not belong to the plugin."); };
  if (!dir || dirname(dir) !== root) refuse();
  let info;
  try { info = lstatSync(dir); } catch (error) { if (error.code === "ENOENT") return dir; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(dir) !== join(realpathSync(root), basename(dir))) refuse();
  return dir;
}

/** Throws unless `dir` is a worktree git lists for `repo` (the repository the ref names), checked by real paths. */
export async function registeredWorktree(repo, dir) {
  const listing = await git(repo, "worktree", "list", "--porcelain", "-z").catch(() => "");
  const real = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
  const wanted = real(dir);
  const listed = listing.split("\0").filter((line) => line.startsWith("worktree ")).map((line) => real(line.slice("worktree ".length)));
  if (!listed.includes(wanted)) throw new Error("This worktree is not one of its repository's worktrees.");
}

export function createWorktreeEnvironment({ dataDir }) {
  const root = resolve(dataDir, "worktrees");

  /** Only folders this plugin created are ever touched, whatever a saved ref says. */
  function owned(ref) {
    return { ...ref, dir: ownedWorktreeFolder(root, ref?.dir) };
  }

  return {
    async prepare({ sessionId, cwd, options = {} }) {
      const repo = await git(cwd, "rev-parse", "--show-toplevel").catch(() => null);
      if (!repo) return { refuse: { reason: `${cwd} is not inside a git repository.` } };
      const base = await git(repo, "rev-parse", "--verify", "-q", "HEAD^{commit}").catch(() => null);
      if (!base) return { refuse: { reason: `${repo} has no commit yet; commit once before starting a worktree.` } };
      const branch = String(options.branch ?? "").trim() || `canvastty/${String(sessionId).slice(0, 8)}`;
      if (!await git(repo, "check-ref-format", "--branch", branch).catch(() => null)) {
        return { refuse: { reason: `${branch} is not a valid branch name.` } };
      }
      const dir = join(root, `${basename(repo)}-${String(sessionId).slice(0, 8)}`);
      const exists = await git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).then(() => true, () => false);
      try {
        await git(repo, "worktree", "add", "--quiet", ...(exists ? [dir, branch] : ["-b", branch, dir]));
      } catch (error) {
        return { refuse: { reason: `git worktree add failed: ${String(error.stderr || error.message).trim().slice(0, 200)}` } };
      }
      const started = await git(dir, "rev-parse", "HEAD");
      // The card's folder inside the repository (git reports real paths, so compare real paths).
      const inside = relative(repo, realpathSync(cwd));
      const sub = inside.startsWith("..") ? "" : inside;
      return { ref: { repo, dir, branch, createdBranch: !exists, sub, base: started }, label: `worktree ${branch}`, cwd: join(dir, sub) };
    },

    async resume({ ref }) {
      const { dir } = owned(ref);
      if (!existsSync(dir)) return { stopped: { reason: `The worktree folder ${dir} no longer exists.` } };
      const inside = await git(dir, "rev-parse", "--is-inside-work-tree").catch(() => "");
      return inside === "true" ? { ok: true } : { stopped: { reason: `${dir} is no longer a git worktree.` } };
    },

    wrap({ ref, command, args }) {
      const { dir, sub } = owned(ref);
      // Same program and arguments; only the folder changes.
      return { command, args, cwd: join(dir, sub ?? "") };
    },

    async release({ ref, keepData }) {
      if (keepData) return {};
      const { repo, dir, branch, createdBranch } = owned(ref);
      if (typeof repo !== "string") throw new Error("This worktree does not belong to the plugin.");
      await registeredWorktree(repo, dir);
      await git(repo, "worktree", "remove", "--force", dir);
      if (createdBranch) await git(repo, "branch", "-D", branch).catch(() => undefined);
      return {};
    },

    async describe({ ref }) {
      const { dir } = owned(ref);
      const branch = await git(dir, "rev-parse", "--abbrev-ref", "HEAD").catch(() => ref.branch);
      return { label: `worktree ${branch}`, detail: dir };
    },

    /** For "Collect changes": the worktree folder and the commit it started from, after the ownership check. */
    owned
  };
}
