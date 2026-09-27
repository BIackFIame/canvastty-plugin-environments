// Containers: the fixed create recipe, the check of what the engine created, settings, the local environment's
// prepare/wrap/resume/release (fenced cleanup) against a fake engine, the remote environment's ssh steps against a
// fake transport, and the Python programs compile. A real engine run happens only with CTTY_TEST_IMAGE set.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { BOOTSTRAP, EXEC } from "../src/bootstrap.mjs";
import { pathspecs } from "../src/collect.mjs";
import { createContainerEnvironment } from "../src/container.mjs";
import { containerSettingsInvalidReason, normalizeContainerSettings } from "../src/containerSettings.mjs";
import { containerUser, createArgs, detectLocalEngine, execArgs, recipe, verifyInspection } from "../src/engine.mjs";
import { CREATE, PROBE, RELEASE, START, createRemoteContainerEnvironment } from "../src/remoteContainer.mjs";
import { fakeEngine, git, repo, temp } from "./helpers.mjs";

const limits = { cpus: 2, memoryMb: 2048, pids: 512 };
const SID = "0a1b2c3d-1111-2222-3333-444455556666";

test("the create recipe: read-only, no capabilities, no-new-privileges, limits, one non-recursive bind, bootstrap entrypoint", () => {
  const text = recipe({ mode: "hold", limits, marker: { name: ".canvastty-container-x", token: "t" } });
  const docker = createArgs({ kind: "docker", name: "canvastty-n", sessionId: SID, workspace: "/w", user: "501:20", network: "none", limits, image: "img:1", recipe: text });
  for (const word of ["--pull=never", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--network=none", "--cpus=2", "--memory=2048m",
    "--pids-limit=512", "--cgroupns=private", "--restart=no", "--log-driver=none", "--no-healthcheck", "--user=501:20",
    "--mount=type=bind,src=/w,dst=/workspace,bind-recursive=disabled,bind-propagation=rprivate"]) assert.ok(docker.includes(word), word);
  assert.ok(docker.some((word) => word.startsWith("--tmpfs=/tmp:rw,nosuid,nodev,noexec")));
  assert.deepEqual(docker.slice(-5), ["img:1", "-I", "-S", "-c", BOOTSTRAP]);
  const podman = createArgs({ kind: "podman", name: "canvastty-n", sessionId: SID, workspace: "/w", user: "keep-id", network: "bridge", limits, image: "img:1", recipe: text });
  for (const word of ["--userns=keep-id", "--unsetenv-all", "--image-volume=ignore", "--health-cmd=none", "--network=bridge"]) assert.ok(podman.includes(word), word);
  assert.ok(podman.some((word) => word.includes("bind-nonrecursive")));
  assert.throws(() => createArgs({ kind: "docker", name: "n", sessionId: SID, workspace: "/a,b", user: "1:1", network: "none", limits, image: "i", recipe: text }), /cannot be mounted/);
  assert.throws(() => createArgs({ kind: "docker", name: "n", sessionId: SID, workspace: "/w", user: "1:1", network: "host", limits, image: "i", recipe: text }), /none or bridge/);
  assert.equal(containerUser("podman", true, "0:0"), "keep-id");
  assert.equal(containerUser("docker", true, "501:20"), "0:0");
  assert.equal(containerUser("podman", false, "0:0"), "0:0");
});

test("what the engine created is checked field by field; any widening is refused", async () => {
  const fake = fakeEngine();
  const text = recipe({ mode: "hold", limits, marker: { name: ".canvastty-container-x", token: "t" } });
  const id = (await fake.run(fake.engine, createArgs({ kind: "docker", name: "canvastty-n", sessionId: SID, workspace: "/w", user: "501:20", network: "none", limits, image: "img", recipe: text }))).trim();
  const good = JSON.parse(await fake.run(fake.engine, ["container", "inspect", id]));
  const expected = { kind: "docker", name: "canvastty-n", sessionId: SID, workspace: "/w", user: "501:20", network: "none", limits, imageId: "a".repeat(64), containerId: id };
  assert.deepEqual(verifyInspection(expected, good), { containerId: id, running: false, status: "exited", exitCode: 0 });
  const widen = [
    (v) => { v.HostConfig.ReadonlyRootfs = false; }, (v) => { v.HostConfig.CapAdd = ["NET_ADMIN"]; }, (v) => { v.HostConfig.Privileged = true; },
    (v) => { v.HostConfig.NetworkMode = "host"; }, (v) => { v.HostConfig.SecurityOpt = []; }, (v) => { v.HostConfig.Memory = 0; },
    (v) => { v.Mounts.push({ Type: "bind", Source: "/Users", Destination: "/host", RW: true, Propagation: "rprivate" }); },
    (v) => { v.Mounts[0].Source = "/elsewhere"; }, (v) => { v.Image = `sha256:${"b".repeat(64)}`; }, (v) => { v.Args = ["-c", "print(1)"]; },
    (v) => { v.Config.Labels["io.canvastty.session"] = "other"; }, (v) => { v.HostConfig.PidMode = "host"; }, (v) => { v.HostConfig.Tmpfs = { "/tmp": "rw,size=1g" }; },
    (v) => { v.HostConfig.Mounts[0].BindOptions.NonRecursive = false; }, (v) => { v.HostConfig.CgroupnsMode = "host"; }
  ];
  for (const change of widen) {
    const copy = structuredClone(good);
    change(copy[0]);
    assert.throws(() => verifyInspection(expected, copy), /differs from its recipe/, change.toString());
  }
});

