// The CanvasTTY service protocol: newline-delimited JSON-RPC 2.0 over stdin/stdout.
// The host sends canvastty.initialize first, then requests; the service may call the host back (storage, sessions…).
// The transport is bounded both ways: a frame above the frame limit is skipped without being held, host calls have a
// deadline and an in-flight cap, requests beyond the handler cap are answered busy, and on shutdown or end of input
// the handlers still running get a short drain to answer before the process exits. Output is bounded too: a frame
// above the frame limit is never written (an answer becomes an error, a host call fails), and while the host is not
// reading (write() returned false) frames wait in order for 'drain', with the waiting logs capped at outboundBytes by
// dropping the oldest of them; answers and host calls are never dropped.

export const RPC_LIMITS = Object.freeze({
  /** CanvasTTY caps service frames at 1 MiB in both directions. */
  frameBytes: 1_048_576,
  hostCallMs: 30_000,
  hostCalls: 64,
  activeHandlers: 64,
  /** CanvasTTY waits 2 s after canvastty.shutdown before SIGTERM. */
  drainMs: 1_500,
  /** Logs held while the host is not reading, at most. */
  outboundBytes: 8 * 1_048_576
});

/**
 * Runs one service. `methods` answers host requests; `notifications` gets host notifications
 * (canvastty.sessions.event…); `onInitialize` gets the initialize params and the host caller.
 * `input`, `output`, `exit` and `limits` are for tests.
 */
