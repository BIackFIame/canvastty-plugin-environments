import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  chooseHost, destinationArgs, hostInvalidReason, normalizeHosts, remoteArgs, remoteCommandLine, remoteFolderFor, shellQuote, sshLaunchArgs
} from "../src/hosts.mjs";
import { fakeSsh, temp } from "./helpers.mjs";

const box = { label: "Build box", sshHost: "build-box", workspaces: [{ localPath: "/Users/me/project", remotePath: "/srv/project" }] };

test("host validation refuses what could turn into ssh options or extra commands", () => {
  assert.equal(hostInvalidReason(box), null);
  assert.equal(hostInvalidReason({ ...box, sshUser: "root", sshPort: 2222 }), null);
  const bad = [
    [{ ...box, sshHost: "-oProxyCommand=touch /tmp/x" }, /leading dash/u],
    [{ ...box, sshHost: "host evil" }, /without spaces/u],
    [{ ...box, sshHost: "root@host" }, /without spaces, @/u],
    [{ ...box, sshUser: "-l" }, /user/u],
    [{ ...box, sshUser: "a b" }, /user/u],
    [{ ...box, sshPort: 0 }, /port/u],
    [{ ...box, sshPort: "22" }, /port/u],
    [{ ...box, label: " " }, /label/u],
    [{ ...box, label: "x".repeat(41) }, /label/u],
    [{ ...box, privateKey: "-----BEGIN" }, /unknown field privateKey/u],
    [{ ...box, workspaces: [{ localPath: "relative", remotePath: "/srv" }] }, /this computer/u],
    [{ ...box, workspaces: [{ localPath: "/a", remotePath: "srv" }] }, /on the server/u],
    [{ ...box, workspaces: [{ localPath: "/a", remotePath: "/srv/../etc" }] }, /on the server/u],
    [{ ...box, workspaces: [{ localPath: "/a", remotePath: "/srv\nrm -rf /" }] }, /on the server/u],
    [{ ...box, workspaces: [{ localPath: "/a", remotePath: "/b" }, { localPath: "/a/", remotePath: "/c" }] }, /mapped once/u],
    [{ ...box, workspaces: Array.from({ length: 9 }, (_, i) => ({ localPath: `/l${i}`, remotePath: `/r${i}` })) }, /at most 8/u]
  ];
  for (const [host, reason] of bad) assert.match(hostInvalidReason(host), reason, JSON.stringify(host));
  assert.deepEqual(normalizeHosts([box, { ...box, label: "build BOX" }, { sshHost: "x" }, "junk"]).map((h) => h.label), ["Build box"]);
  assert.deepEqual(normalizeHosts(null), []);
  assert.throws(() => destinationArgs({ ...box, sshHost: "-oProxyCommand=x" }), /invalid/u);
  assert.deepEqual(destinationArgs({ ...box, sshUser: "root", sshPort: 2222 }), ["-p", "2222", "--", "root@build-box"]);
});

test("hosts are chosen by label or alias; folders map exactly or inside, the longest mapping wins", () => {
  const second = { label: "Other", sshHost: "other", workspaces: [] };
  assert.equal(chooseHost([box, second], ""), box);
  assert.equal(chooseHost([box, second], "other"), second);
  assert.equal(chooseHost([box, second], "BUILD BOX"), box);
  assert.equal(chooseHost([box, second], "missing"), null);
  const nested = { ...box, workspaces: [...box.workspaces, { localPath: "/Users/me/project/web", remotePath: "/var/www" }] };
  assert.equal(remoteFolderFor(box, "/Users/me/project"), "/srv/project");
  assert.equal(remoteFolderFor(box, "/Users/me/project/"), "/srv/project");
  assert.equal(remoteFolderFor(box, "/Users/me/project/src/lib"), "/srv/project/src/lib");
  assert.equal(remoteFolderFor(box, "/Users/me/project-other"), null);
  assert.equal(remoteFolderFor(nested, "/Users/me/project/web/app"), "/var/www/app");
  assert.equal(remoteFolderFor(box, "relative"), null);
});

test("shell quoting survives quotes, spaces, $() and newlines when a real shell reads it", () => {
  for (const word of ["plain", "it's", "a b", "$(touch pwned)", "`id`", "x\ny", "'; rm -rf / #", "\\", ""]) {
    assert.equal(execFileSync("/bin/sh", ["-c", `printf '%s' ${shellQuote(word)}`], { encoding: "utf8" }), word);
  }
  assert.throws(() => shellQuote("a\0b"), /cannot be passed/u);
});

test("the remote line: a terminal gets the server's login shell, an agent its CLI by name without local bridges", () => {
  assert.equal(remoteCommandLine({ provider: "terminal", remoteFolder: "/srv/it's here", command: "/bin/zsh", args: ["-l"] }),
    `cd '/srv/it'\\''s here' && exec "\${SHELL:-/bin/sh}" -l`);
  const line = remoteCommandLine({
    provider: "claude", remoteFolder: "/srv/project", command: "/Users/me/.local/bin/claude",
    args: ["--settings", "/Users/me/Library/CanvasTTY/hooks.json", "--mcp-config", "{\"mcpServers\":{}}", "--dangerously-skip-permissions",
      "-c", "x=/private/var/folders/ab/helper.sock", "--resume", "5f1c2a90"],
    localRoots: ["/Users/me", "/private/var/folders"]
  });
  assert.equal(line, `cd '/srv/project' && exec "\${SHELL:-/bin/sh}" -lc 'exec claude '\\''--dangerously-skip-permissions'\\'' '\\''--resume'\\'' '\\''5f1c2a90'\\'''`);
  assert.deepEqual(remoteArgs(["--flag=/Users/me/x", "--keep", "value"], ["/Users/me"]), ["--keep", "value"]);
  // A switch before a left-out argument is not its flag: only the value flags go with their value.
  assert.deepEqual(remoteArgs(["--strict-mcp-config", "--settings=/Users/me/x.json", "--verbose", "/Users/me/file", "--model", "m"], ["/Users/me"]),
    ["--strict-mcp-config", "--verbose", "--model", "m"]);
  assert.throws(() => remoteCommandLine({ provider: "claude", remoteFolder: "/srv", command: "/x/-evil" }), /cannot be started/u);
  assert.throws(() => remoteCommandLine({ provider: "claude", remoteFolder: "/srv", command: "claude;id" }), /cannot be started/u);
  assert.throws(() => remoteCommandLine({ provider: "terminal", remoteFolder: "srv" }), /cannot be used/u);
  const args = sshLaunchArgs({ ...box, sshUser: "root" }, "cd '/srv' && exec x");
  assert.deepEqual(args.slice(0, 2), ["-tt", "-o"]);
  assert.deepEqual(args.slice(-3), ["--", "root@build-box", "cd '/srv' && exec x"]);
});

test("through a shell that joins ssh words like a server does, the agent line runs exactly its arguments", async (t) => {
  const ssh = await fakeSsh(t);
  const folder = await temp(t, "remote");
  const nasty = ["%s|", "a b", "it's", "$(touch pwned)", "`touch pwned2`"];
  const line = remoteCommandLine({ provider: "codex", remoteFolder: folder, command: "/usr/bin/printf", args: nasty });
  const output = execFileSync(ssh.path, sshLaunchArgs(box, line).filter((arg) => arg !== "-tt"), {
    encoding: "utf8", env: { ...process.env, SHELL: "/bin/sh" }
  });
  assert.equal(output, "a b|it's|$(touch pwned)|`touch pwned2`|");
  assert.ok(!existsSync(join(folder, "pwned")) && !existsSync(join(folder, "pwned2")));
});