test("container settings: defaults, bounds, unknown fields; the exec line passes only names", () => {
  assert.equal(normalizeContainerSettings(null).engine, "auto");
  assert.equal(normalizeContainerSettings({ image: "python:3.12-slim", cpus: 1.5 }).cpus, 1.5);
  assert.equal(normalizeContainerSettings({ cpus: 999 }).cpus, 2, "an invalid object falls back to the defaults");
  assert.match(containerSettingsInvalidReason({ image: "bad image" }), /image/);
  assert.match(containerSettingsInvalidReason({ memoryMb: 100.5 }), /whole/);
  assert.match(containerSettingsInvalidReason({ engine: "lxc" }), /engine/);
  assert.match(containerSettingsInvalidReason({ imageName: "x" }), /unknown field/);
  const words = execArgs({ containerId: "c".repeat(64), cwd: "/workspace/sub", command: "shell", pass: ["OPENAI_API_KEY", "CANVASTTY_RUNTIME_SOCKET", "bad-name", "COLORTERM"] });
  assert.deepEqual(words.slice(0, 2), ["exec", "-it"]);
  assert.deepEqual(JSON.parse(words[3].slice("CANVASTTY_CONTAINER_RECIPE=".length)), { cwd: "/workspace/sub", command: "shell", args: [], pass: ["OPENAI_API_KEY", "COLORTERM"] });
  assert.deepEqual(words.slice(4, 8), ["-e", "OPENAI_API_KEY", "-e", "COLORTERM"], "values are never in the argv");
  assert.deepEqual(words.slice(-5, -1), ["python3", "-I", "-S", "-c"]);
  assert.equal(words.at(-1), EXEC);
  assert.deepEqual(pathspecs([".canvastty-container-0a1b2c3d-1111-2222-3333-444455556666", "a.txt"]).excluded, [], "a start marker is left out silently");
  assert.ok(pathspecs([".canvastty-container-0a1b2c3d-1111-2222-3333-444455556666"]).input.toString().includes(":(exclude,literal).canvastty-container-"));
});

test("the Python bootstrap and exec programs compile (python3 -I -S)", { skip: !pythonAvailable() }, () => {
  for (const source of [BOOTSTRAP, EXEC]) execFileSync("python3", ["-I", "-S", "-c", "import sys; compile(sys.stdin.read(), 'bootstrap', 'exec')"], { input: source });
  // Outside a container (no /proc here, or a normal process with capabilities) the exec program refuses to run anything.
  let failed = null;
  try {
    execFileSync("python3", ["-I", "-S", "-c", EXEC], { env: { CANVASTTY_CONTAINER_RECIPE: JSON.stringify({ cwd: "/workspace", command: "shell" }) }, stdio: "pipe" });
  } catch (error) {
    failed = error;
  }
  assert.equal(failed?.status, 78);
  assert.match(String(failed.stderr), /CanvasTTY container check failed/);
});