export function serve({ methods, notifications = {}, onInitialize, input = process.stdin, output = process.stdout, exit = (code) => process.exit(code), limits = {} }) {
  const limit = { ...RPC_LIMITS, ...limits };
  const pending = new Map();
  let nextId = 1;
  let active = 0;
  let stopping = false;
  let hostGone = false;
  let onIdle = null;
  // Frames waiting for 'drain', in order; `droppable` ones (logs) count against outboundBytes.
  const queue = [];
  let held = 0;
  let blocked = false;
  let dropped = 0;
  let onFlushed = null;
  const write = (text) => {
    if (output.write(text) === false && typeof output.once === "function") { blocked = true; output.once("drain", flush); }
  };
  function flush() {
    blocked = false;
    while (queue.length && !blocked) {
      const frame = queue.shift();
      if (frame.droppable) held -= frame.bytes;
      write(frame.text);
    }
    if (blocked) return;
    if (dropped) {
      const count = dropped;
      dropped = 0;
      send({ method: "log", params: { level: "warn", message: `Dropped ${count} events or logs while the host was not reading.` } }, true);
    }
    if (!blocked && !queue.length) onFlushed?.();
  }
  /** Writes one frame, or holds it while the host is not reading; false when it is larger than the frame limit. */
  const send = (message, droppable = false) => {
    const text = `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`;
    const bytes = Buffer.byteLength(text);
    // A log is cut to 500 characters, so only answers and host calls can outgrow a frame.
    if (bytes > limit.frameBytes && message.method !== "log") return false;
    if (!blocked) { write(text); return true; }
    if (droppable) {
      for (let at = 0; held + bytes > limit.outboundBytes && at < queue.length;) {
        const frame = queue[at];
        if (!frame.droppable) { at++; continue; }
        held -= frame.bytes;
        queue.splice(at, 1);
        dropped++;
      }
      if (held + bytes > limit.outboundBytes) { dropped++; return true; }
      held += bytes;
    }
    queue.push({ text, bytes, droppable });
    return true;
  };
  const callHost = (method, params) => new Promise((resolve, reject) => {
    if (hostGone) return reject(new Error("The host connection is closed."));
    if (pending.size >= limit.hostCalls) return reject(new Error("Too many host calls in flight."));
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`The host did not answer ${method} in time.`)); }, limit.hostCallMs);
    pending.set(id, { resolve, reject, timer });
    if (!send({ id, method, params })) {
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error(`The ${method} request is larger than the frame limit.`));
    }
  });
  const log = (level, message) => { send({ method: "log", params: { level, message: String(message).slice(0, 500) } }, true); };
  const context = { callHost, log };
  const errorText = (error) => String(error?.message ?? error);
  /** Runs a handler, counted as active until it settles. */
  const track = (run) => {
    active++;
    return Promise.resolve().then(run).finally(() => { active--; if (active === 0) onIdle?.(); });
  };
  /** Takes no new work, lets the running handlers answer (bounded), then exits. */
  const stop = () => {
    if (stopping) return;
    stopping = true;
    let exited = false;
    const finish = () => { if (exited) return; exited = true; clearTimeout(timer); exit(0); };
    const timer = setTimeout(finish, limit.drainMs);
    // Exits once the answers written so far have left too (still bounded by the drain timer).
    onIdle = () => { if (blocked || queue.length) onFlushed = finish; else finish(); };
    if (active === 0) onIdle();
  };

  const handle = (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    if (message.method === "canvastty.initialize") {
      Promise.resolve().then(() => onInitialize?.(message.params, context))
        .catch((error) => log("error", `initialize failed: ${errorText(error)}`));
      return;
    }
    if (message.method === "canvastty.shutdown") return stop();
    if (typeof message.method === "string" && message.id === undefined) {
      if (stopping) return;
      if (active >= limit.activeHandlers) return log("warn", `${message.method}: dropped, the service is busy`);
      const handler = Object.hasOwn(notifications, message.method) ? notifications[message.method] : undefined;
      track(() => handler?.(message.params, context))
        .catch((error) => log("warn", `${message.method}: ${errorText(error)}`));
      return;
    }
    if (typeof message.method === "string") {
      if (stopping || active >= limit.activeHandlers) {
        send({ id: message.id, error: { code: -32000, message: stopping ? "The service is stopping." : "The service is busy; try again." } });
        return;
      }
      const method = Object.hasOwn(methods, message.method) ? methods[message.method] : undefined;
      track(() => {
        if (!method) throw Object.assign(new Error(`Unknown method: ${message.method}`), { code: -32601 });
        return method(message.params ?? {}, context);
      }).then(
        (result) => {
          if (!send({ id: message.id, result: result ?? null })) send({ id: message.id, error: { code: -32000, message: "The answer is larger than the frame limit." } });
        },
        (error) => send({ id: message.id, error: { code: error?.code ?? -32000, message: errorText(error).slice(0, 400) } })
      );
      return;
    }
    const waiter = typeof message.id === "number" ? pending.get(message.id) : undefined;
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(typeof message.error.message === "string" ? message.error.message : "Host request failed."));
    else waiter.resolve(message.result);
  };

  // Lines are cut from raw bytes: a frame is kept as chunks and joined once at its newline; one that grows past the
  // limit is dropped up to its newline without being held.
  let chunks = [];
  let size = 0;
  let skipping = false;
  const drop = () => { if (!skipping) log("warn", "Dropped a host message larger than the frame limit."); chunks = []; size = 0; };
  input.on("data", (data) => {
    let chunk = typeof data === "string" ? Buffer.from(data) : data;
    for (let newline = chunk.indexOf(10); newline >= 0; newline = chunk.indexOf(10)) {
      const part = chunk.subarray(0, newline);
      chunk = chunk.subarray(newline + 1);
      if (skipping || size + part.length > limit.frameBytes) { drop(); skipping = false; continue; }
      const line = (chunks.length ? Buffer.concat([...chunks, part]) : part).toString("utf8");
      chunks = [];
      size = 0;
      handle(line);
    }
    if (!chunk.length || skipping) return;
    if (size + chunk.length > limit.frameBytes) { drop(); skipping = true; return; }
    // A chunk can be a view into a larger pooled buffer; keep a copy of just this part.
    chunks.push(Buffer.from(chunk));
    size += chunk.length;
  });
  const closed = () => {
    if (hostGone) return;
    hostGone = true;
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("The host connection closed.")); }
    pending.clear();
    stop();
  };
  input.on("end", closed);
  input.on("error", closed);
}
