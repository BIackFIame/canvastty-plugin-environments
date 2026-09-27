// Capsule checks (part of the `results` module): the saved check command runs on a SNAPSHOT of a card's work, in an
// isolated container, never in the card's folder and never in the person's checkout.
// 1. Snapshot: the card's working tree is committed with a temporary index (as Collect changes does; credential files
//    left out); a ref refs/canvastty/capsules/<id> keeps that commit in the local repository. No branch is touched.
// 2. Capsule: `git archive` of the snapshot is unpacked into the plugin's data folder and mounted as /workspace of a
//    new container (the container module's fixed recipe, network none), whose bootstrap runs the command once.
// 3. Result: pass/fail, exit code and the log tail are kept (plugin data) and shown on the card; the container and
//    the unpacked copy are removed.
// 4. Apply: a passed snapshot becomes a new local branch canvastty/<id8>-<title>-checked. Nothing is merged.
// Ported and cut down from the CanvasTTY chain (CapsuleTestService / TaskCapsuleService): the chain's frozen
// file-by-file manifests and its launch of agents on selected files are not ported.
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, rm, rename, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  CollectionRefusal, SNAPSHOT, budgetFrom, collectionBranchName, freeBranch, git, inspect, localRepository, localTransport, pathspecs, refusal, refuseCredentials
} from "./collect.mjs";
import { normalizeContainerSettings } from "./containerSettings.mjs";
import {
  attachEngine, containerUser, createArgs, detectLocalEngine, markerName, parseImage, recipe, runEngine, verifyInspection
} from "./engine.mjs";

const MAX_RECORDS = 50;
const LOG_TAIL = 4_000;
const COMMIT = /^[0-9a-f]{40,64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const stripAnsi = (text) => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, "").replace(/\r/gu, "");

