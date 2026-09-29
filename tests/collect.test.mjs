import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { collectRemote, collectWorktree, collectionBranchName, inspect, sshTransport } from "../src/collect.mjs";
import { isCredentialPath } from "../src/credentials.mjs";
import { createResults } from "../src/results.mjs";
import { createWorktreeEnvironment } from "../src/worktree.mjs";
import { fakeSsh, git, repo, temp } from "./helpers.mjs";

const host = { label: "server", sshHost: "server", sshUser: "root" };

/** The person's repository, a "server" clone of it, and a fake ssh whose remote side runs in that clone. */
async function world(t) {
  const local = await repo(t, "local");
  const server = join(await temp(t, "server"), "site");
  execFileSync("git", ["clone", "-q", local, server]);
  const ssh = await fakeSsh(t);
  const serverTmp = await temp(t, "server-tmp");
  process.env.FAKE_SSH_TMP = serverTmp;
  t.after(() => delete process.env.FAKE_SSH_TMP);
  return { local, server, serverTmp, transport: sshTransport(host, { ssh: ssh.path }) };
}

const snapshot = (dir) => ({ head: git(dir, "rev-parse", "HEAD"), branch: git(dir, "branch", "--show-current"), status: git(dir, "status", "--porcelain") });

test("credential paths and branch names", () => {
  for (const path of [".env", "config/.env.production", "id_ed25519", "deploy/server.pem", ".npmrc", "home/.ssh/config", "app/secrets.json"]) {
    assert.ok(isCredentialPath(path), path);
  }
  for (const path of [".env.example", "src/index.js", "README.md", "keyboard.ts"]) assert.ok(!isCredentialPath(path), path);
  assert.equal(collectionBranchName("5f1c2a90-aa11-4b22", "Fix the Login — page!"), "canvastty/5f1c2a90-fix-the-login-page");
  assert.equal(collectionBranchName("", ""), "canvastty/session");
});

test("a server card's work comes home as a local branch over ssh; credentials stay out; nothing is left behind", async (t) => {
  const { local, server, serverTmp, transport } = await world(t);
  // The agent committed once and left uncommitted edits, a new file, an ignored file and a secret.
  await writeFile(join(server, "README.md"), "hello\nfrom the server\n");
  git(server, "commit", "-qam", "server commit");
  await writeFile(join(server, "notes.txt"), "uncommitted\n");
  await writeFile(join(server, ".env"), "TOKEN=do-not-collect\n");
  await mkdir(join(server, "ignored"));
  await writeFile(join(server, "ignored", "cache.bin"), "x");
  const localBefore = snapshot(local);
  const serverBefore = snapshot(server);

  const result = await collectRemote({ sessionId: "5f1c2a90-aa11", title: "Site work", localFolder: local, remoteFolder: server, transport });
  assert.equal(result.state, "collected", result.message);
  assert.equal(result.branch, "canvastty/5f1c2a90-site-work");
  assert.deepEqual(result.excluded, [".env"]);
  assert.equal(result.commits, 2);
  assert.match(result.diffstat, /notes\.txt/u);
  const files = git(local, "ls-tree", "-r", "--name-only", result.branch).split("\n");
  assert.deepEqual(files.sort(), [".gitignore", "README.md", "notes.txt"]);
  assert.equal(git(local, "show", `${result.branch}:notes.txt`), "uncommitted");
  // The person's checkout is untouched; the server's HEAD, index and files too; no ref or temp folder remains.
  assert.deepEqual(snapshot(local), localBefore);
  assert.deepEqual(snapshot(server), serverBefore);
  assert.equal(git(server, "for-each-ref", "refs/canvastty"), "");
  assert.deepEqual(await readdir(serverTmp), []);
  // Again: a new branch next to the first, never over it.
  assert.equal((await collectRemote({ sessionId: "5f1c2a90-aa11", title: "Site work", localFolder: local, remoteFolder: server, transport })).branch,
    "canvastty/5f1c2a90-site-work-2");
});

test("server refusals: nothing changed, committed credentials, unrelated history, unreachable host", async (t) => {
  const { local, server, transport } = await world(t);
  const collect = (extra = {}) => collectRemote({ sessionId: "abcdef12", title: "t", localFolder: local, remoteFolder: server, transport, ...extra });
  assert.equal((await collect()).state, "unchanged");
  await writeFile(join(server, "id_rsa"), "key\n");
  git(server, "add", "id_rsa");
  git(server, "commit", "-qm", "oops");
  await assert.rejects(collect(), /committed files that look like credentials \(id_rsa\)/u);
  assert.equal(git(local, "branch", "--list", "canvastty/*"), "");
  const stranger = await repo(t, "stranger");
  // Same files and second as the local repository would give the same commit id: make its history its own.
  git(stranger, "commit", "--amend", "-qm", "another project");
  await assert.rejects(collect({ remoteFolder: stranger }), /shares no commit/u);
  await assert.rejects(collect({ remoteFolder: join(server, "missing") }), /no longer exists/u);
  const ssh = await fakeSsh(t);
  await assert.rejects(collect({ transport: sshTransport({ label: "down", sshHost: "down" }, { ssh: ssh.path }) }), /Connection refused/u);
});

