// The `worktree` environment: each card gets `git worktree add` in this plugin's data folder, on a new branch
// (or a named one). CanvasTTY keeps the ref and the PTY; this only prepares, wraps (sets the folder), resumes,
// describes and releases. Grown from CanvasTTY's examples/plugins/env-worktree; the ref also records the commit the
// worktree started from, which "Collect changes" uses as the base.
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const git = async (cwd, ...args) => (await run("git", ["-C", cwd, ...args], { timeout: 10_000 })).stdout.trim();

export function createWorktreeEnvironment({ dataDir }) {
  const root = resolve(dataDir, "worktrees");

  /** Only folders this plugin created are ever touched, whatever a saved ref says. */
  function owned(ref) {
    const dir = typeof ref?.dir === "string" ? resolve(ref.dir) : "";
    if (!dir.startsWith(root + sep)) throw new Error("This worktree does not belong to the plugin.");
    return { ...ref, dir };
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
