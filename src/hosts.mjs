// SSH hosts as the person configures them in the plugin's settings page, and the pure pieces of an ssh launch:
// validation, folder mapping, quoting and argv. No I/O here, so every rule is unit-tested.
// Ported (and cut down) from the CanvasTTY chain: RemoteHost validation, remotePathForHost, remoteAgentLaunch.

export const MAX_HOSTS = 16;
export const MAX_WORKSPACES = 8;
const MAX_PATH = 4096;
const CONTROL = /[\u0000-\u001f\u007f]/u;

/**
 * Why a host entry is unusable, or null. sshHost and sshUser are composed into an ssh argv, so they may not contain
 * whitespace and may not start with a dash (ssh would read "-oProxyCommand=…" as an option). No keys are stored:
 * ssh uses the person's own ~/.ssh/config and agent.
 */
export function hostInvalidReason(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "a host must be an object";
  const unknown = Object.keys(value).find((key) => !["label", "sshHost", "sshUser", "sshPort", "workspaces"].includes(key));
  if (unknown) return `unknown field ${unknown.slice(0, 40)}`;
  if (typeof value.label !== "string" || !value.label.trim() || value.label.length > 40 || CONTROL.test(value.label)) {
    return "label must be 1 to 40 characters";
  }
  if (typeof value.sshHost !== "string" || !value.sshHost || value.sshHost.length > 253 || /\s/u.test(value.sshHost)
    || value.sshHost.startsWith("-") || value.sshHost.includes("@") || CONTROL.test(value.sshHost)) {
    return "SSH host must be an ssh config alias or a host name, without spaces, @ or a leading dash";
  }
  if (value.sshUser !== undefined && (typeof value.sshUser !== "string" || !value.sshUser || value.sshUser.length > 64
    || /[\s@]/u.test(value.sshUser) || value.sshUser.startsWith("-") || CONTROL.test(value.sshUser))) {
    return "user must be a name without spaces, @ or a leading dash";
  }
  if (value.sshPort !== undefined && (!Number.isInteger(value.sshPort) || value.sshPort < 1 || value.sshPort > 65_535)) {
    return "port must be a number from 1 to 65535";
  }
  const workspaces = value.workspaces ?? [];
  if (!Array.isArray(workspaces) || workspaces.length > MAX_WORKSPACES) return `at most ${MAX_WORKSPACES} folder mappings`;
  const locals = new Set();
  for (const workspace of workspaces) {
    if (!workspace || typeof workspace !== "object" || Object.keys(workspace).sort().join() !== "localPath,remotePath") {
      return "a folder mapping has exactly localPath and remotePath";
    }
    if (!isAbsolutePosix(workspace.localPath)) return "the folder on this computer must be an absolute path";
    if (!isAbsolutePosix(workspace.remotePath)) return "the folder on the server must be an absolute path";
    const key = trimSlashes(workspace.localPath);
    if (locals.has(key)) return "each folder on this computer is mapped once";
    locals.add(key);
  }
  return null;
}

/** The hosts list as stored; invalid entries are dropped, duplicate labels keep the first. */
export function normalizeHosts(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const hosts = [];
  for (const host of value.slice(0, MAX_HOSTS)) {
    if (hostInvalidReason(host) !== null || seen.has(host.label.trim().toLowerCase())) continue;
    seen.add(host.label.trim().toLowerCase());
    hosts.push(structuredClone({ ...host, label: host.label.trim(), workspaces: host.workspaces ?? [] }));
  }
  return hosts;
}

/** The host the launcher's "Host" field names (case-insensitive label or ssh alias); empty picks the first. */
export function chooseHost(hosts, wanted) {
  const name = typeof wanted === "string" ? wanted.trim().toLowerCase() : "";
  if (!name) return hosts[0] ?? null;
  return hosts.find((host) => host.label.toLowerCase() === name) ?? hosts.find((host) => host.sshHost.toLowerCase() === name) ?? null;
}

/**
 * The folder on the server for a folder on this computer: an exact mapping, or a folder inside a mapped one (the
 * rest of the path is appended). The longest mapped folder wins. Null when nothing covers it.
 */
