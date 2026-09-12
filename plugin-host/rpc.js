/**
 * RPC layer for the plugin sandbox (utilityProcess side).
 *
 * Transport: `process.parentPort` (structured clone). Message shapes:
 *   request  { t: "req", id, method, params }   (either direction)
 *   response { t: "res", id, result }
 *   error    { t: "err", id, error }
 *   event    { t: "evt", method, params }       (one-way notification)
 *
 * Id spaces are independent per side, so host and plugin each number their
 * own requests starting at 1.
 */

let nextId = 1;
const pending = new Map(); // id -> { resolve, reject, timer }

const requestHandlers = new Map(); // method -> (params) => result | Promise<result>
const eventHandlers = new Map(); // method -> (params) => void

function send(msg) {
  try {
    process.parentPort.postMessage(msg);
  } catch (e) {
    console.error("[rpc] failed to postMessage to host", e);
  }
}

process.parentPort.on("message", (e) => {
  const msg = e.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.t === "res") {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg.result);
    }
  } else if (msg.t === "err") {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      clearTimeout(p.timer);
      p.reject(new Error(msg.error || "plugin rpc error"));
    }
  } else if (msg.t === "req") {
    handleIncomingRequest(msg).catch((e) => {
      send({
        t: "err",
        id: msg.id,
        error: String((e && e.message) || e),
      });
    });
  } else if (msg.t === "evt") {
    const h = eventHandlers.get(msg.method);
    if (h) {
      try {
        h(msg.params ?? {});
      } catch (e) {
        console.error(`[rpc] event handler "${msg.method}" threw`, e);
      }
    }
  }
});

async function handleIncomingRequest(msg) {
  const h = requestHandlers.get(msg.method);
  if (!h) {
    send({ t: "err", id: msg.id, error: `unknown method "${msg.method}"` });
    return;
  }
  const result = await h(msg.params ?? {});
  send({ t: "res", id: msg.id, result: result === undefined ? {} : result });
}

/**
 * Send a request to the host and await its reply.
 */
function call(method, params, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(
        new Error(`host request "${method}" timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    send({ t: "req", id, method, params: params ?? {} });
  });
}

/**
 * Send a one-way event to the host.
 */
function emit(method, params) {
  send({ t: "evt", method, params: params ?? {} });
}

/**
 * Register a handler for host -> plugin requests.
 */
function onRequest(method, handler) {
  requestHandlers.set(method, handler);
}

/**
 * Register a handler for host -> plugin events.
 */
function onEvent(method, handler) {
  eventHandlers.set(method, handler);
}

/**
 * Reject all pending host requests (called on shutdown).
 */
function settleAllPending(error) {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(error || new Error("sandbox shutting down"));
  }
  pending.clear();
}

module.exports = { call, emit, onRequest, onEvent, settleAllPending };
