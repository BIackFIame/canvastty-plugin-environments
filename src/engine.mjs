// Docker and Podman, the same way on this computer and on a server: the fixed `container create` recipe, the check of
// what the engine actually created (`container inspect`), and the `exec` line a card runs. Local engine detection and
// the local runner live here too; servers run the same words over ssh (remoteContainer.mjs).
// Ported and cut down from the CanvasTTY chain (ContainerExecutionService: buildContainerCreateArguments,
// verifyContainerInspection, parseEngineInfo). The chain's own recovery registry is not ported: CanvasTTY saves the
// environment ref with the card and owns restore.
import { execFile, spawn } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { BOOTSTRAP, EXEC } from "./bootstrap.mjs";

export const PLUGIN_ID = "canvastty-environments";
export const PLUGIN_LABEL = "io.canvastty.plugin";
export const SESSION_LABEL = "io.canvastty.session";
const MARKER_PREFIX = ".canvastty-container-";
const HEX64 = /^[0-9a-f]{64}$/u;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;

export const markerName = (uuid) => `${MARKER_PREFIX}${uuid}`;
/** A marker the host wrote and the container did not consume (a start that failed): never collected. */
export const isMarkerPath = (path) => /(^|\/)\.canvastty-container-[0-9a-f-]{36}$/u.test(path);

export function parseEngineInfo(kind, data) {
  if (!data || typeof data !== "object") throw new Error("The container engine returned no information.");
  if (kind === "docker") {
    const options = Array.isArray(data.SecurityOptions) ? data.SecurityOptions.map(String) : [];
    if (data.OSType !== "linux" || String(data.CgroupVersion) !== "2" || data.CpuCfsPeriod !== true || data.CpuCfsQuota !== true
      || data.MemoryLimit !== true || data.PidsLimit !== true) {
      throw new Error("Docker must run Linux containers with cgroup v2 CPU, memory and PID limits.");
    }
    if (options.some((option) => option.includes("userns"))) throw new Error("Docker with user-namespace remapping is not supported.");
    return { rootless: options.some((option) => option.includes("name=rootless")), name: String(data.Name ?? "docker").slice(0, 80) };
  }
  const host = data.host ?? {};
  if (host.os !== "linux" || host.cgroupVersion !== "v2" || !Array.isArray(host.cgroupControllers)
    || ["cpu", "memory", "pids"].some((controller) => !host.cgroupControllers.includes(controller))) {
    throw new Error("Podman must run with cgroup v2 and delegated cpu, memory and pids controllers.");
  }
  return { rootless: host.security?.rootless === true, name: String(host.hostname ?? "podman").slice(0, 80) };
}

/** `image inspect` of an existing image (never pulled): its id; Linux; no declared volumes (they would be writable). */
export function parseImage(raw) {
  const list = JSON.parse(raw);
  const image = Array.isArray(list) && list.length === 1 ? list[0] : null;
  const id = String(image?.Id ?? "").replace(/^sha256:/u, "");
  if (!image || !HEX64.test(id)) throw new Error("The engine did not identify the image.");
  if (image.Os !== "linux") throw new Error("The image is not a Linux image.");
  if (image.Config?.Volumes && Object.keys(image.Config.Volumes).length) throw new Error("The image declares volumes; use an image without VOLUME.");
  return { id };
}

/** Who the container runs as: rootless Podman maps the person with keep-id, rootless Docker is 0:0 (= the person),
 *  a rootful engine runs as the workspace owner. */
export function containerUser(kind, rootless, owner) {
  if (kind === "podman" && rootless) return "keep-id";
  if (kind === "docker" && rootless) return "0:0";
  if (!/^\d{1,10}:\d{1,10}$/u.test(String(owner))) throw new Error("The workspace owner is unknown.");
  return owner;
}

export function recipe({ mode, limits, marker, command }) {
  return JSON.stringify({ mode, limits: { cpus: limits.cpus, memoryMb: limits.memoryMb, pids: limits.pids }, marker, ...(mode === "check" ? { command } : {}) });
}

/** The fixed `container create` words: read-only root, no capabilities, no-new-privileges, hard limits, private
 *  cgroup, noexec /tmp, the workspace as the one bind mount (not recursive, not shared back), no healthcheck,
 *  no restart, no logs, the bootstrap as entrypoint. */
