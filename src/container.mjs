// The `container` environment: a card runs in a Docker or Podman container on this computer.
// - prepare: an owned copy of the project (a git worktree in the plugin's data folder, like the worktree module) or
//   the project folder itself becomes /workspace; the container is created from the fixed recipe (engine.mjs),
//   checked against it, and started; its bootstrap checks itself from inside and then holds.
// - wrap: every start of the card is `docker|podman exec -it <container> …` (the shell, or the agent by name).
// - resume: the same container: running → used; stopped → started again (same recipe, same workspace).
// - release: the container is removed; the owned copy too, unless the person keeps the data.
// Cleanup is fenced: nothing is looked up or removed while a create request may still be pending, and a card's
// leftovers from a failed earlier attempt (found by its session label) are removed before a new create.
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { basename, join, posix, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CONTAINER_SETTINGS_KEY, imageValid, normalizeContainerSettings } from "./containerSettings.mjs";
import {
  SESSION_LABEL, attachEngine, containerUser, createArgs, detectLocalEngine, execArgs, markerName, parseImage, recipe, runEngine, verifyInspection
} from "./engine.mjs";
import { remoteArgs } from "./hosts.mjs";
import { localRootsFor } from "./sshHost.mjs";
import { createWorktreeEnvironment } from "./worktree.mjs";

