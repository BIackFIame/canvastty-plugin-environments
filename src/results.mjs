// The `results` module: "Collect changes" (card action) and the orchestrator tool `collect` bring a worktree or
// ssh-host card's work home as a local branch. It acts only on cards placed by this plugin's own environments, and
// the tool only on the caller itself or the caller's own subagents.
import { resolve, sep } from "node:path";
import { CollectionRefusal, collectRemote, collectWorktree, sshTransport } from "./collect.mjs";

/** CanvasTTY waits 15 s for a tool call or card action; the collection stops before that. */
export const COLLECT_BUDGET_MS = 13_500;

export function createResults({ pluginId, dataDir, transports = {}, timeoutMs = COLLECT_BUDGET_MS }) {
  const running = new Set();
  const worktreesRoot = resolve(dataDir, "worktrees");

  /** Collects one card; the answer is plain text for the agent or the toast. */
  async function collect(session) {
    const environment = session.environment;
    if (!environment) {
      return { text: "This card works directly in the project folder on this computer: its changes are already there, so there is nothing to collect.", ok: true, state: "in-place" };
    }
    if (environment.pluginId !== pluginId || !["worktree", "ssh-host"].includes(environment.kind)) {
      return { text: `This card runs in ${environment.label}, which another plugin manages; it cannot be collected here.`, ok: false };
    }
    if (running.has(session.id)) return { text: "This card's changes are being collected already.", ok: false };
    running.add(session.id);
    try {
      const result = environment.kind === "worktree" ? await collectFromWorktree(session) : await collectFromServer(session);
      const lines = [result.message];
      if (result.excluded?.length) lines.push(`Left out as credentials: ${result.excluded.slice(0, 10).join(", ")}.`);
      if (result.diffstat) lines.push(result.diffstat);
      return { text: lines.join("\n"), ok: true, state: result.state, branch: result.branch };
    } catch (error) {
      const text = error instanceof CollectionRefusal ? `Nothing was collected: ${error.message}` : `Collecting failed: ${error.message}`;
      return { text, ok: false };
    } finally {
      running.delete(session.id);
    }
  }

  function collectFromWorktree(session) {
    const ref = session.environment.ref ?? {};
    const dir = typeof ref.dir === "string" ? resolve(ref.dir) : "";
    if (!dir.startsWith(worktreesRoot + sep) || typeof ref.repo !== "string") throw new CollectionRefusal("This worktree does not belong to the plugin.");
    return collectWorktree({ sessionId: session.id, title: session.title, sourceFolder: ref.repo, worktreeFolder: dir, baseCommit: ref.base,
      ...(transports.local ? { transport: transports.local } : {}), timeoutMs });
  }

  function collectFromServer(session) {
    const ref = session.environment.ref ?? {};
    if (!ref.host || typeof ref.remoteFolder !== "string" || typeof ref.localFolder !== "string") throw new CollectionRefusal("This card's server ref is unreadable.");
    const transport = (transports.remote ?? sshTransport)(ref.host);
    return collectRemote({ sessionId: session.id, title: session.title, localFolder: ref.localFolder, remoteFolder: ref.remoteFolder, transport, timeoutMs });
  }

  return { collect };
}