export function createArgs({ kind, name, sessionId, workspace, user, network, limits, image, recipe: text }) {
  if (!["docker", "podman"].includes(kind)) throw new Error("Unknown container engine.");
  if (!workspace.startsWith("/") || /[,\u0000-\u001f\u007f]/u.test(workspace)) throw new Error("The workspace path cannot be mounted (commas and control characters are not allowed).");
  if (!["none", "bridge"].includes(network)) throw new Error("The network must be none or bridge.");
  const mount = `type=bind,src=${workspace},dst=/workspace,${kind === "docker" ? "bind-recursive=disabled" : "bind-nonrecursive"},bind-propagation=rprivate`;
  return ["container", "create", "--name", name, "--label", `${PLUGIN_LABEL}=${PLUGIN_ID}`, "--label", `${SESSION_LABEL}=${sessionId}`,
    "--pull=never", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", `--network=${network}`,
    `--cpus=${limits.cpus}`, `--memory=${limits.memoryMb}m`, `--pids-limit=${limits.pids}`, "--cgroupns=private", "--restart=no",
    "--stop-signal=SIGTERM", "--log-driver=none", `--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=256m,mode=1777${kind === "podman" ? ",notmpcopyup" : ""}`,
    "--workdir=/workspace", `--mount=${mount}`, "--entrypoint", "python3",
    ...(kind === "docker" ? ["--no-healthcheck"] : ["--health-cmd=none", "--image-volume=ignore", "--http-proxy=false", "--unsetenv-all",
      "--read-only-tmpfs=false", "--systemd=false", "--sdnotify=ignore"]),
    ...(user === "keep-id" ? ["--userns=keep-id"] : [`--user=${user}`]),
    `--env=CANVASTTY_CONTAINER_RECIPE=${text}`, "--env=HOME=/tmp", "--env=PATH=/usr/local/bin:/usr/bin:/bin", "--env=TERM=xterm-256color",
    "--env=LANG=C.UTF-8", image, "-I", "-S", "-c", BOOTSTRAP];
}

/**
 * What the engine created must be exactly the recipe: identity, entrypoint, restrictions, limits and the one mount.
 * Throws with the first difference; answers the state.
 */
