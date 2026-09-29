// The `remote-container` environment: the container module's recipe on a server from the ssh-host settings (Podman by
// default). Each step is ONE ssh call running a fixed script (servers answer an ssh connection in seconds, and
// prepare has 15 s): probe (folder, engine, image, owner), create (owned copy as a git worktree next to the mapped
// folder, marker, `container create`, `inspect`), then start-and-wait. What the server's engine created is checked
// here with the same verifyInspection as on this computer, before the container is started.
// The card's shell is `ssh -tt <host> '<engine> exec -it <container> …'`. Nothing from this computer is forwarded
// into the container (no variables, no keys). Release removes the container, and the owned copy unless kept.
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { sshTransport } from "./collect.mjs";
import { imageValid, normalizeContainerSettings } from "./containerSettings.mjs";
import { SESSION_LABEL, containerUser, createArgs, execArgs, markerName, parseEngineInfo, parseImage, recipe, verifyInspection } from "./engine.mjs";
import { chooseHost, hostSnapshot, normalizeHosts, remoteArgs, remoteFolderFor, shellQuote, sshLaunchArgs } from "./hosts.mjs";
import { REMOTE_KEEPS_NOTE, localRootsFor } from "./sshHost.mjs";

const PREPARE_BUDGET_MS = 12_500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** $1 folder $2 engine $3 image $4 info format. Prints @top/@real/@owner lines, then @info and @image sections. */
export const PROBE = String.raw`set -u
cd -- "$1" 2>/dev/null || { echo 'CTTY_ERR no-folder' >&2; exit 3; }
command -v "$2" >/dev/null 2>&1 || { echo 'CTTY_ERR no-engine' >&2; exit 4; }
echo "@real $(pwd -P)"
echo "@top $(git rev-parse --show-toplevel 2>/dev/null)"
echo "@owner $(id -u):$(id -g) $(stat -c %u:%g .)"
echo @info; "$2" info --format "$4" || { echo 'CTTY_ERR engine-down' >&2; exit 5; }
echo @image; "$2" image inspect "$3" || { echo 'CTTY_ERR no-image' >&2; exit 6; }
`;

/** $1 top $2 engine $3 mode $4 workspace $5 branch $6 session $7 marker $8 token, then the create words. */
export const CREATE = String.raw`set -u
top=$1 engine=$2 mode=$3 ws=$4 branch=$5 sid=$6 marker=$7 token=$8; shift 8
ids=$("$engine" container ls --all --quiet --no-trunc --filter "label=${SESSION_LABEL}=$sid" 2>/dev/null)
[ -z "$ids" ] || "$engine" container rm --force $ids >/dev/null 2>&1
if [ "$mode" = copy ]; then
  mkdir -p -- "$(dirname -- "$ws")" && git -C "$top" worktree add --quiet -b "$branch" "$ws" HEAD >&2 || { echo 'CTTY_ERR worktree' >&2; exit 7; }
fi
[ "$(cd -- "$ws" 2>/dev/null && pwd -P)" = "$ws" ] || { echo 'CTTY_ERR workspace' >&2; exit 3; }
(umask 077; printf %s "$token" > "$ws/$marker") || exit 8
id=$("$engine" "$@") || { rm -f "$ws/$marker"; echo 'CTTY_ERR create' >&2; exit 9; }
echo "@id $id"
echo @inspect; "$engine" container inspect "$id"
`;

