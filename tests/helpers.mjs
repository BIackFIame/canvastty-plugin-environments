import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
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

/**
 * A fake Docker for the container code: `run` answers the engine words the code sends (image inspect, container
 * create/inspect/ls/rm) from what `create` recorded, `attach` plays the container's bootstrap: it consumes the marker
 * and either holds (until detached) or, for a check recipe, runs the command with /bin/sh in the mounted folder.
 */
export function fakeEngine({ imageId = "a".repeat(64), holdFails = null, createDelayMs = 0, createFails = false } = {}) {
  const containers = new Map();
  const calls = [];
  const flag = (words, name) => words.find((word) => word.startsWith(`${name}=`))?.slice(name.length + 1);
  const value = (words, name) => words[words.indexOf(name) + 1];
  const engine = { kind: "docker", exe: "/usr/bin/docker", prefix: ["--config", "/cfg"], rootless: false, name: "fake" };
  async function run(_engine, words) {
    calls.push(words.slice(0, 2).join(" "));
    const [group, verb] = words;
    if (group === "image" && verb === "inspect") return JSON.stringify([{ Id: `sha256:${imageId}`, Os: "linux", Config: {} }]);
    if (group === "container" && verb === "create") {
      if (createDelayMs) await new Promise((r) => setTimeout(r, createDelayMs));
      if (createFails) throw new Error("create refused");
      const id = randomBytes(32).toString("hex");
      const image = words[words.length - 5];
      const mount = flag(words, "--mount");
      const labels = Object.fromEntries(words.flatMap((word, i) => (words[i - 1] === "--label" ? [word.split("=")] : [])));
      containers.set(id, { id, name: value(words, "--name"), labels, image, workspace: mount.match(/src=([^,]*)/)[1], network: flag(words, "--network"),
        cpus: Number(flag(words, "--cpus")), memory: parseInt(flag(words, "--memory"), 10) * 1_048_576, pids: Number(flag(words, "--pids-limit")),
        user: flag(words, "--user"), recipe: JSON.parse(flag(words, "--env").slice("CANVASTTY_CONTAINER_RECIPE=".length)), args: words.slice(-4),
        running: false, exitCode: 0 });
      return `${id}\n`;
    }
    if (group === "container" && verb === "inspect") {
      const c = [...containers.values()].find((item) => item.id === words[2] || item.name === words[2]);
      if (!c) throw new Error(`Error: No such container: ${words[2]}`);
      return JSON.stringify([{ Id: c.id, Name: `/${c.name}`, Image: `sha256:${imageId}`, Path: "python3", Args: c.args,
        Config: { Labels: c.labels, WorkingDir: "/workspace", User: c.user, Healthcheck: { Test: ["NONE"] } },
        HostConfig: { Privileged: false, ReadonlyRootfs: true, CapDrop: ["ALL"], CapAdd: null, SecurityOpt: ["no-new-privileges"], NetworkMode: c.network,
          NanoCpus: c.cpus * 1e9, Memory: c.memory, PidsLimit: c.pids, CgroupnsMode: "private", RestartPolicy: { Name: "no" },
          Tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,size=256m,mode=1777" }, Mounts: [{ BindOptions: { NonRecursive: true } }] },
        Mounts: [{ Type: "bind", Source: c.workspace, Destination: "/workspace", RW: true, Propagation: "rprivate" }],
        State: { Running: c.running, Status: c.running ? "running" : "exited", ExitCode: c.exitCode } }]);
    }
    if (group === "container" && verb === "ls") {
      const label = value(words, "--filter").replace(/^label=/, "").split("=");
      return [...containers.values()].filter((c) => c.labels[label[0]] === label[1]).map((c) => c.id).join("\n");
    }
    if (group === "container" && verb === "rm") {
      for (const id of words.slice(3)) for (const c of containers.values()) if (c.id === id || c.name === id) containers.delete(c.id);
      return "";
    }
    if (group === "container" && verb === "stop") {
      containers.get(words.at(-1)).running = false;
      return "";
    }
    throw new Error(`fake engine: ${words.slice(0, 2).join(" ")}`);
  }
  function attach(_engine, id, { onChild } = {}) {
    const c = containers.get(id);
    calls.push("container start");
    return new Promise((resolve) => {
      const marker = join(c.workspace, c.recipe.marker.name);
      if (holdFails) { c.exitCode = 78; return resolve({ code: 78, output: `CanvasTTY container check failed: ${holdFails}.\n`, timedOut: false }); }
      rmSync(marker);
      if (c.recipe.mode === "check") {
        execFile("/bin/sh", ["-c", c.recipe.command], { cwd: c.workspace }, (error, stdout, stderr) => {
          c.exitCode = error ? error.code : 0;
          resolve({ code: c.exitCode, output: stdout + stderr, timedOut: false });
        });
        return;
      }
      c.running = true;
      onChild?.({ kill: () => resolve({ code: null, output: "", timedOut: false }) });
    });
  }
  return { engine, run, attach, detect: async () => engine, containers, calls };
}