test("a worktree card: its working tree becomes a branch; the worktree's HEAD and index stay", async (t) => {
  const local = await repo(t, "local");
  const dataDir = await temp(t, "data");
  const worktree = createWorktreeEnvironment({ dataDir });
  const prepared = await worktree.prepare({ sessionId: "77aa88bb-1", cwd: local, options: {} });
  assert.equal(prepared.ref.base, git(local, "rev-parse", "HEAD"));
  await writeFile(join(prepared.ref.dir, "feature.txt"), "work\n");
  await writeFile(join(prepared.ref.dir, ".env.local"), "SECRET=1\n");
  const before = snapshot(prepared.ref.dir);
  const results = createResults({ pluginId: "canvastty-environments", dataDir });
  const session = (environment) => ({ id: "77aa88bb-1", title: "Feature", environment });
  const answer = await results.collect(session({ pluginId: "canvastty-environments", kind: "worktree", label: "w", ref: prepared.ref }));
  assert.ok(answer.ok, answer.text);
  assert.equal(answer.branch, "canvastty/77aa88bb-feature");
  assert.match(answer.text, /Left out \(credential files\) \.env\.local/u);
  assert.equal(git(local, "show", `${answer.branch}:feature.txt`), "work");
  assert.deepEqual(snapshot(prepared.ref.dir), before);
  assert.equal(git(local, "branch", "--show-current"), "main");
  // Cards the plugin did not place are never collected.
  assert.match((await results.collect({ id: "x", title: "x" })).text, /already there/u);
  assert.match((await results.collect(session({ pluginId: "other.plugin", kind: "worktree", label: "Other", ref: prepared.ref }))).text, /another plugin/u);
  const foreign = await results.collect(session({ pluginId: "canvastty-environments", kind: "worktree", label: "w", ref: { ...prepared.ref, dir: local } }));
  assert.equal(foreign.ok, false);
  assert.match(foreign.text, /does not belong to the plugin/u);
  // Direct call with a bad base is refused, not guessed.
  await assert.rejects(collectWorktree({ sessionId: "x", title: "x", sourceFolder: local, worktreeFolder: prepared.ref.dir, baseCommit: "HEAD" }), /starting commit/u);
  await worktree.release({ ref: prepared.ref, keepData: false });
  assert.equal(git(local, "worktree", "list").split("\n").length, 1);
});

test("a changed file name that is not UTF-8 is refused, not turned into a pathspec that misses it", async () => {
  const commit = "a".repeat(40);
  const stdout = Buffer.concat([Buffer.from(`${commit}\n--\n`), Buffer.from("ok.txt\0"), Buffer.from([0x73, 0x65, 0x63, 0xff, 0x2f, 0x2e, 0x65, 0x6e, 0x76, 0x00])]);
  const transport = async () => ({ code: 0, stdout, stderr: "", timedOut: false });
  await assert.rejects(inspect(transport, "/w", () => 1_000), /not valid UTF-8/u);
  const good = async () => ({ code: 0, stdout: Buffer.from(`${commit}\n--\nok.txt\0`), stderr: "", timedOut: false });
  assert.deepEqual((await inspect(good, "/w", () => 1_000)).changed, ["ok.txt"]);
});

test("worktree ownership is by real path and registration: a link, a nested folder or a stranger in the data folder is refused", async (t) => {
  const local = await repo(t, "local");
  const outside = await repo(t, "outside");
  const dataDir = await temp(t, "data");
  const worktree = createWorktreeEnvironment({ dataDir });
  const prepared = await worktree.prepare({ sessionId: "99cc00dd-1", cwd: local, options: {} });
  const root = join(dataDir, "worktrees");
  await symlink(outside, join(root, "link-out"));
  await mkdir(join(root, "plain", "nested"), { recursive: true });
  const results = createResults({ pluginId: "canvastty-environments", dataDir });
  for (const dir of [join(root, "link-out"), join(root, "plain", "nested")]) {
    await assert.rejects(worktree.release({ ref: { ...prepared.ref, dir }, keepData: false }), /does not belong/u, dir);
    const answer = await results.collect({ id: "99cc00dd-1", title: "x", environment: { pluginId: "canvastty-environments", kind: "worktree", label: "w", ref: { ...prepared.ref, dir } } });
    assert.match(answer.text, /does not belong to the plugin/u, dir);
  }
  // A real folder of the plugin that is not a worktree of the ref's repository is not removed through it.
  await assert.rejects(worktree.release({ ref: { ...prepared.ref, dir: join(root, "plain") }, keepData: false }), /not one of its repository's worktrees/u);
  assert.equal(git(outside, "status", "--porcelain"), "");
  await worktree.release({ ref: prepared.ref, keepData: false });
});
