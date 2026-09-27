// The `ssh-host` environment: a card runs on a server the person configured in the plugin's settings page.
// wrap turns the launch into `ssh -tt <host> 'cd <remote folder> && exec …'`; CanvasTTY still owns the PTY, so
// scrollback and status work unchanged. No keys are stored or read: ssh uses the person's ssh config and agent.
// Nothing is provisioned on the server and release never deletes anything there.
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname } from "node:path";
import {
  chooseHost, hostSnapshot, normalizeHosts, remoteCommandLine, remoteFolderFor, shellQuote, sshBatchArgs, sshLaunchArgs
} from "./hosts.mjs";

export const HOSTS_KEY = "hosts";

/** Runs one bounded batch ssh command; resolves { code, stderr } and never rejects. */
export function runSsh(args, timeoutMs, { ssh = "ssh" } = {}) {
  return new Promise((resolve) => {
    const child = execFile(ssh, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024 }, (error, _stdout, stderr) => {
      if (!error) return resolve({ code: 0, stderr: "" });
      const timedOut = error.killed === true || error.signal === "SIGKILL";
      resolve({ code: typeof error.code === "number" ? error.code : null, stderr: String(stderr || error.message), timedOut });
    });
    child.stdin?.end();
  });
}

/** Can the host be reached, and does the folder exist there? null when yes, else the reason. */
export async function checkRemoteFolder(host, remoteFolder, { timeoutMs, ssh } = {}) {
  const result = await runSsh(sshBatchArgs(host, `test -d ${shellQuote(remoteFolder)}`, Math.max(1, Math.floor((timeoutMs - 1_000) / 1_000))),
    timeoutMs, { ssh });
  if (result.code === 0) return null;
  if (result.timedOut) return `${host.label} (${host.sshHost}) did not answer within ${Math.round(timeoutMs / 1000)} s.`;
  if (result.code === 1) return `The folder ${remoteFolder} does not exist on ${host.label}.`;
  const detail = result.stderr.replace(/\s+/gu, " ").trim().slice(0, 160);
  return `${host.label} (${host.sshHost}) cannot be reached over ssh${detail ? `: ${detail}` : ""}.`;
}

export function createSshHostEnvironment({ dataDir, readHosts, ssh = "ssh", checkTimeoutMs = 8_000 }) {
  const localRoots = localRootsFor(dataDir);

  const refOf = (ref) => {
    if (!ref || typeof ref !== "object" || typeof ref.remoteFolder !== "string" || !ref.host) throw new Error("This card's server ref is unreadable.");
    return ref;
  };

  return {
    async prepare({ cwd, options = {} }) {
      const hosts = normalizeHosts(await readHosts());
      if (hosts.length === 0) return { refuse: { reason: "No server is configured yet: add one in the plugin's settings (Extensions → CanvasTTY Environments → Settings)." } };
      const host = chooseHost(hosts, options.host);
      if (!host) return { refuse: { reason: `No configured server is called ${String(options.host).slice(0, 40)}.` } };
      const remoteFolder = remoteFolderFor(host, cwd);
      if (!remoteFolder) return { refuse: { reason: `${cwd} is not mapped to a folder on ${host.label}; add a folder mapping in the plugin's settings.` } };
      const problem = await checkRemoteFolder(host, remoteFolder, { timeoutMs: checkTimeoutMs, ssh });
      if (problem) return { refuse: { reason: problem } };
      return { ref: { host: hostSnapshot(host), remoteFolder, localFolder: cwd }, label: `ssh ${host.label}` };
    },

    async resume({ ref }) {
      const { host, remoteFolder } = refOf(ref);
      const problem = await checkRemoteFolder(host, remoteFolder, { timeoutMs: checkTimeoutMs, ssh });
      return problem ? { stopped: { reason: problem } } : { ok: true };
    },

    wrap({ ref, provider, command, args }) {
      const { host, remoteFolder } = refOf(ref);
      // The PTY stays local; the command, its arguments and the folder are the server's.
      return { command: "ssh", args: sshLaunchArgs(host, remoteCommandLine({ provider, remoteFolder, command, args, localRoots })) };
    },

    // The server's folder is the person's: nothing is removed there, with or without "keep data".
    release() {
      return {};
    },

    describe({ ref }) {
      const { host, remoteFolder } = refOf(ref);
      const destination = `${host.sshUser ? `${host.sshUser}@` : ""}${host.sshHost}${host.sshPort ? `:${host.sshPort}` : ""}`;
      return { label: `ssh ${host.label}`, detail: `${destination} ${remoteFolder}` };
    }
  };
}

/** Folders that exist only on this computer: arguments naming them are not passed to a remote or container agent. */
export function localRootsFor(dataDir) {
  return [...new Set([homedir(), tmpdir(), safeRealpath(tmpdir()), "/private/var/folders", "/var/folders",
    dirname(dirname(dataDir)), appRoot(process.execPath)].filter(Boolean))];
}

function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** The app bundle (or folder) the host runs from: its bridge helpers live there. */
function appRoot(execPath) {
  const bundle = execPath.indexOf(".app/");
  return bundle > 0 ? execPath.slice(0, bundle + 4) : dirname(execPath);
}