export function createCapsules({ pluginId, dataDir, readSettings, setBadge = async () => {}, detect = detectLocalEngine, run = runEngine,
  attach = attachEngine, snapshotTimeoutMs = 10_000 }) {
  const root = resolve(dataDir, "capsules");
  const worktreesRoot = resolve(dataDir, "worktrees");
  const records = new Map();
  const running = new Map();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(root).filter((file) => file.endsWith(".json"))) {
    try {
      const record = JSON.parse(readFileSync(join(root, name), "utf8"));
      if (!UUID.test(record.id) || !COMMIT.test(record.tip)) continue;
      // A check the service did not see finish (the app quit, the service restarted): never rerun on its own.
      if (record.status === "running") Object.assign(record, { status: "interrupted", finishedAt: record.startedAt });
      records.set(record.id, record);
    } catch { /* unreadable record: ignored */ }
  }

  const save = async (record) => {
    const file = join(root, `${record.id}.json`);
    await writeFile(`${file}.tmp`, JSON.stringify(record), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  };
  const latest = (sessionId) => [...records.values()].filter((record) => record.sessionId === sessionId).sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;

  /** The folder a card works in on this computer, the repository it belongs to, and where its work started. */
  async function source(session) {
    const environment = session.environment;
    if (!environment) {
      const folder = session.workingDirectory ?? session.cwd;
      return { folder, repository: await localRepository(folder), base: null };
    }
    if (environment.pluginId !== pluginId || !["worktree", "container"].includes(environment.kind)) {
      throw new CollectionRefusal("Capsule checks run on this computer: collect this card's changes first (Collect changes), then check them from a worktree card.");
    }
    const ref = environment.ref ?? {};
    const folder = resolve(String(environment.kind === "worktree" ? ref.dir : ref.workspace));
    if (environment.kind === "worktree" || ref.mode === "copy") {
      const owned = environment.kind === "worktree" ? ref : ref.worktree ?? {};
      if (!folder.startsWith(worktreesRoot + sep) || typeof owned.repo !== "string") throw new CollectionRefusal("This card's folder does not belong to the plugin.");
      return { folder, repository: await localRepository(owned.repo), base: COMMIT.test(String(owned.base)) ? owned.base : null };
    }
    return { folder, repository: await localRepository(folder), base: null };
  }

  function unpack(repository, tip, directory) {
    return new Promise((done, fail) => {
      const archive = spawn("git", ["-c", "core.hooksPath=/dev/null", "-C", repository, "archive", "--format=tar", tip], { stdio: ["ignore", "pipe", "pipe"] });
      const tar = spawn("tar", ["-x", "-C", directory], { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      archive.stderr.on("data", (chunk) => { stderr += chunk; });
      tar.stderr.on("data", (chunk) => { stderr += chunk; });
      archive.stdout.pipe(tar.stdin);
      let codes = 0;
      const settle = (code) => {
        if (code !== 0) return fail(new Error(`unpacking the snapshot failed: ${stderr.slice(0, 200)}`));
        if (++codes === 2) done();
      };
      archive.on("close", settle);
      tar.on("close", settle);
      archive.on("error", fail);
      tar.on("error", fail);
    });
  }

  async function execute(record, engine, settings) {
    const directory = join(root, record.id, "workspace");
    const name = `canvastty-${randomUUID()}`, token = randomUUID();
    const limits = { cpus: settings.cpus, memoryMb: settings.memoryMb, pids: settings.pids };
    let created = null;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await unpack(record.repository, record.tip, directory);
      const { id: imageId } = parseImage(await run(engine, ["image", "inspect", record.image], { timeoutMs: 8_000 }));
      const info = statSync(directory);
      const user = containerUser(engine.kind, engine.rootless, `${info.uid}:${info.gid}`);
      await writeFile(join(directory, markerName(token)), token, { mode: 0o600 });
      created = run(engine, createArgs({ kind: engine.kind, name, sessionId: record.sessionId, workspace: directory, user, network: "none", limits, image: record.image,
        recipe: recipe({ mode: "check", limits, marker: { name: markerName(token), token }, command: record.command }) }), { timeoutMs: 20_000 }).then((out) => out.trim());
      const containerId = await created;
      const expected = { kind: engine.kind, name, sessionId: record.sessionId, workspace: directory, user, network: "none", limits, imageId, containerId };
      verifyInspection(expected, await run(engine, ["container", "inspect", containerId], { timeoutMs: 8_000 }));
      const attached = await attach(engine, containerId, { timeoutMs: settings.checkTimeoutSec * 1000 });
      const state = attached.timedOut ? null : verifyInspection(expected, await run(engine, ["container", "inspect", containerId], { timeoutMs: 8_000 }));
      const output = stripAnsi(attached.output);
      record.logTail = output.slice(-LOG_TAIL);
      record.exitCode = state?.exitCode ?? null;
      if (attached.timedOut) Object.assign(record, { status: "failed", reason: `the check ran longer than ${settings.checkTimeoutSec} s and was stopped` });
      else if (state.exitCode === 78 && output.includes("CanvasTTY container check failed")) Object.assign(record, { status: "error", reason: output.match(/CanvasTTY container check failed: [^\n]*/u)[0] });
      else record.status = state.exitCode === 0 ? "passed" : "failed";
    } catch (error) {
      Object.assign(record, { status: "error", reason: String(error.message).slice(0, 400) });
    } finally {
      // Fenced: the create request has settled before the container is looked up and removed.
      if (created) {
        await created.catch(() => undefined);
        await run(engine, ["container", "rm", "--force", name], { timeoutMs: 15_000 }).catch(() => undefined);
      }
      await rm(join(root, record.id), { recursive: true, force: true }).catch(() => undefined);
      record.finishedAt = Date.now();
      // Only a passed snapshot can be applied; any other keeps no ref in the person's repository.
      if (record.status !== "passed") await git(record.repository, ["update-ref", "-d", `refs/canvastty/capsules/${record.id}`]).catch(() => undefined);
      await save(record).catch(() => undefined);
      const tone = record.status === "passed" ? "info" : "error";
      const text = record.status === "passed" ? "checks passed" : record.status === "failed" ? "checks failed" : "check error";
      const lastLine = (record.logTail ?? "").trim().split("\n").pop() ?? "";
      await setBadge(record.sessionId, { text, tone, tooltip: `${record.command.slice(0, 60)} → ${record.exitCode ?? record.reason ?? "?"} · ${lastLine}`.slice(0, 200) }).catch(() => undefined);
    }
  }

  function describe(record, { forToast = false } = {}) {
    const seconds = record.finishedAt ? Math.max(1, Math.round((record.finishedAt - record.startedAt) / 1000)) : null;
    const head = {
      running: `Checks are running in capsule ${record.id.slice(0, 8)} (\`${record.command}\`); the card's badge shows the result, then choose Show check result.`,
      passed: `Checks passed in capsule ${record.id.slice(0, 8)}: \`${record.command}\` exited 0 in ${seconds} s. Apply checked snapshot makes it a local branch.`,
      failed: `Checks failed in capsule ${record.id.slice(0, 8)}: \`${record.command}\` ${record.reason ?? `exited ${record.exitCode}`}${seconds ? ` after ${seconds} s` : ""}.`,
      error: `The check could not run: ${record.reason ?? "unknown error"}.`,
      interrupted: `The check in capsule ${record.id.slice(0, 8)} was interrupted (the app or the service stopped); run it again.`
    }[record.status] ?? `Capsule ${record.id.slice(0, 8)}: ${record.status}.`;
    const lines = [head, `Snapshot ${record.tip.slice(0, 12)} of the card's work (based on ${record.base.slice(0, 12)}).`];
    if (record.excluded?.length) lines.push(`Left out (credential files) ${record.excluded.slice(0, 10).join(", ")}.`);
    if (record.appliedBranch) lines.push(`Applied as branch ${record.appliedBranch}.`);
    if (record.logTail) {
      const tail = record.logTail.trim().split("\n").slice(-(forToast ? 12 : 60)).join("\n");
      lines.push("--- last lines ---", forToast ? tail.slice(-900) : tail);
    }
    return lines.join("\n");
  }

  /** ok: the check ran (a failed check is a result, not an error); passed: what the card's toast tone shows. */
  const answer = (record, forToast) => ({ ok: record.status !== "error", passed: ["passed", "running"].includes(record.status), text: describe(record, { forToast }) });
  const waitFor = (task, ms) => Promise.race([task, new Promise((done) => setTimeout(done, ms))]);

  return {
    /** Snapshots the card and starts its check; answers when it finished or after waitMs. */
    async run(session, { waitMs = 12_000, forToast = false } = {}) {
      if (running.has(session.id)) {
        await waitFor(running.get(session.id), waitMs);
        return answer(latest(session.id), forToast);
      }
      const settings = normalizeContainerSettings(await readSettings());
      if (!settings.checkCommand.trim()) return { ok: false, text: "No check command is set: add one in the plugin's Settings (Containers → Check command), for example `npm test`." };
      if (!settings.image) return { ok: false, text: "No container image is set: choose one in the plugin's Settings (an existing image with python3 and what the check needs)." };
      const budget = budgetFrom(snapshotTimeoutMs);
      let record;
      try {
        const engine = await detect({ preferred: settings.engine, dataDir, run });
        const { folder, repository, base } = await source(session);
        const { changed } = await inspect(localTransport, folder, budget);
        const { input, excluded } = pathspecs(changed);
        const snapshot = await localTransport(SNAPSHOT, [folder], input, budget());
        if (snapshot.code !== 0) throw refusal(snapshot, "Taking the snapshot");
        const [head, tip] = snapshot.stdout.toString("utf8").trim().split(" ");
        if (!COMMIT.test(head) || !COMMIT.test(tip)) throw new Error("Taking the snapshot returned no commit.");
        record = { id: randomUUID(), sessionId: session.id, title: String(session.title ?? ""), repository, base: base ?? head, tip, command: settings.checkCommand,
          image: settings.image, excluded, status: "running", startedAt: Date.now() };
        await git(repository, ["update-ref", `refs/canvastty/capsules/${record.id}`, tip], { timeoutMs: budget() });
        records.set(record.id, record);
        await save(record);
        for (const old of [...records.values()].sort((a, b) => b.startedAt - a.startedAt).slice(MAX_RECORDS)) {
          records.delete(old.id);
          await rm(join(root, `${old.id}.json`), { force: true });
          await git(old.repository, ["update-ref", "-d", `refs/canvastty/capsules/${old.id}`]).catch(() => undefined);
        }
        await setBadge(session.id, { text: "checking…", tone: "neutral", tooltip: `${settings.checkCommand.slice(0, 80)} in capsule ${record.id.slice(0, 8)}` }).catch(() => undefined);
        const task = execute(record, engine, settings).finally(() => running.delete(session.id));
        running.set(session.id, task);
      } catch (error) {
        const text = error instanceof CollectionRefusal ? `Nothing was checked: ${error.message}` : `The check could not start: ${error.message}`;
        return { ok: false, text };
      }
      await waitFor(running.get(session.id), waitMs);
      return answer(record, forToast);
    },

    async result(session, { waitMs = 12_000, forToast = false } = {}) {
      if (running.has(session.id)) await waitFor(running.get(session.id), waitMs);
      const record = latest(session.id);
      return record ? answer(record, forToast) : { ok: false, text: "This card has no capsule check yet: choose Run checks in a capsule." };
    },

    /** A passed snapshot becomes a new local branch; the person's branch and working tree are not touched. */
    async apply(session) {
      const record = latest(session.id);
      if (!record) return { ok: false, text: "This card has no capsule check yet: choose Run checks in a capsule." };
      if (record.status === "running") return { ok: false, text: "The check is still running; apply it when it passed." };
      if (record.appliedBranch) return { ok: true, text: `Already applied as branch ${record.appliedBranch}.`, branch: record.appliedBranch };
      if (record.status !== "passed") return { ok: false, text: `Only a passed snapshot is applied; the last check ${record.status === "failed" ? "failed" : "did not run"}. Fix it and run checks again, or use Collect changes to take the work as it is.` };
      try {
        const names = (await git(record.repository, ["diff", "--name-only", "--no-renames", "-z", record.base, record.tip])).split("\0").filter(Boolean);
        refuseCredentials(names);
        const branch = await freeBranch(record.repository, `${collectionBranchName(session.id, session.title ?? record.title)}-checked`);
        await git(record.repository, ["branch", "--no-track", "--", branch, record.tip]);
        await git(record.repository, ["update-ref", "-d", `refs/canvastty/capsules/${record.id}`]).catch(() => undefined);
        record.appliedBranch = branch;
        await save(record);
        const stat = (await git(record.repository, ["diff", "--stat=100", "--no-color", "--no-ext-diff", record.base, record.tip, "--"])).trim().split("\n").slice(-20).join("\n");
        return { ok: true, branch, text: `Applied the checked snapshot as branch ${branch} (based on ${record.base.slice(0, 12)}). Nothing was merged.${stat ? `\n${stat}` : ""}` };
      } catch (error) {
        return { ok: false, text: error instanceof CollectionRefusal ? `Nothing was applied: ${error.message}` : `Applying failed: ${error.message}` };
      }
    }
  };
}
