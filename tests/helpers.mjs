import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], {
  encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" }
}).trim();

export async function temp(t, prefix) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), `ctty-env-${prefix}-`)));
  t.after(() => execFileSync("rm", ["-rf", dir]));
  return dir;
}

/** A local repository with one commit. */
export async function repo(t, name = "repo") {
  const dir = join(await temp(t, name), name);
  execFileSync("mkdir", ["-p", dir]);
  await writeFile(join(dir, "README.md"), "hello\n");
  await writeFile(join(dir, ".gitignore"), "ignored/\n");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/**
 * A fake `ssh`: skips the options, logs the destination, and runs the remote command line locally with /bin/sh,
 * as the server's shell would (ssh joins its command words with spaces). Destination "down" fails like an
 * unreachable host. TMPDIR for the "server" is FAKE_SSH_TMP when set.
 */
export async function fakeSsh(t) {
  const dir = await temp(t, "ssh");
  const path = join(dir, "ssh");
  await writeFile(path, `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -T|-tt) shift;; -o|-p) shift 2;; --) shift; break;; *) break;; esac; done
dest=$1; shift
[ -n "\${FAKE_SSH_LOG:-}" ] && printf '%s\\n' "$dest" >> "$FAKE_SSH_LOG"
[ "$dest" = "down" ] && { echo "ssh: connect to host down port 22: Connection refused" >&2; exit 255; }
[ -n "\${FAKE_SSH_TMP:-}" ] && export TMPDIR="$FAKE_SSH_TMP"
exec /bin/sh -c "$*"
`);
  await chmod(path, 0o755);
  return { dir, path };
}
