// The bundled service files as CanvasTTY runs them: a child process speaking JSON-RPC lines, with the host's calls
// (storage, sessions, badges) answered by the test. Also checks the manifest's file integrity.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fakeSsh, git, repo, temp } from "./helpers.mjs";

const root = new URL("../", import.meta.url).pathname;
const PLUGIN = "canvastty-environments";

function startService(t, name, { dataDir, env = {}, host = {} }) {
  const child = spawn(process.execPath, [join(root, "services", `${name}.mjs`)], { cwd: root, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => child.kill());
  const waiting = new Map();
  const hostCalls = [];
  let nextId = 1;
  const write = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  createInterface({ input: child.stdout }).on("line", async (line) => {
    const message = JSON.parse(line);
    if (message.method && message.id !== undefined) {
      hostCalls.push({ method: message.method, params: message.params });
      try {
        const handler = host[message.method];
        if (!handler) throw new Error(`host: ${message.method} not allowed`);
        write({ id: message.id, result: (await handler(message.params)) ?? null });
      } catch (error) {
        write({ id: message.id, error: { code: -32000, message: error.message } });
      }
      return;
    }
    if (message.method) return;
    const waiter = waiting.get(message.id);
    waiting.delete(message.id);
    if (message.error) waiter?.reject(new Error(message.error.message));
    else waiter?.resolve(message.result);
  });
  write({ method: "canvastty.initialize", params: { apiVersion: 2, pluginId: PLUGIN, serviceId: name, dataDir, locale: "en", hostVersion: "test" } });
  return {
    hostCalls,
    notify: (method, params) => write({ method, params }),
    request: (method, params) => new Promise((resolve, reject) => {
      const id = `t${nextId++}`;
      waiting.set(id, { resolve, reject });
      write({ id, method, params });
    })
  };
}

test("the manifest's coreFiles and module files match the package bytes (what the installer checks)", () => {
  const manifest = JSON.parse(readFileSync(join(root, "canvastty.plugin.json"), "utf8"));
  const files = [...manifest.coreFiles, ...manifest.modules.flatMap((module) => module.files)];
  for (const file of files) {
    const bytes = readFileSync(join(root, file.path));
    assert.equal(bytes.length, file.bytes, file.path);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, `${file.path}: run npm run build`);
  }
  for (const service of manifest.services) {
    const module = manifest.modules.find((candidate) => candidate.id === service.module);
    assert.ok(module.files.some((file) => file.path === service.entry), `${service.entry} is declared by module ${service.module}`);
    assert.doesNotMatch(readFileSync(join(root, service.entry), "utf8"), /^import .* from "\.\.?\//mu, `${service.entry} is bundled`);
  }
});

test("the manifest passes CanvasTTY's own validator (when CANVASTTY_REPO points at a checkout)", { skip: !process.env.CANVASTTY_REPO }, async () => {
  const { validatePluginManifest } = await import(join(process.env.CANVASTTY_REPO, "src/main/services/PluginManager.ts"));
  const manifest = validatePluginManifest(JSON.parse(readFileSync(join(root, "canvastty.plugin.json"), "utf8")));
  assert.deepEqual(manifest.services.map((service) => service.id), ["worktree", "ssh-host", "container", "remote-container", "results"]);
});

test("ssh-host service: hosts from plugin storage, prepare checks the folder, wrap is ssh -tt, resume reports why", async (t) => {
  const ssh = await fakeSsh(t);
  const local = await repo(t, "local");
  const remote = await temp(t, "remote");
  let hosts = [
    { label: "Box", sshHost: "box", sshUser: "root", workspaces: [{ localPath: local, remotePath: remote }] },
    { label: "Down", sshHost: "down", workspaces: [{ localPath: local, remotePath: remote }] }
  ];
  const service = startService(t, "ssh-host", {
    dataDir: await temp(t, "data"), env: { PATH: `${ssh.dir}:${process.env.PATH}` },
    host: { "storage.get": ({ key }) => (key === "hosts" ? hosts : null) }
  });
  const prepared = await service.request("canvastty.environment.prepare", { sessionId: "s1", kind: "ssh-host", provider: "terminal", cwd: local, options: {} });
  assert.deepEqual(prepared, { ref: { host: { label: "Box", sshHost: "box", sshUser: "root" }, remoteFolder: remote, localFolder: local }, label: "ssh Box" });
  const wrapped = await service.request("canvastty.environment.wrap", { sessionId: "s1", kind: "ssh-host", ref: prepared.ref, provider: "terminal",
    command: "/bin/zsh", args: ["-l"], env: {}, secretEnvNames: [], cwd: local });
  assert.equal(wrapped.command, "ssh");
  assert.deepEqual(wrapped.args.slice(-3), ["--", "root@box", `cd '${remote}' && exec "\${SHELL:-/bin/sh}" -l`]);
  assert.equal(wrapped.args[0], "-tt");
  assert.deepEqual(await service.request("canvastty.environment.resume", { ref: prepared.ref }), { ok: true });
  assert.deepEqual(await service.request("canvastty.environment.describe", { ref: prepared.ref }), { label: "ssh Box", detail: `root@box ${remote}` });
  assert.deepEqual(await service.request("canvastty.environment.release", { ref: prepared.ref, keepData: false }), {});
  assert.ok(existsSync(remote), "release never deletes on the server");
  const stopped = await service.request("canvastty.environment.resume", { ref: { ...prepared.ref, remoteFolder: join(remote, "gone") } });
  assert.match(stopped.stopped.reason, /does not exist on Box/u);
  const down = await service.request("canvastty.environment.resume", { ref: { ...prepared.ref, host: { label: "Down", sshHost: "down" } } });
  assert.match(down.stopped.reason, /cannot be reached over ssh: ssh: connect to host down/u);
  // Refusals name what to fix.
  const prepare = (options, cwd = local) => service.request("canvastty.environment.prepare", { sessionId: "s2", kind: "ssh-host", provider: "terminal", cwd, options });
  assert.match((await prepare({ host: "Down" })).refuse.reason, /cannot be reached/u);
  assert.match((await prepare({ host: "nope" })).refuse.reason, /No configured server is called nope/u);
  assert.match((await prepare({}, remote)).refuse.reason, /not mapped to a folder on Box/u);
  hosts = [{ label: "Evil", sshHost: "-oProxyCommand=touch /tmp/pwned", workspaces: [] }];
  assert.match((await prepare({})).refuse.reason, /No server is configured yet/u);
  assert.deepEqual((await service.request("check", { label: "Box" })), { ok: false, message: "No such server in the saved settings." });
});

test("results service: the card action and the orchestrator tool collect only this plugin's cards and the caller's subagents", async (t) => {
  const ssh = await fakeSsh(t);
  const local = await repo(t, "local");
  const server = join(await temp(t, "server"), "site");
  git(local, "clone", "-q", local, server);
  await writeFile(join(server, "live.txt"), "written on the server\n");
  const badges = [];
  const summary = (id, extra = {}) => ({ id, provider: "terminal", role: "agent", title: "Site", status: "running", exitCode: null, cwd: local,
    workingDirectory: local, startedAt: 1, ...extra });
  const onServer = summary("aa11bb22-card", { parentSessionId: "orch", environment: { pluginId: PLUGIN, kind: "ssh-host", label: "ssh Box",
    ref: { host: { label: "Box", sshHost: "box" }, remoteFolder: server, localFolder: local } } });
  const service = startService(t, "results", {
    dataDir: await temp(t, "data"), env: { PATH: `${ssh.dir}:${process.env.PATH}` },
    host: { "sessions.subscribe": () => ({ sessions: [onServer, summary("stranger", { parentSessionId: "someone-else" })] }),
      "cards.setBadge": (params) => { badges.push(params); return null; } }
  });
  const orchestrator = summary("orch", { role: "orchestrator" });
  const call = (input, caller = orchestrator) => service.request("canvastty.tools.call", { tool: "collect", callerSessionId: caller.id, caller, input });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(await call({ sessionId: "stranger" }), { content: "That session is not one of your subagents.", isError: true });
  assert.match((await call({})).content, /already there/u);
  const collected = await call({ sessionId: "aa11bb22-card" });
  assert.equal(collected.isError, false, collected.content);
  assert.match(collected.content, /Collected into branch canvastty\/aa11bb22-site/u);
  assert.equal(git(local, "show", "canvastty/aa11bb22-site:live.txt"), "written on the server");
  // The card action does the same and marks the card.
  const toast = await service.request("canvastty.cards.invoke", { actionId: "collect-changes", sessionId: onServer.id, session: onServer });
  assert.equal(toast.tone, "info");
  assert.match(toast.message, /canvastty\/aa11bb22-site-2/u);
  assert.deepEqual(badges, [{ sessionId: onServer.id, badge: { text: "collected", tone: "info", tooltip: "Local branch canvastty/aa11bb22-site-2" } }]);
  // A new subagent learned from events.
  service.notify("canvastty.sessions.event", { type: "created", owned: false, session: summary("new-child", { parentSessionId: "orch" }) });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.match((await call({ sessionId: "new-child" })).content, /already there/u);
  await assert.rejects(service.request("canvastty.tools.call", { tool: "other", caller: orchestrator, input: {} }), /Unknown tool/u);
});

test("results service: a tool call for a subagent while the card list is still loading waits for it instead of refusing", async (t) => {
  const local = await repo(t, "local");
  let answerList;
  const list = new Promise((resolve) => { answerList = resolve; });
  const child = { id: "child-1", provider: "terminal", role: "agent", title: "Child", status: "running", exitCode: null, cwd: local, workingDirectory: local, startedAt: 1, parentSessionId: "orch" };
  const service = startService(t, "results", { dataDir: await temp(t, "data"), host: { "sessions.subscribe": () => list, "cards.setBadge": () => null } });
  const orchestrator = { ...child, id: "orch", role: "orchestrator", parentSessionId: undefined };
  await new Promise((resolve) => setTimeout(resolve, 150));
  const asked = service.request("canvastty.tools.call", { tool: "collect", caller: orchestrator, input: { sessionId: "child-1" } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  answerList({ sessions: [child] });
  assert.match((await asked).content, /already there/u);
});

test("container services over JSON-RPC: refusals name what to fix; the capsule tool and actions answer from the results service", async (t) => {
  const local = await repo(t, "local");
  let settings = null;
  const storage = { "storage.get": ({ key }) => (key === "containers" ? settings : key === "hosts" ? [] : null) };
  const container = startService(t, "container", { dataDir: await temp(t, "data"), host: storage });
  const prepare = (service, kind, options = {}) => service.request("canvastty.environment.prepare", { sessionId: "s1", kind, provider: "terminal", cwd: local, options });
  assert.match((await prepare(container, "container")).refuse.reason, /No container image is set/u);
  settings = { image: "bad image" };
  assert.match((await prepare(container, "container", { image: "bad image" })).refuse.reason, /not a valid image name/u);
  const remote = startService(t, "remote-container", { dataDir: await temp(t, "data"), host: storage });
  assert.match((await prepare(remote, "remote-container")).refuse.reason, /No server is configured yet/u);
  await assert.rejects(container.request("canvastty.environment.resume", { sessionId: "s1", ref: { name: "x" } }), /unreadable/u);

  settings = { image: "img:1" };
  const results = startService(t, "results", { dataDir: await temp(t, "data"),
    host: { ...storage, "sessions.subscribe": () => ({ sessions: [] }), "cards.setBadge": () => null } });
  const card = { id: "c1", provider: "terminal", role: "orchestrator", title: "Mine", status: "running", cwd: local, workingDirectory: local, startedAt: 1 };
  await new Promise((resolve) => setTimeout(resolve, 200));
  const tool = await results.request("canvastty.tools.call", { tool: "capsule", caller: card, input: { action: "run" } });
  assert.deepEqual(tool, { content: "No check command is set: add one in the plugin's Settings (Containers → Check command), for example `npm test`.", isError: true });
  const applied = await results.request("canvastty.cards.invoke", { actionId: "capsule-apply", sessionId: "c1", session: card });
  assert.equal(applied.tone, "error");
  assert.match(applied.message, /no capsule check yet/u);
});