const PREPARE_BUDGET_MS = 12_500; // CanvasTTY waits 15 s for prepare
const READY_MS = 8_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const gitTop = async (cwd) => (await promisify(execFile)("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 5_000 })).stdout.trim();

export { CONTAINER_SETTINGS_KEY };

/** Waits until the bootstrap consumed the marker (it checked itself and holds), or the container stopped. */
export async function startAndWait({ start, markerGone, timeoutMs }) {
  const attached = start();
  const deadline = Date.now() + timeoutMs;
  let exited = null;
  attached.done.then((result) => { exited = result; });
  while (Date.now() < deadline) {
    if (await markerGone()) {
      // Consumed: the bootstrap passed its checks (it removes the marker only then). A failure exits right after.
      await new Promise((r) => setTimeout(r, 150));
      if (!exited) { attached.detach(); return { ok: true }; }
    }
    if (exited) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  attached.detach();
  const output = String(exited?.output ?? "").replace(/\s+/gu, " ").trim();
  const reason = output.match(/CanvasTTY container check failed: [^\n]*/u)?.[0] ?? (output.slice(-300) || (exited ? `the container exited (${exited.code})` : "the container did not become ready in time"));
  return { ok: false, reason };
}

export function createContainerEnvironment({ dataDir, readSettings, detect = detectLocalEngine, run = runEngine, attach = attachEngine }) {
  const worktrees = createWorktreeEnvironment({ dataDir });
  const worktreesRoot = resolve(dataDir, "worktrees");
  const localRoots = localRootsFor(dataDir);
  const pending = new Map();

  /** Only refs this plugin wrote: a container name/id it created and a workspace it owns or was given. */
  function owned(ref) {
    if (!ref || typeof ref !== "object" || !["docker", "podman"].includes(ref.engine?.kind) || typeof ref.engine.exe !== "string"
      || !Array.isArray(ref.engine.prefix) || !/^canvastty-[0-9a-f-]{36}$/u.test(String(ref.name)) || !UUID.test(String(ref.token))
      || typeof ref.workspace !== "string" || !ref.workspace.startsWith("/") || String(ref.sub ?? "").split("/").includes("..")) {
      throw new Error("This card's container ref is unreadable.");
    }
    if (ref.worktree) worktrees.owned(ref.worktree);
    if (ref.mode === "copy" && !resolve(ref.workspace).startsWith(worktreesRoot + sep)) throw new Error("This container's workspace does not belong to the plugin.");
    return ref;
  }

  const expectation = (ref, sessionId) => ({ kind: ref.engine.kind, name: ref.name, sessionId, workspace: ref.workspace, user: ref.user,
    network: ref.network, limits: ref.limits, imageId: ref.imageId, containerId: ref.containerId });

  const writeMarker = (ref) => writeFile(join(ref.workspace, markerName(ref.token)), ref.token, { mode: 0o600 });
  const markerGone = (ref) => async () => {
    try {
      statSync(join(ref.workspace, markerName(ref.token)));
      return false;
    } catch {
      return true;
    }
  };
  const startAttached = (engine, containerId) => () => {
    const controller = { kill: null };
    const done = attach(engine, containerId, { timeoutMs: READY_MS + 2_000, onChild: (child) => { controller.kill = () => child.kill("SIGKILL"); } });
    return { done, detach: () => controller.kill?.() };
  };

  /** Removes every container of this card (session label), fenced behind a pending create. */
  async function removeCardContainers(engine, sessionId, created) {
    if (created) await created.catch(() => undefined);
    for (let attempt = 0; attempt < 3; attempt++) {
      const ids = (await run(engine, ["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", `label=${SESSION_LABEL}=${sessionId}`], { timeoutMs: 8_000 })
        .catch(() => "")).split(/\s+/u).filter(Boolean);
      if (!ids.length) return;
      await run(engine, ["container", "rm", "--force", ...ids], { timeoutMs: 10_000 }).catch(() => undefined);
    }
  }

  async function doPrepare({ sessionId, cwd, options = {} }) {
    const deadline = Date.now() + PREPARE_BUDGET_MS;
    const left = () => {
      const ms = deadline - Date.now();
      if (ms <= 500) throw new Error("preparing the container took too long");
      return ms;
    };
    const settings = normalizeContainerSettings(await readSettings());
    const image = String(options.image ?? "").trim() || settings.image;
    if (!image) return { refuse: { reason: "No container image is set: choose one in the plugin's Settings (an existing image with python3), or type it in the launcher." } };
    if (!imageValid(image)) return { refuse: { reason: `${image.slice(0, 80)} is not a valid image name.` } };
    let engine;
    try {
      engine = await detect({ preferred: settings.engine, dataDir, run });
    } catch (error) {
      return { refuse: { reason: error.message } };
    }
    const mode = options.workspace === "project" ? "project" : "copy";
    const network = options.network === true ? "bridge" : "none";
    const limits = { cpus: settings.cpus, memoryMb: settings.memoryMb, pids: settings.pids };
    let wref = null, workspace, sub, created = null;
    const id = randomUUID(), name = `canvastty-${id}`, token = randomUUID();
    try {
      if (mode === "copy") {
        const prepared = await worktrees.prepare({ sessionId, cwd, options: { branch: "" } });
        if (prepared.refuse) return { refuse: { reason: `${prepared.refuse.reason} (Or start it with Workspace = the project folder.)` } };
        wref = prepared.ref;
        workspace = realpathSync(wref.dir);
        sub = wref.sub ?? "";
      } else {
        workspace = realpathSync(await gitTop(cwd).catch(() => cwd));
        sub = relative(workspace, realpathSync(cwd));
        if (sub.startsWith("..")) sub = "";
      }
      await removeCardContainers(engine, sessionId);
      const info = statSync(workspace);
      const user = containerUser(engine.kind, engine.rootless, `${info.uid}:${info.gid}`);
      const { id: imageId } = parseImage(await run(engine, ["image", "inspect", image], { timeoutMs: left() }).catch((error) => {
        throw new Error(`the image ${image} is not on this computer (it is never pulled; pull or build it first): ${error.message}`);
      }));
      const ref = { v: 1, engine: { kind: engine.kind, exe: engine.exe, prefix: engine.prefix }, name, token, image, imageId, network, limits, user, mode, workspace, sub,
        ...(wref ? { worktree: wref } : {}) };
      await writeMarker(ref);
      created = run(engine, createArgs({ kind: engine.kind, name, sessionId, workspace, user, network, limits, image,
        recipe: recipe({ mode: "hold", limits, marker: { name: markerName(token), token } }) }), { timeoutMs: left() }).then((out) => out.trim());
      ref.containerId = await created;
      verifyInspection(expectation(ref, sessionId), await run(engine, ["container", "inspect", ref.containerId], { timeoutMs: left() }));
      const ready = await startAndWait({ start: startAttached(engine, ref.containerId), markerGone: markerGone(ref), timeoutMs: Math.min(READY_MS, left()) });
      if (!ready.ok) throw new Error(ready.reason);
      const state = verifyInspection(expectation(ref, sessionId), await run(engine, ["container", "inspect", ref.containerId], { timeoutMs: left() }));
      if (!state.running) throw new Error("the container stopped right after its checks");
      return { ref, label: `container ${image}`.slice(0, 80), cwd: join(workspace, sub) };
    } catch (error) {
      if (created || engine) await removeCardContainers(engine, sessionId, created);
      if (workspace) await rm(join(workspace, markerName(token)), { force: true }).catch(() => undefined);
      if (wref) await worktrees.release({ ref: wref, keepData: false }).catch(() => undefined);
      return { refuse: { reason: `The container could not be started: ${String(error.message).slice(0, 400)}` } };
    }
  }

  return {
    async prepare(params) {
      const task = doPrepare(params);
      pending.set(params.sessionId, task);
      try {
        return await task;
      } finally {
        if (pending.get(params.sessionId) === task) pending.delete(params.sessionId);
      }
    },

    async resume({ sessionId, ref }) {
      const r = owned(ref);
      let state;
      try {
        state = verifyInspection(expectation(r, sessionId), await run(r.engine, ["container", "inspect", r.containerId], { timeoutMs: 6_000 }));
      } catch (error) {
        return { stopped: { reason: /no such|not found|no container/iu.test(error.message) ? `The container ${r.name} no longer exists.` : `The container cannot be used: ${error.message}` } };
      }
      if (state.running) return { ok: true };
      try {
        statSync(r.workspace);
      } catch {
        return { stopped: { reason: `The container's workspace ${r.workspace} no longer exists.` } };
      }
      await writeMarker(r);
      const ready = await startAndWait({ start: startAttached(r.engine, r.containerId), markerGone: markerGone(r), timeoutMs: READY_MS });
      if (!ready.ok) {
        await rm(join(r.workspace, markerName(r.token)), { force: true }).catch(() => undefined);
        return { stopped: { reason: `The container did not start again: ${ready.reason}` } };
      }
      return { ok: true };
    },

    wrap({ ref, provider, command, args = [], env = {}, secretEnvNames = [] }) {
      const r = owned(ref);
      const cwd = posix.join("/workspace", r.sub ?? "");
      const program = provider === "terminal" ? "shell" : basename(String(command));
      const words = execArgs({ containerId: r.containerId, cwd, command: program, args: provider === "terminal" ? [] : remoteArgs(args, localRoots),
        pass: [...Object.keys(env), ...secretEnvNames, "COLORTERM"] });
      return { command: r.engine.exe, args: [...r.engine.prefix, ...words] };
    },

    async release({ sessionId, ref, keepData }) {
      const r = owned(ref);
      await pending.get(sessionId)?.catch(() => undefined);
      await removeCardContainers(r.engine, sessionId);
      if (!keepData && r.worktree) await worktrees.release({ ref: r.worktree, keepData: false });
      return {};
    },

    describe({ ref }) {
      const r = owned(ref);
      return { label: `container ${r.image}`.slice(0, 80),
        detail: `${r.engine.kind} ${r.name.slice(0, 18)}… · /workspace = ${r.mode === "copy" ? "copy" : "project"} ${r.workspace} · network ${r.network}` };
    },

    owned
  };
}
