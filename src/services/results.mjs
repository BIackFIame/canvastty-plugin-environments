// Service entry of the `results` module (bundled to services/results.mjs): card action "Collect changes" and the
// orchestrator tool `collect` (listed as canvastty-environments__collect).
import { serve } from "../rpc.mjs";
import { createResults } from "../results.mjs";

let results = null;
/** Cards CanvasTTY told us about (sessions:events): id -> summary. No screen text. */
const sessions = new Map();

serve({
  onInitialize: async ({ pluginId, dataDir }, { callHost, log }) => {
    results = createResults({ pluginId, dataDir });
    try {
      const { sessions: open } = await callHost("sessions.subscribe", {});
      for (const session of open) sessions.set(session.id, session);
    } catch (error) {
      log("warn", `sessions.subscribe failed: ${error.message}`);
    }
  },
  notifications: {
    "canvastty.sessions.event": ({ type, session }) => {
      if (type === "closed") sessions.delete(session.id);
      else sessions.set(session.id, session);
    }
  },
  methods: {
    async "canvastty.tools.call"({ tool, caller, input }) {
      if (tool !== "collect") throw new Error(`Unknown tool: ${tool}`);
      if (!results) throw new Error("The results service is starting; try again.");
      let target = caller;
      if (input.sessionId !== undefined && input.sessionId !== caller.id) {
        target = sessions.get(input.sessionId);
        // Only the caller's own subagents: CanvasTTY vouches for the caller, the plugin enforces this rule.
        if (!target || target.parentSessionId !== caller.id) return { content: "That session is not one of your subagents.", isError: true };
      }
      const answer = await results.collect(target);
      return { content: answer.text, isError: !answer.ok };
    },
    async "canvastty.cards.invoke"({ actionId, session }, { callHost }) {
      if (actionId !== "collect-changes") throw new Error(`Unknown action: ${actionId}`);
      if (!results) throw new Error("The results service is starting; try again.");
      const answer = await results.collect(session);
      if (answer.branch) {
        await callHost("cards.setBadge", { sessionId: session.id, badge: { text: "collected", tone: "info", tooltip: `Local branch ${answer.branch}` } })
          .catch(() => undefined);
      }
      return { message: answer.text, tone: answer.ok ? "info" : "error" };
    }
  }
});
