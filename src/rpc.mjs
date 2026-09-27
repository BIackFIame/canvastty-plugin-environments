// The CanvasTTY service protocol: newline-delimited JSON-RPC 2.0 over stdin/stdout.
// The host sends canvastty.initialize first, then requests; the service may call the host back (storage, sessions…).
import { createInterface } from "node:readline";

/**
 * Runs one service. `methods` answers host requests; `notifications` gets host notifications
 * (canvastty.sessions.event…); `onInitialize` gets the initialize params and the host caller.
 */
export function serve({ methods, notifications = {}, onInitialize }) {
  const pending = new Map();
  let nextId = 1;
  const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const callHost = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
  const log = (level, message) => send({ method: "log", params: { level, message: String(message).slice(0, 500) } });

  createInterface({ input: process.stdin }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method === "canvastty.initialize") {
      Promise.resolve().then(() => onInitialize?.(message.params, { callHost, log }))
        .catch((error) => log("error", `initialize failed: ${error.message}`));
      return;
    }
    if (message.method === "canvastty.shutdown") process.exit(0);
    if (typeof message.method === "string" && message.id === undefined) {
      Promise.resolve().then(() => notifications[message.method]?.(message.params, { callHost, log }))
        .catch((error) => log("warn", `${message.method}: ${error.message}`));
      return;
    }
    if (typeof message.method === "string") {
      const method = methods[message.method];
      Promise.resolve().then(() => {
        if (!method) throw Object.assign(new Error(`Unknown method: ${message.method}`), { code: -32601 });
        return method(message.params ?? {}, { callHost, log });
      }).then(
        (result) => send({ id: message.id, result: result ?? null }),
        (error) => send({ id: message.id, error: { code: error.code ?? -32000, message: String(error.message).slice(0, 400) } })
      );
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  }).on("close", () => process.exit(0));
}
