// Service entry of the `results` module (bundled to services/results.mjs): card actions "Collect changes",
// "Run checks in a capsule", "Show check result", "Apply checked snapshot", and the orchestrator tools `collect` and
// `capsule` (listed as canvastty-environments__collect / __capsule).
import { serve } from "../rpc.mjs";
import { createCapsules } from "../capsules.mjs";
import { CONTAINER_SETTINGS_KEY } from "../containerSettings.mjs";
import { createResults } from "../results.mjs";

let results = null;
let capsules = null;
/** Cards CanvasTTY told us about (sessions:events): id -> summary. No screen text. */
const sessions = new Map();
/** Cards closed before the first list arrived: the list must not bring them back. */
const closed = new Set();

const badge = (callHost) => (sessionId, value) => callHost("cards.setBadge", { sessionId, badge: value });
/** Settles once the first card list arrived (or could not be read): before that, "not your subagent" is not known. */
let listed;
let listing = true;
const sessionsListed = new Promise((resolve) => { listed = resolve; });
const LIST_WAIT_MS = 5_000;

serve({
  onInitialize: async ({ pluginId, dataDir }, { callHost, log }) => {
    results = createResults({ pluginId, dataDir });
    capsules = createCapsules({ pluginId, dataDir, setBadge: badge(callHost),
      readSettings: async () => (await callHost("storage.get", { key: CONTAINER_SETTINGS_KEY })) ?? null });
    try {
      const { sessions: open } = await callHost("sessions.subscribe", {});
      // Cards an event already reported are newer than the list.
      for (const session of open) if (!sessions.has(session.id) && !closed.has(session.id)) sessions.set(session.id, session);
    } catch (error) {
      log("warn", `sessions.subscribe failed: ${error.message}`);
    } finally {
      listing = false; closed.clear();
      listed();
    }
  },
  notifications: {
    "canvastty.sessions.event": ({ type, session }) => {
      if (type === "closed") { sessions.delete(session.id); if (listing) closed.add(session.id); }
      else sessions.set(session.id, session);
    }
  },
  methods: {
    async "canvastty.tools.call"({ tool, caller, input }) {
      if (tool !== "collect" && tool !== "capsule") throw new Error(`Unknown tool: ${tool}`);
      if (!results) throw new Error("The results service is starting; try again.");
      let target = caller;
      if (input.sessionId !== undefined && input.sessionId !== caller.id) {
        const known = await Promise.race([sessionsListed.then(() => true), new Promise((resolve) => setTimeout(resolve, LIST_WAIT_MS, false))]);
        if (!known) return { content: "The list of cards is still loading; try again in a moment.", isError: true };
        target = sessions.get(input.sessionId);
        // Only the caller's own subagents: CanvasTTY vouches for the caller, the plugin enforces this rule.
        if (!target || target.parentSessionId !== caller.id) return { content: "That session is not one of your subagents.", isError: true };
      }
      if (tool === "capsule") {
        const action = input.action ?? "run";
        const answer = action === "apply" ? await capsules.apply(target) : action === "result" ? await capsules.result(target, { waitMs: 13_000 })
          : await capsules.run(target, { waitMs: 13_000 });
        return { content: answer.text, isError: !answer.ok };
      }
      const answer = await results.collect(target);
      return { content: answer.text, isError: !answer.ok };
    },
    async "canvastty.cards.invoke"({ actionId, session }, { callHost }) {
      if (!results) throw new Error("The results service is starting; try again.");
      if (actionId === "capsule-check" || actionId === "capsule-result") {
        const answer = actionId === "capsule-check" ? await capsules.run(session, { waitMs: 12_000, forToast: true })
          : await capsules.result(session, { waitMs: 12_000, forToast: true });
        return { message: answer.text.slice(0, 2000), tone: answer.passed ? "info" : "error" };
      }
      if (actionId === "capsule-apply") {
        const answer = await capsules.apply(session);
        if (answer.branch) await badge(callHost)(session.id, { text: "applied", tone: "info", tooltip: `Local branch ${answer.branch}` }).catch(() => undefined);
        return { message: answer.text.slice(0, 2000), tone: answer.ok ? "info" : "error" };
      }
      if (actionId !== "collect-changes") throw new Error(`Unknown action: ${actionId}`);
      const answer = await results.collect(session);
      if (answer.branch) {
        await badge(callHost)(session.id, { text: "collected", tone: "info", tooltip: `Local branch ${answer.branch}` }).catch(() => undefined);
      }
      return { message: answer.text, tone: answer.ok ? "info" : "error" };
    }
  }
});