test("local container: owned copy, fixed recipe, marker consumed before ready, exec wrap, resume restarts, release removes", async (t) => {
  const local = await repo(t, "project");
  execFileSync("mkdir", ["-p", join(local, "sub")]);
  const dataDir = await temp(t, "data");
  const fake = fakeEngine();
  const env = createContainerEnvironment({ dataDir, readSettings: async () => ({ image: "img:1" }), detect: fake.detect, run: fake.run, attach: fake.attach });
  const prepared = await env.prepare({ sessionId: SID, provider: "terminal", cwd: join(local, "sub"), options: {} });
  assert.ok(prepared.ref, JSON.stringify(prepared));
  const { ref } = prepared;
  assert.equal(ref.mode, "copy");
  assert.ok(ref.workspace.startsWith(join(dataDir, "worktrees")));
  assert.equal(ref.sub, "sub");
  assert.equal(prepared.cwd, join(ref.workspace, "sub"));
  assert.equal(prepared.label, "container img:1");
  assert.equal(ref.network, "none");
  assert.ok(!readdirSync(ref.workspace).some((name) => name.startsWith(".canvastty-container-")), "the bootstrap consumed the marker");
  assert.equal(fake.containers.get(ref.containerId).running, true);

  const wrapped = env.wrap({ ref, provider: "claude", command: "/opt/homebrew/bin/claude", args: ["--settings", join(dataDir, "x.json"), "--model", "m"], env: { FOO: "1" }, secretEnvNames: ["ANTHROPIC_API_KEY"] });
  assert.equal(wrapped.command, "/usr/bin/docker");
  const recipeText = wrapped.args[wrapped.args.indexOf("-it") + 2].slice("CANVASTTY_CONTAINER_RECIPE=".length);
  assert.deepEqual(JSON.parse(recipeText), { cwd: "/workspace/sub", command: "claude", args: ["--model", "m"], pass: ["FOO", "ANTHROPIC_API_KEY", "COLORTERM"] });

  assert.deepEqual(await env.resume({ sessionId: SID, ref }), { ok: true });
  fake.containers.get(ref.containerId).running = false;
  assert.deepEqual(await env.resume({ sessionId: SID, ref }), { ok: true }, "a stopped container is started again");
  assert.equal(fake.containers.get(ref.containerId).running, true);

  await env.release({ sessionId: SID, ref, keepData: true });
  assert.equal(fake.containers.size, 0, "release always removes the container");
  assert.ok(existsSync(ref.workspace), "keepData keeps the owned copy");
  assert.match((await env.resume({ sessionId: SID, ref })).stopped.reason, /no longer exists/);
  await env.release({ sessionId: SID, ref, keepData: false });
  assert.ok(!existsSync(ref.workspace));
  assert.equal(git(local, "branch", "--list", "canvastty/*"), "");
});

test("local container: a failing bootstrap or a slow failing create cleans up behind the create (fenced) and refuses", async (t) => {
  const local = await repo(t, "project");
  const dataDir = await temp(t, "data");
  const failing = fakeEngine({ holdFails: "capabilities are not all dropped" });
  let env = createContainerEnvironment({ dataDir, readSettings: async () => ({ image: "img:1" }), detect: failing.detect, run: failing.run, attach: failing.attach });
  const refused = await env.prepare({ sessionId: SID, provider: "terminal", cwd: local, options: { workspace: "project" } });
  assert.match(refused.refuse.reason, /capabilities are not all dropped/);
  assert.equal(failing.containers.size, 0);
  assert.ok(!readdirSync(local).some((name) => name.startsWith(".canvastty-container-")), "the marker is removed from the project");

  const slow = fakeEngine({ createDelayMs: 150, createFails: true });
  env = createContainerEnvironment({ dataDir, readSettings: async () => ({ image: "img:1" }), detect: slow.detect, run: slow.run, attach: slow.attach });
  const again = await env.prepare({ sessionId: SID, provider: "terminal", cwd: local, options: {} });
  assert.match(again.refuse.reason, /create refused/);
  const createAt = slow.calls.indexOf("container create");
  assert.ok(slow.calls.lastIndexOf("container ls") > createAt, "the card's containers are looked up only after the create settled");
  assert.equal(git(local, "worktree", "list").split("\n").length, 1, "the owned copy is removed");

  const none = createContainerEnvironment({ dataDir, readSettings: async () => ({}), detect: slow.detect, run: slow.run });
  assert.match((await none.prepare({ sessionId: SID, provider: "terminal", cwd: local, options: {} })).refuse.reason, /No container image/);
  const noEngine = createContainerEnvironment({ dataDir, readSettings: async () => ({ image: "i" }), detect: () => detectLocalEngine({ preferred: "podman", dataDir, run: async () => { throw new Error("connect: no machine"); } }) });
  assert.match((await noEngine.prepare({ sessionId: SID, provider: "terminal", cwd: local, options: {} })).refuse.reason, /No container engine can be used|Podman/);
});