export function remoteFolderFor(host, localFolder) {
  if (!isAbsolutePosix(localFolder)) return null;
  const wanted = trimSlashes(localFolder);
  let best = null;
  for (const { localPath, remotePath } of host.workspaces ?? []) {
    const root = trimSlashes(localPath);
    const inside = wanted === root ? "" : wanted.startsWith(root === "/" ? "/" : `${root}/`) ? wanted.slice(root === "/" ? 1 : root.length + 1) : null;
    if (inside === null || (best && best.root.length >= root.length)) continue;
    best = { root, folder: inside ? `${trimSlashes(remotePath)}/${inside}`.replace(/^\/\//u, "/") : remotePath };
  }
  return best ? best.folder : null;
}

/** The ssh destination and port options of a host snapshot. */
export function destinationArgs(host) {
  if (hostInvalidReason({ ...host, label: host.label || "host" }) !== null) throw new Error("The host settings are invalid.");
  return [...(host.sshPort ? ["-p", String(host.sshPort)] : []), "--", host.sshUser ? `${host.sshUser}@${host.sshHost}` : host.sshHost];
}

/** One POSIX shell word. */
export function shellQuote(word) {
  if (typeof word !== "string" || word.includes("\0")) throw new Error("A value cannot be passed to the remote shell.");
  return `'${word.replaceAll("'", "'\\''")}'`;
}

/** A program name that may run unquoted after `exec`: letters, digits, `.`, `_`, `-`, never a leading dash. */
const SAFE_PROGRAM = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/u;

/**
 * The remote command line of a card on a server: `cd <folder> && exec …`, ONE argv element (ssh joins its
 * command words with spaces for the remote shell, so the whole line must arrive as one word).
 * - A terminal gets the server account's own login shell (the local $SHELL may not exist there).
 * - An agent runs the same CLI by name from a login shell (so the server's PATH finds it), with the arguments CanvasTTY
 *   gave it minus those that point at this computer (see `remoteArgs`).
 */
export function remoteCommandLine({ provider, remoteFolder, command, args = [], localRoots = [] }) {
  if (!isAbsolutePosix(remoteFolder)) throw new Error("The folder on the server cannot be used.");
  const cd = `cd ${shellQuote(remoteFolder)}`;
  if (provider === "terminal") return `${cd} && exec "\${SHELL:-/bin/sh}" -l`;
  const program = String(command).split("/").pop();
  if (!SAFE_PROGRAM.test(program)) throw new Error(`The agent program ${JSON.stringify(program)} cannot be started over ssh.`);
  const invocation = ["exec", program, ...remoteArgs(args, localRoots)].map((word, index) => (index < 2 ? word : shellQuote(word))).join(" ");
  return `${cd} && exec "\${SHELL:-/bin/sh}" -lc ${shellQuote(invocation)}`;
}

/**
 * The agent flags that take the next argument as their value and that CanvasTTY (or a plugin's launch contribution)
 * points at files on this computer. Only these are removed with a value that is left out: any other flag before it is
 * a switch of its own (`--strict-mcp-config`, `--verbose`) and stays.
 */
const LOCAL_VALUE_FLAGS = new Set(["--settings", "--mcp-config", "--mcp-config-file", "-c", "--config", "--append-system-prompt-file",
  "--system-prompt-file", "--add-dir", "--plugin-dir"]);

/**
 * CanvasTTY's own bridges (status hooks, browser and orchestration MCP) are files and sockets on this computer; the
 * server cannot use them. An argument that names one of the local folders, or is a JSON config, is left out, and so
 * is the flag right before it when that flag takes it as its value (`--settings <file>`, `-c key=<path>`).
 */
export function remoteArgs(args, localRoots) {
  const roots = localRoots.filter((root) => typeof root === "string" && root.length > 1).map(trimSlashes);
  const local = (word) => /^\s*[{[]/u.test(word) || roots.some((root) => word.includes(root));
  const kept = [];
  for (const word of args) {
    if (typeof word !== "string" || word.includes("\0")) throw new Error("Invalid agent argument.");
    if (!local(word)) {
      kept.push(word);
      continue;
    }
    // `--settings=<file>` carries its own value; a separate value belongs to the value flag right before it.
    const previous = kept.at(-1);
    if (!word.startsWith("-") && previous !== undefined && LOCAL_VALUE_FLAGS.has(previous)) kept.pop();
  }
  return kept;
}

/** The full ssh argv of a card: a PTY on the server, no agent or port forwarding, keepalives. */
export function sshLaunchArgs(host, remoteLine) {
  return ["-tt", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "ServerAliveInterval=30", ...destinationArgs(host), remoteLine];
}

/** A one-shot command over ssh: no PTY, no prompts, bounded connect. */
export function sshBatchArgs(host, remoteLine, connectTimeoutSeconds = 8) {
  return ["-T", "-o", "BatchMode=yes", "-o", `ConnectTimeout=${connectTimeoutSeconds}`, "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes",
    ...destinationArgs(host), remoteLine];
}

/** What the badge and saved ref keep of a host: enough to reconnect and collect even after the settings change. */
export function hostSnapshot(host) {
  return { label: host.label, sshHost: host.sshHost, ...(host.sshUser ? { sshUser: host.sshUser } : {}), ...(host.sshPort ? { sshPort: host.sshPort } : {}) };
}

function isAbsolutePosix(value) {
  return typeof value === "string" && value.startsWith("/") && value.length <= MAX_PATH && !CONTROL.test(value) && !value.split("/").includes("..");
}

function trimSlashes(path) {
  return path === "/" ? path : path.replace(/\/+$/u, "");
}