/** $1 engine $2 id $3 workspace $4 marker $5 token $6 "start" (always) or "resume" (only when stopped). */
export const START = String.raw`set -u
engine=$1 id=$2 ws=$3 marker=$4 token=$5
running=$("$engine" container inspect --format '{{.State.Running}}' "$id" 2>/dev/null) || { echo 'CTTY_ERR gone' >&2; exit 10; }
if [ "$6" = resume ] && [ "$running" = true ]; then echo @running; echo @inspect; "$engine" container inspect "$id"; exit 0; fi
[ -d "$ws" ] || { echo 'CTTY_ERR no-workspace' >&2; exit 3; }
(umask 077; printf %s "$token" > "$ws/$marker") || exit 8
out=$(mktemp) || exit 8
"$engine" container start --attach "$id" > "$out" 2>&1 &
pid=$! i=0 ok=0
while [ $i -lt 80 ]; do
  if [ ! -e "$ws/$marker" ]; then sleep 0.2; kill -0 $pid 2>/dev/null && ok=1; break; fi
  kill -0 $pid 2>/dev/null || break
  sleep 0.1; i=$((i+1))
done
kill -9 $pid 2>/dev/null; wait $pid 2>/dev/null
if [ $ok = 1 ]; then echo @ready; else echo @failed; tail -c 600 "$out"; echo; rm -f "$ws/$marker"; fi
rm -f "$out"
echo @inspect; "$engine" container inspect "$id"
`;

/** $1 engine $2 session $3 keep (1/0) $4 mode $5 top $6 workspace $7 branch. */
export const RELEASE = String.raw`set -u
ids=$("$1" container ls --all --quiet --no-trunc --filter "label=${SESSION_LABEL}=$2" 2>/dev/null)
[ -z "$ids" ] || "$1" container rm --force $ids >/dev/null 2>&1 || { echo 'CTTY_ERR remove' >&2; exit 11; }
if [ "$3" = 0 ] && [ "$4" = copy ]; then
  git -C "$5" worktree remove --force "$6" 2>/dev/null; git -C "$5" branch -D "$7" >/dev/null 2>&1; rmdir -- "$(dirname -- "$6")" 2>/dev/null
fi
exit 0
`;

const REASONS = {
  "no-folder": "the mapped folder does not exist on the server", "no-engine": "the container engine is not installed on the server",
  "engine-down": "the server's container engine does not answer", "no-image": "the image is not on the server (it is never pulled; pull or build it there first)",
  worktree: "git worktree add failed on the server (is the mapped folder a git clone with a commit?)", workspace: "the workspace folder is not canonical",
  create: "the engine refused to create the container", gone: "the container no longer exists", "no-workspace": "the container's workspace no longer exists",
  remove: "the engine refused to remove the container"
};

/** Splits "@name value" lines and "@section" blocks. */
export function sections(text) {
  const result = { lines: {}, blocks: {} };
  let current = null;
  for (const line of text.split("\n")) {
    const match = line.match(/^@([a-z]+)(?: (.*))?$/u);
    if (match && match[2] !== undefined) result.lines[match[1]] = match[2];
    else if (match) { current = match[1]; result.blocks[current] = ""; }
    else if (current) result.blocks[current] += `${line}\n`;
  }
  return result;
}