export function verifyInspection(expected, raw) {
  const list = typeof raw === "string" ? JSON.parse(raw) : raw;
  const v = Array.isArray(list) ? list[0] : list;
  if (!v || typeof v !== "object") throw new Error("The engine returned no container.");
  const c = v.Config ?? {}, h = v.HostConfig ?? {}, { kind, limits } = expected;
  const differs = (what) => { throw new Error(`The container differs from its recipe (${what}); it is not used.`); };
  if (!HEX64.test(String(v.Id)) || (expected.containerId && v.Id !== expected.containerId)) differs("id");
  if (String(v.Name).replace(/^\//u, "") !== expected.name) differs("name");
  if (String(v.Image).replace(/^sha256:/u, "") !== expected.imageId) differs("image");
  if (c.Labels?.[PLUGIN_LABEL] !== PLUGIN_ID || c.Labels?.[SESSION_LABEL] !== expected.sessionId) differs("labels");
  if (v.Path !== "python3" || JSON.stringify(v.Args) !== JSON.stringify(["-I", "-S", "-c", BOOTSTRAP])) differs("entrypoint");
  if (c.WorkingDir !== "/workspace" || (expected.user !== "keep-id" && c.User !== expected.user)) differs("user or folder");
  if (c.Healthcheck && JSON.stringify(c.Healthcheck.Test) !== JSON.stringify(["NONE"])) differs("healthcheck");
  const empty = (value) => value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
  const capsDropped = kind === "docker" ? Array.isArray(h.CapDrop) && h.CapDrop.some((cap) => /^all$/iu.test(cap))
    : (v.EffectiveCaps === null || (Array.isArray(v.EffectiveCaps) && !v.EffectiveCaps.length)) && (v.BoundingCaps === null || (Array.isArray(v.BoundingCaps) && !v.BoundingCaps.length));
  if (h.Privileged !== false || h.ReadonlyRootfs !== true || !capsDropped || !empty(h.CapAdd)) differs("privileges");
  if (!Array.isArray(h.SecurityOpt) || !h.SecurityOpt.some((option) => option === "no-new-privileges" || option === "no-new-privileges=true")) differs("no-new-privileges");
  if (h.NetworkMode !== expected.network) differs("network");
  const cpus = h.NanoCpus > 0 ? h.NanoCpus / 1e9 : h.CpuPeriod > 0 ? h.CpuQuota / h.CpuPeriod : NaN;
  if (!(cpus > 0 && cpus <= limits.cpus + 1e-6) || !(h.Memory > 0 && h.Memory <= limits.memoryMb * 1_048_576) || !(h.PidsLimit > 0 && h.PidsLimit <= limits.pids)) differs("limits");
  if (!empty(h.VolumesFrom) || !empty(h.Devices) || !empty(h.DeviceRequests) || ["PidMode", "IpcMode", "UTSMode"].some((key) => h[key] === "host")) differs("host sharing");
  if ((kind === "docker" ? h.CgroupnsMode : h.CgroupMode) !== "private" || h.RestartPolicy?.Name !== "no") differs("cgroup or restart");
  const mounts = Array.isArray(v.Mounts) ? v.Mounts : differs("mounts");
  if (mounts.some((mount) => mount.Type === "tmpfs" && mount.Destination !== "/tmp")) differs("temporary mount");
  const binds = mounts.filter((mount) => mount.Type !== "tmpfs");
  if (binds.length !== 1 || binds[0].Type !== "bind" || binds[0].Source !== expected.workspace || binds[0].Destination !== "/workspace"
    || binds[0].RW !== true || binds[0].Propagation !== "rprivate") differs("workspace mount");
  if (kind === "docker" && h.Mounts?.[0]?.BindOptions?.NonRecursive !== true) differs("recursive mount");
  if (kind === "podman" && (!Array.isArray(binds[0].Options) || !binds[0].Options.includes("bind") || binds[0].Options.includes("rbind"))) differs("recursive mount");
  const tmp = typeof h.Tmpfs?.["/tmp"] === "string" ? h.Tmpfs["/tmp"].split(",") : [];
  const size = tmp.find((option) => option.startsWith("size="))?.match(/^size=(\d+)([kmg]?)$/iu);
  const bytes = size ? Number(size[1]) * ({ "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[size[2].toLowerCase()]) : NaN;
  if (Object.keys(h.Tmpfs ?? {}).length !== 1 || !(bytes > 0 && bytes <= 256 * 1024 ** 2) || !["noexec", "nosuid", "nodev"].every((flag) => tmp.includes(flag))) differs("/tmp");
  const state = v.State ?? {};
  return { containerId: v.Id, running: state.Running === true, status: String(state.Status ?? ""), exitCode: Number.isInteger(state.ExitCode) ? state.ExitCode : null };
}

/** The words that start one card process in a held container. `pass` names variables copied from the engine CLI's
 *  own environment (the launch's variables, secrets by name); on a server nothing is passed. */
export function execArgs({ containerId, cwd, command, args = [], pass = [] }) {
  if (!HEX64.test(String(containerId))) throw new Error("The container id is unreadable.");
  const names = pass.filter((name) => NAME.test(name) && !name.startsWith("CANVASTTY_")).slice(0, 32);
  const text = JSON.stringify({ cwd, command, args, pass: names });
  return ["exec", "-it", "-e", `CANVASTTY_CONTAINER_RECIPE=${text}`, ...names.flatMap((name) => ["-e", name]), containerId, "python3", "-I", "-S", "-c", EXEC];
}

// ---------------------------------------------------------------------------------------------------------------
// This computer: find a running engine (never starts Docker Desktop or a Podman machine) and run its CLI.

const safeEnvironment = () => Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]
  .flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])));

function findExecutable(name, extra) {
  const dirs = [...String(process.env.PATH ?? "").split(delimiter), ...extra].filter(Boolean);
  for (const dir of dirs) {
    const path = join(dir, name);
    try {
      if (statSync(path).isFile()) return path;
    } catch { /* next */ }
  }
  return null;
}