test("remote container: probe, create (checked before start), start, exec over ssh -tt; a failed start cleans up after create", async (t) => {
  const dataDir = await temp(t, "data");
  const fake = fakeEngine();
  const scripts = [];
  let failStart = false;
  const transportFor = () => async (script, args) => {
    const name = script === PROBE ? "probe" : script === CREATE ? "create" : script === START ? "start" : script === RELEASE ? "release" : "?";
    scripts.push(name);
    const ok = (text) => ({ code: 0, stdout: Buffer.from(text), stderr: "", timedOut: false });
    if (name === "probe") {
      return ok(`@real /srv/site\n@top /srv/site\n@owner 0:0 0:0\n@info\n${JSON.stringify({ host: { os: "linux", cgroupVersion: "v2", cgroupControllers: ["cpu", "memory", "pids"], security: { rootless: false }, hostname: "box" } })}\n@image\n${JSON.stringify([{ Id: "a".repeat(64), Os: "linux", Config: {} }])}\n`);
    }
    if (name === "create") {
      const id = (await fake.run(fake.engine, args.slice(8))).trim();
      return ok(`@id ${id}\n@inspect\n${await fake.run(fake.engine, ["container", "inspect", id])}\n`);
    }
    if (name === "start") {
      if (failStart) return ok(`@failed\nCanvasTTY container check failed: CPU limit.\n@inspect\n${await fake.run(fake.engine, ["container", "inspect", args[1]])}\n`);
      fake.containers.get(args[1]).running = true;
      return ok(`@ready\n@inspect\n${await fake.run(fake.engine, ["container", "inspect", args[1]])}\n`);
    }
    if (name === "release") return ok("");
    return { code: 1, stdout: Buffer.alloc(0), stderr: "?", timedOut: false };
  };
  // Podman's inspect reports capabilities as empty sets, not CapDrop: the podman branch of the check.
  const podmanInspect = fake.run;
  fake.run = async (engine, words) => {
    const out = await podmanInspect(engine, words);
    if (words[1] !== "inspect") return out;
    const [v] = JSON.parse(out);
    v.EffectiveCaps = []; v.BoundingCaps = []; v.HostConfig.CgroupMode = "private"; v.Mounts[0].Options = ["bind", "rprivate"];
    return JSON.stringify([v]);
  };
  const hosts = [{ label: "Box", sshHost: "box", workspaces: [{ localPath: "/Users/me/project", remotePath: "/srv/site" }] }];
  const env = createRemoteContainerEnvironment({ dataDir, readSettings: async () => ({ image: "img:1" }), readHosts: async () => hosts, transportFor });
  const prepared = await env.prepare({ sessionId: SID, provider: "terminal", cwd: "/Users/me/project", options: {} });
  assert.ok(prepared.ref, JSON.stringify(prepared));
  assert.deepEqual(scripts, ["probe", "create", "start"]);
  assert.equal(prepared.ref.workspace, "/srv/.canvastty-work/site-0a1b2c3d");
  assert.equal(prepared.ref.user, "0:0");
  assert.equal(prepared.label, "container img:1 on Box");
  const wrapped = env.wrap({ ref: prepared.ref, provider: "terminal", command: "/bin/zsh", args: [] });
  assert.equal(wrapped.command, "ssh");
  assert.equal(wrapped.args[0], "-tt");
  assert.match(wrapped.args.at(-1), /^exec 'podman' 'exec' '-it' '-e' 'CANVASTTY_CONTAINER_RECIPE=\{"cwd":"\/workspace","command":"shell","args":\[\],"pass":\[\]\}' '[0-9a-f]{64}' 'python3'/u);
  assert.ok(wrapped.args.every((arg) => arg.length <= 8192));
  assert.deepEqual(await env.resume({ sessionId: SID, ref: prepared.ref }), { ok: true });
  await env.release({ sessionId: SID, ref: prepared.ref, keepData: false });
  assert.equal(scripts.at(-1), "release");

  failStart = true;
  scripts.length = 0;
  const refused = await env.prepare({ sessionId: SID, provider: "terminal", cwd: "/Users/me/project", options: {} });
  assert.match(refused.refuse.reason, /CPU limit/);
  assert.deepEqual(scripts, ["probe", "create", "start", "release"], "cleanup runs after the create call settled");
  assert.match((await env.prepare({ sessionId: SID, provider: "terminal", cwd: "/elsewhere", options: {} })).refuse.reason, /not mapped/);
});

test("real engine: a terminal card's container on this computer (CTTY_TEST_IMAGE=<image with python3>)", { skip: !process.env.CTTY_TEST_IMAGE }, async (t) => {
  const local = await repo(t, "project");
  const dataDir = await temp(t, "data");
  const env = createContainerEnvironment({ dataDir, readSettings: async () => ({ image: process.env.CTTY_TEST_IMAGE }) });
  const prepared = await env.prepare({ sessionId: SID, provider: "terminal", cwd: local, options: {} });
  assert.ok(prepared.ref, JSON.stringify(prepared));
  try {
    const { command, args } = env.wrap({ ref: prepared.ref, provider: "terminal", command: "/bin/sh", args: [], env: {}, secretEnvNames: [] });
    const out = execFileSync(command, args.map((word) => (word === "-it" ? "-i" : word)), { input: "pwd; echo from-container > made.txt; exit\n", encoding: "utf8" });
    assert.match(out, /\/workspace/);
    assert.ok(existsSync(join(prepared.ref.workspace, "made.txt")));
  } finally {
    await env.release({ sessionId: SID, ref: prepared.ref, keepData: false });
  }
  assert.ok(!existsSync(prepared.ref.workspace));
});

function pythonAvailable() {
  try {
    execFileSync("python3", ["-c", "1"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