export function createRemoteContainerEnvironment({ dataDir, readSettings, readHosts, transportFor = (host) => sshTransport(host) }) {
  /** The prepare or release running for a card; the next one waits for it (as in the local container environment). */
  const ops = new Map();
  const preparing = new Set();
  const exclusive = (sessionId, run) => {
    const task = (ops.get(sessionId) ?? Promise.resolve()).catch(() => undefined).then(run);
    ops.set(sessionId, task);
    task.catch(() => undefined).finally(() => { if (ops.get(sessionId) === task) ops.delete(sessionId); });
    return task;
  };
  const localRoots = localRootsFor(dataDir);

  async function script(host, text, args, timeoutMs, what) {
    const run = await transportFor(host)(text, args, Buffer.alloc(0), Math.max(1_000, timeoutMs));
    const stdout = run.stdout.toString("utf8");
    if (run.code === 0) return stdout;
    if (run.timedOut) throw new Error(`${what} on ${host.label} did not finish in time`);
    const code = run.stderr.match(/CTTY_ERR ([a-z-]+)/u)?.[1];
    const detail = run.stderr.replace(/CTTY_ERR [a-z-]+/gu, "").replace(/\s+/gu, " ").trim().slice(0, 240);
    throw new Error(code && REASONS[code] ? `${REASONS[code]}${detail ? ` (${detail})` : ""}` : `${what} on ${host.label} failed${detail ? `: ${detail}` : ""}`);
  }

  function owned(ref) {
    if (!ref || typeof ref !== "object" || !ref.host || !["docker", "podman"].includes(ref.engine) || !/^canvastty-[0-9a-f-]{36}$/u.test(String(ref.name))
      || !UUID.test(String(ref.token)) || !posix.isAbsolute(String(ref.workspace)) || String(ref.workspace).split("/").includes("..")
      || String(ref.sub ?? "").split("/").includes("..") || !/^[0-9a-f]{64}$/u.test(String(ref.containerId))) {
      throw new Error("This card's container ref is unreadable.");
    }
    if (ref.mode === "copy" && !ref.workspace.includes("/.canvastty-work/")) throw new Error("This container's workspace does not belong to the plugin.");
    return ref;
  }

  const expectation = (ref, sessionId) => ({ kind: ref.engine, name: ref.name, sessionId, workspace: ref.workspace, user: ref.user, network: ref.network,
    limits: ref.limits, imageId: ref.imageId, containerId: ref.containerId });

  async function start(ref, sessionId, mode, timeoutMs) {
    const out = sections(await script(ref.host, START, [ref.engine, ref.containerId, ref.workspace, markerName(ref.token), ref.token, mode], timeoutMs, "Starting the container"));
    const state = verifyInspection(expectation(ref, sessionId), out.blocks.inspect ?? "");
    if ("running" in out.blocks || "ready" in out.blocks) {
      if (!state.running) throw new Error("the container stopped right after its checks");
      return;
    }
    const reason = (out.blocks.failed ?? "").match(/CanvasTTY container check failed: [^\n]*/u)?.[0] ?? (out.blocks.failed ?? "").replace(/\s+/gu, " ").trim().slice(-300);
    throw new Error(reason || "the container did not become ready in time");
  }

  async function doPrepare({ sessionId, cwd, options = {} }) {
    const deadline = Date.now() + PREPARE_BUDGET_MS;
    const left = () => {
      const ms = deadline - Date.now();
      if (ms <= 500) throw new Error("preparing the container took too long");
      return ms;
    };
    const settings = normalizeContainerSettings(await readSettings());
    const hosts = normalizeHosts(await readHosts());
    if (!hosts.length) return { refuse: { reason: "No server is configured yet: add one in the plugin's Settings." } };
    const host = chooseHost(hosts, options.host);
    if (!host) return { refuse: { reason: `No configured server is called ${String(options.host).slice(0, 40)}.` } };
    const folder = remoteFolderFor(host, cwd);
    if (!folder) return { refuse: { reason: `${cwd} is not mapped to a folder on ${host.label}; add a folder mapping in the plugin's Settings.` } };
    const image = String(options.image ?? "").trim() || settings.image;
    if (!image || !imageValid(image)) return { refuse: { reason: "No valid container image is set: choose one in the plugin's Settings, or type it in the launcher." } };
    const engine = settings.remoteEngine, mode = options.workspace === "project" ? "project" : "copy";
    const network = options.network === true ? "bridge" : "none";
    const limits = { cpus: settings.cpus, memoryMb: settings.memoryMb, pids: settings.pids };
    const snapshot = hostSnapshot(host);
    let created = null, ref = null;
    try {
      const probe = sections(await script(snapshot, PROBE, [folder, engine, image, engine === "docker" ? "{{json .}}" : "json"], left(), "Checking the server"));
      const info = parseEngineInfo(engine, JSON.parse(probe.blocks.info ?? ""));
      const { id: imageId } = parseImage(probe.blocks.image ?? "");
      const real = probe.lines.real, top = probe.lines.top || "";
      if (mode === "copy" && !top) return { refuse: { reason: `${folder} on ${host.label} is not a git clone; start it with Workspace = the project folder.` } };
      const [self, rootOwner] = String(probe.lines.owner ?? "").split(" ");
      const id = randomUUID(), token = randomUUID(), name = `canvastty-${id}`;
      const root = mode === "copy" ? top : real;
      const inside = posix.relative(root, real);
      const workspace = mode === "copy" ? `${posix.dirname(top)}/.canvastty-work/${posix.basename(top)}-${sessionId.slice(0, 8)}` : real;
      const user = containerUser(engine, info.rootless, mode === "copy" ? self : rootOwner);
      ref = { v: 1, host: snapshot, engine, name, token, image, imageId, network, limits, user, mode, top, workspace,
        sub: inside.startsWith("..") ? "" : inside, branch: `canvastty/${sessionId.slice(0, 8)}`, localFolder: cwd };
      const words = createArgs({ kind: engine, name, sessionId, workspace, user, network, limits, image,
        recipe: recipe({ mode: "hold", limits, marker: { name: markerName(token), token } }) });
      created = script(snapshot, CREATE, [top || real, engine, mode, workspace, ref.branch, sessionId, markerName(token), token, ...words], left(), "Creating the container");
      const made = sections(await created);
      ref.containerId = String(made.lines.id ?? "").trim();
      verifyInspection(expectation(ref, sessionId), made.blocks.inspect ?? "");
      await start(ref, sessionId, "start", left());
      return { ref, label: `container ${image} on ${host.label}`.slice(0, 80) };
    } catch (error) {
      if (created && ref) {
        // Fenced: the create call has settled (ssh returned) before the card's containers are looked up and removed.
        await created.catch(() => undefined);
        await script(snapshot, RELEASE, [engine, sessionId, "0", ref.mode, ref.top || ref.workspace, ref.workspace, ref.branch], 10_000, "Cleaning up").catch(() => undefined);
      }
      return { refuse: { reason: `The container on ${host.label} could not be started: ${String(error.message).slice(0, 400)}` } };
    }
  }

  return {
    async prepare(params) {
      if (preparing.has(params.sessionId)) return { refuse: { reason: "This card's container is already being prepared." } };
      preparing.add(params.sessionId);
      try {
        return await exclusive(params.sessionId, () => doPrepare(params));
      } finally {
        preparing.delete(params.sessionId);
      }
    },

    async resume({ sessionId, ref }) {
      const r = owned(ref);
      try {
        await start(r, sessionId, "resume", 9_500);
        return { ok: true };
      } catch (error) {
        return { stopped: { reason: `The container on ${r.host.label} cannot be used: ${error.message}` } };
      }
    },

    wrap({ ref, provider, command, args = [] }) {
      const r = owned(ref);
      const terminal = provider === "terminal";
      const words = [r.engine, ...execArgs({ containerId: r.containerId, cwd: posix.join("/workspace", r.sub ?? ""), command: terminal ? "shell" : posix.basename(String(command)),
        args: terminal ? [] : remoteArgs(args, localRoots), pass: [] })];
      return { command: "ssh", args: sshLaunchArgs(r.host, `exec ${words.map(shellQuote).join(" ")}`) };
    },

    async release({ sessionId, ref, keepData }) {
      const r = owned(ref);
      return exclusive(sessionId, async () => {
        await script(r.host, RELEASE, [r.engine, sessionId, keepData ? "1" : "0", r.mode, r.top || r.workspace, r.workspace, r.branch], 9_500, "Removing the container");
        return {};
      });
    },

    describe({ ref }) {
      const r = owned(ref);
      return { label: `container ${r.image} on ${r.host.label}`.slice(0, 80),
        detail: `${REMOTE_KEEPS_NOTE} · ${r.engine} ${r.name.slice(0, 18)}… on ${r.host.sshHost} · /workspace = ${r.mode === "copy" ? "copy" : "project"} ${r.workspace} · network ${r.network}` };
    },

    owned
  };
}