function dockerSocket() {
  const fromEnv = String(process.env.DOCKER_HOST ?? "");
  const candidates = [fromEnv.startsWith("unix://") ? fromEnv.slice(7) : "", join(homedir(), ".docker/run/docker.sock"), "/var/run/docker.sock",
    join(homedir(), ".colima/default/docker.sock"), join(homedir(), ".orbstack/run/docker.sock"), join(homedir(), ".rd/docker.sock")];
  return candidates.find((path) => {
    try {
      return path && statSync(path).isSocket();
    } catch {
      return false;
    }
  }) ?? null;
}

/** Runs one engine command; resolves stdout, rejects with a short reason (stderr, bounded). */
export function runEngine(engine, words, { timeoutMs = 20_000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    execFile(engine.exe, [...engine.prefix, ...words], { env: { ...safeEnvironment(), ...env }, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        const detail = String(stderr || error.message).replace(/\s+/gu, " ").trim().slice(0, 300);
        reject(Object.assign(new Error(error.killed ? `${engine.kind} ${words[1] ?? words[0]} did not finish in time.` : detail || `${engine.kind} failed.`), { exitCode: error.code }));
      });
  });
}

/** `container start --attach`: the output (bounded, tail kept) and the exit code; killed at the deadline. Killing
 *  this client (SIGKILL, never forwarded) detaches; the container keeps running. */
export function attachEngine(engine, containerId, { timeoutMs, maxBytes = 256 * 1024, onChild }) {
  return new Promise((resolve) => {
    const child = spawn(engine.exe, [...engine.prefix, "container", "start", "--attach", containerId], { env: safeEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    onChild?.(child);
    let output = "", timedOut = false;
    const keep = (chunk) => { output = (output + chunk).slice(-maxBytes); };
    child.stdout.setEncoding("utf8").on("data", keep);
    child.stderr.setEncoding("utf8").on("data", keep);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: null, output: error.message, timedOut }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output, timedOut }); });
  });
}

const DOCKER_DIRS = ["/usr/local/bin", "/opt/homebrew/bin", "/Applications/Docker.app/Contents/Resources/bin", "/usr/bin"];
const PODMAN_DIRS = ["/opt/podman/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

/**
 * The engine on this computer: `preferred` auto tries Docker, then Podman. Only an engine that already runs is used.
 * Answers { kind, exe, prefix, rootless, name }; throws with every reason when none can be used.
 */
export async function detectLocalEngine({ preferred = "auto", dataDir, run = runEngine }) {
  const reasons = [];
  if (preferred === "auto" || preferred === "docker") {
    const exe = findExecutable("docker", DOCKER_DIRS);
    const socket = exe ? dockerSocket() : null;
    if (!exe) reasons.push("Docker is not installed");
    else if (!socket) reasons.push("Docker is installed but not running (no socket)");
    else {
      // Its own empty config folder: no credential helpers, contexts or proxies from ~/.docker.
      const config = join(dataDir, "engine", "docker-config");
      mkdirSync(config, { recursive: true, mode: 0o700 });
      const engine = { kind: "docker", exe, prefix: ["--config", config, "--host", `unix://${socket}`] };
      try {
        return { ...engine, ...parseEngineInfo("docker", JSON.parse(await run(engine, ["info", "--format", "{{json .}}"], { timeoutMs: 6_000 }))) };
      } catch (error) {
        reasons.push(`Docker: ${error.message}`);
      }
    }
  }
  if (preferred === "auto" || preferred === "podman") {
    const exe = findExecutable("podman", PODMAN_DIRS);
    if (!exe) reasons.push("Podman is not installed");
    else {
      const engine = { kind: "podman", exe, prefix: [] };
      try {
        return { ...engine, ...parseEngineInfo("podman", JSON.parse(await run(engine, ["info", "--format=json"], { timeoutMs: 6_000 }))) };
      } catch (error) {
        reasons.push(`Podman: ${String(error.message).includes("machine") || String(error.message).includes("connect") ? "not running (start its machine first)" : error.message}`);
      }
    }
  }
  throw new Error(`No container engine can be used on this computer: ${reasons.join("; ")}.`);
}
