// Capsule checks against a fake engine whose "container" runs the check with /bin/sh in the mounted snapshot folder:
// the snapshot leaves credentials out and never touches the card's folder or the person's branch; pass and fail are
// reported with the log tail; only a passed snapshot is applied, as a new branch; an unfinished check is reported as
// interrupted after a restart.
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createCapsules } from "../src/capsules.mjs";
import { createWorktreeEnvironment } from "../src/worktree.mjs";
import { fakeEngine, git, repo, temp } from "./helpers.mjs";

const PLUGIN = "canvastty-environments";

async function setup(t) {
  const local = await repo(t, "project");
  const dataDir = await temp(t, "data");
  const worktrees = createWorktreeEnvironment({ dataDir });
  const { ref } = await worktrees.prepare({ sessionId: "c0ffee00-1111-2222-3333-444455556666", cwd: local, options: {} });
  writeFileSync(join(ref.dir, "work.txt"), "agent work\n");
  writeFileSync(join(ref.dir, ".env"), "TOKEN=do-not-copy\n");
  const session = { id: "c0ffee00-1111-2222-3333-444455556666", title: "Fix the parser", environment: { pluginId: PLUGIN, kind: "worktree", label: "worktree", ref } };
  return { local, dataDir, ref, session };
}

function capsulesWith(dataDir, settings, fake, badges) {
  return createCapsules({ pluginId: PLUGIN, dataDir, readSettings: async () => settings(), detect: fake.detect, run: fake.run, attach: fake.attach,
    setBadge: async (sessionId, badge) => badges.push(badge.text) });
}

test("a passing check runs on a snapshot (credentials left out) and applies as a new branch; the person's branch is untouched", async (t) => {
  const { local, dataDir, ref, session } = await setup(t);
  const fake = fakeEngine();
  const badges = [];
  const capsules = capsulesWith(dataDir, () => ({ image: "img:1", checkCommand: "test -f work.txt && test ! -e .env && echo CHECK-OK" }), fake, badges);
  const ran = await capsules.run(session, { forToast: true });
  assert.equal(ran.ok, true, ran.text);
  assert.match(ran.text, /Checks passed in capsule [0-9a-f]{8}/);
  assert.match(ran.text, /Left out \(credential files\) \.env/);
  assert.match(ran.text, /CHECK-OK/);
  assert.deepEqual(badges, ["checking…", "checks passed"]);
  assert.equal(fake.containers.size, 0, "the check container is removed");
  assert.deepEqual(readdirSync(join(dataDir, "capsules")).filter((name) => !name.endsWith(".json")), [], "the unpacked copy is removed");
  const [created] = fake.calls.filter((call) => call === "container create");
  assert.ok(created);
  assert.match(git(local, "for-each-ref", "--format=%(refname)", "refs/canvastty/capsules"), /^refs\/canvastty\/capsules\/[0-9a-f-]{36}$/u);
  assert.equal(git(ref.dir, "status", "--porcelain"), "?? .env\n?? work.txt".trim(), "the card's folder is as it was");

  const applied = await capsules.apply(session);
  assert.equal(applied.ok, true, applied.text);
  assert.equal(applied.branch, "canvastty/c0ffee00-fix-the-parser-checked");
  assert.equal(git(local, "show", `${applied.branch}:work.txt`), "agent work");
  assert.throws(() => git(local, "show", `${applied.branch}:.env`));
  assert.equal(git(local, "branch", "--show-current"), "main");
  assert.equal(git(local, "status", "--porcelain"), "");
  assert.equal(git(local, "for-each-ref", "refs/canvastty/capsules"), "", "the capsule ref is dropped once applied");
  assert.match((await capsules.apply(session)).text, /Already applied/);
});

test("a failing check reports the exit code and log tail, keeps no ref and cannot be applied", async (t) => {
  const { local, dataDir, session } = await setup(t);
  const fake = fakeEngine();
  const badges = [];
  const capsules = capsulesWith(dataDir, () => ({ image: "img:1", checkCommand: "echo 'FAIL: 2 tests'; exit 3" }), fake, badges);
  const ran = await capsules.run(session);
  assert.match(ran.text, /Checks failed in capsule [0-9a-f]{8}: `echo 'FAIL: 2 tests'; exit 3` exited 3/);
  assert.match(ran.text, /FAIL: 2 tests/);
  assert.deepEqual(badges, ["checking…", "checks failed"]);
  assert.equal(git(local, "for-each-ref", "refs/canvastty/capsules"), "");
  const applied = await capsules.apply(session);
  assert.equal(applied.ok, false);
  assert.match(applied.text, /Only a passed snapshot is applied/);
  assert.equal(git(local, "branch", "--list", "canvastty/*-checked"), "");
  assert.match((await capsules.result(session)).text, /Checks failed/);
});

test("settings, sources and restarts: no command, remote cards, a bootstrap refusal, an interrupted check", async (t) => {
  const { dataDir, session } = await setup(t);
  const fake = fakeEngine();
  let settings = { image: "img:1" };
  const capsules = capsulesWith(dataDir, () => settings, fake, []);
  assert.match((await capsules.run(session)).text, /No check command is set/);
  settings = { image: "img:1", checkCommand: "true" };
  const remote = { ...session, id: "remote-1", environment: { pluginId: PLUGIN, kind: "ssh-host", ref: {} } };
  assert.match((await capsules.run(remote)).text, /Capsule checks run on this computer/);
  const foreign = { ...session, id: "foreign-1", environment: { pluginId: "other", kind: "worktree", ref: session.environment.ref } };
  assert.match((await capsules.run(foreign)).text, /Capsule checks run on this computer/);

  const refusing = fakeEngine({ holdFails: "capabilities are not all dropped" });
  const strict = capsulesWith(dataDir, () => settings, refusing, []);
  const refused = await strict.run(session);
  assert.equal(refused.ok, false);
  assert.match(refused.text, /The check could not run: CanvasTTY container check failed: capabilities are not all dropped/);

  // A record left "running" by a service that stopped is reported as interrupted, never rerun.
  const records = join(dataDir, "capsules");
  const file = readdirSync(records).find((name) => name.endsWith(".json"));
  const saved = JSON.parse((await import("node:fs")).readFileSync(join(records, file), "utf8"));
  writeFileSync(join(records, file), JSON.stringify({ ...saved, status: "running", startedAt: Date.now() + 10_000 }));
  const restarted = capsulesWith(dataDir, () => settings, fake, []);
  assert.match((await restarted.result(session)).text, /was interrupted/);
  assert.ok(existsSync(join(records, file)));
});
