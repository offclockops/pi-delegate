import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sessionKeyFrom } from "./events-log.mjs";

// Claude as a peer on pi-intercom's local broker, for one coordinator session that drives
// several independent pi windows.
//
// The MCP server already lives exactly as long as the Claude session and already has a way
// to push a line into it (the notifier → bin/pi-watch monitor). Holding the broker client
// here gives inbound messages the same road, instead of a separate watcher that expires or
// outlives its session and keeps the name while its output goes nowhere.
//
// The client itself is pi-intercom's own IntercomClient, loaded from the installed pi
// package set (`intercom.modules`): no second implementation of the wire protocol, and no
// npm dependency for this plugin. Like the notifier, none of this may take the server down:
// every failure becomes a line, never an exception out of this module.

const RETRY_FIRST_MS = 2_000;
const RETRY_MAX_MS = 30_000;
const DEFAULT_ACK_TIMEOUT_S = 60;

// The default name must survive /reload-plugins: pi windows keep sending to it. The MCP
// server gets a fresh CLAUDE_CODE_SESSION_ID on every reload (src/events-log.mjs), so the
// name comes from the same reload-stable session key the notifier uses.
export function intercomName(settings = {}, env = process.env) {
  if (settings.name) return settings.name;
  const key = String(sessionKeyFrom(env) ?? "").replace(/^cc/, "").replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
  return key ? `claude-${key}` : "claude-coordinator";
}

// The default factory: pi-intercom ships TypeScript, so register tsx's ESM loader from the
// same node_modules first. `PI_CODING_AGENT_DIR` picks the broker the pi windows use
// (pi-intercom/broker/paths.ts reads it).
let tsxRegistered = false;

export async function loadIntercomClient(settings) {
  process.env.PI_CODING_AGENT_DIR = settings.agent_dir;
  if (!tsxRegistered) {
    const tsx = await import(pathToFileURL(join(settings.modules, "tsx/dist/esm/api/index.mjs")).href);
    tsx.register();
    tsxRegistered = true;
  }
  const { IntercomClient } = await import(pathToFileURL(join(settings.modules, "pi-intercom/broker/client.ts")).href);
  return new IntercomClient();
}

const short = (id) => String(id ?? "").slice(0, 8);

// pi-intercom reads its pool (routing scope) from this variable when a client connects.
const POOL_VAR = "PI_INTERCOM_SCOPE_ID";
const POOL_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const currentPool = () => (process.env[POOL_VAR] ?? "").trim() || "default";
const generatedPool = () => `pool-${Array.from({ length: 4 }, () => Math.floor(Math.random() * 36).toString(36)).join("")}`;

export function createIntercom({
  config,
  notifier,
  clientFactory = loadIntercomClient,
  env = process.env,
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimer = (t) => clearTimeout(t),
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  const settings = config?.intercom ?? null;
  const enabled = Boolean(settings?.modules && settings?.agent_dir);
  const name = enabled ? intercomName(settings, env) : null;
  const defaultAckS = Number.isInteger(settings?.ack_timeout_s) ? settings.ack_timeout_s : DEFAULT_ACK_TIMEOUT_S;
  const announce = (line) => { try { notifier?.broadcast(line); } catch { /* a notification may not break the mechanism */ } };

  let client = null;
  let connected = false;
  let closed = false;
  let retryTimer = null;
  let retryMs = RETRY_FIRST_MS;
  let lostAnnounced = false;
  // One pending deadline per send: { to, messageId, seconds, timer }.
  const deadlines = new Set();

  // The broker's own target rules (pi-intercom broker.ts): a name matches without regard to
  // case, an id matches in full or by prefix.
  function matchesTarget(target, session) {
    const t = String(target ?? "").toLowerCase();
    if (!t) return false;
    return t === String(session?.name ?? "").toLowerCase() || String(session?.id ?? "").toLowerCase().startsWith(t);
  }

  function onMessage(from, message) {
    for (const d of [...deadlines]) {
      const hit = d.targetId ? d.targetId === from?.id : matchesTarget(d.to, from);
      if (hit) { clearTimer(d.timer); deadlines.delete(d); }
    }
    const sender = from?.name || short(from?.id) || "unknown";
    const reply = message?.replyTo ? ` replyTo=${message.replyTo}` : "";
    const ask = message?.expectsReply ? " ask (answer with replyTo)" : "";
    announce(`intercom from ${sender} (${short(from?.id)}) msg=${message?.id}${reply}${ask}:\n${message?.content?.text ?? ""}`);
  }

  function scheduleRetry() {
    if (closed || retryTimer) return;
    const delay = retryMs;
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    retryTimer = setTimer(async () => { retryTimer = null; await connect(); }, delay);
  }

  function onDisconnected(error) {
    if (closed) return;
    connected = false;
    if (!lostAnnounced) {
      lostAnnounced = true;
      announce(`intercom: lost the broker (${error?.message ?? "disconnected"}); reconnecting. A broker restart loses its mailbox, so peers may need to resend.`);
    }
    scheduleRetry();
  }

  let lastSessionId;
  let connecting = null;

  // One attempt at a time, the client load included, so start, a retry and pool never make a
  // second client or connect twice. Resolves to the error when the attempt failed (a retry is
  // then scheduled), else undefined.
  function connect() {
    if (closed) return Promise.resolve();
    connecting ??= attemptConnect().finally(() => { connecting = null; });
    return connecting;
  }

  async function attemptConnect() {
    try {
      if (!client) {
        const made = await clientFactory(settings);
        if (closed) return;
        client = made;
        client.on("message", onMessage);
        client.on("disconnected", onDisconnected);
        client.on("error", () => {});
      }
      const now = Date.now();
      // Reuse the earlier broker id, so peers that address this session by id keep working.
      await client.connect({ cwd: process.cwd(), model: "claude-code", pid: process.pid, startedAt: now, lastActivity: now, name, status: "idle" }, lastSessionId);
      if (closed) { await client.disconnect().catch(() => {}); return; }
      lastSessionId = client.sessionId ?? lastSessionId;
      connected = true;
      retryMs = RETRY_FIRST_MS;
      if (lostAnnounced) {
        lostAnnounced = false;
        announce(`intercom: reconnected as ${name}.`);
      }
    } catch (error) {
      connected = false;
      if (closed) return error;
      if (!lostAnnounced) {
        lostAnnounced = true;
        const line = `intercom: could not reach the broker (${error?.message ?? error}); retrying.`;
        log(`pi-delegate: ${line}`);
        announce(line);
      }
      scheduleRetry();
      return error;
    }
  }

  async function peerStatus(to) {
    try {
      const sessions = await client.listSessions();
      const match = sessions.find((s) => matchesTarget(to, s));
      return match ? (match.status ?? "unknown") : "not in the roster";
    } catch {
      return "unknown (roster unavailable)";
    }
  }

  const roster = (sessions) => sessions
    .filter((s) => s.name !== name)
    .map((s) => ({
      id: String(s.id ?? ""),
      name: s.name ?? null,
      model: s.model ?? null,
      status: s.status ?? null,
      cwd: s.cwd ?? null,
      idle_s: Number.isFinite(s.lastActivity) ? Math.max(0, Math.floor((Date.now() - s.lastActivity) / 1000)) : null,
      contextPct: Number.isFinite(s.contextPct) ? s.contextPct : null,
      unnamed: s.runtimeFallbackAlias === true,
    }));

  async function list() {
    if (!enabled) return notConfigured;
    if (!connected) return notConnected();
    try {
      return { ok: true, self: name, pool: currentPool(), sessions: roster(await client.listSessions()) };
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  }

  // Join a pool: pi-intercom reads the scope at connect time, so switch the variable, drop the
  // connection and connect again under the same broker id.
  let switching = Promise.resolve();
  async function switchPool({ name: requested } = {}) {
    if (!enabled) return notConfigured;
    const wanted = String(requested ?? "").trim() || generatedPool();
    if (wanted !== "default" && !POOL_NAME.test(wanted)) {
      return { ok: false, error: "pool name must be 1-64 characters from A-Z a-z 0-9 . _ - (or `default` to leave the pool)." };
    }
    // An attempt in flight registers in the old pool; let it settle first.
    await connecting?.catch(() => {});
    if (closed) return notConnected();
    if (wanted === "default") delete process.env[POOL_VAR];
    else process.env[POOL_VAR] = wanted;
    // A reply to a message sent before the switch goes to the old pool, where the broker holds it.
    const dropped = deadlines.size;
    for (const d of deadlines) clearTimer(d.timer);
    deadlines.clear();
    connected = false;
    if (client) await client.disconnect().catch(() => {});
    if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
    const failure = await connect();
    if (failure) return { ok: false, error: `could not join pool ${wanted}: ${failure?.message ?? failure}; retrying.` };
    if (!connected) return notConnected();
    const out = await list();
    if (!out.ok) return out;
    return {
      ...out,
      join: `/intercom-pool ${out.pool}`,
      ...(dropped ? { dropped_reply_deadlines: dropped, note: "replies to messages sent before the switch are held in the old pool" } : {}),
    };
  }

  const notConfigured = { ok: false, error: "pi_intercom is not configured: set intercom.modules and intercom.agent_dir in the pi-delegate config." };
  const notConnected = () => ({ ok: false, error: `not connected to the intercom broker as ${name}; it is reconnecting.` });

  return {
    enabled,
    name,

    async start() {
      if (!enabled) return;
      await connect();
    },

    async send({ to, text, replyTo, expect_reply_s } = {}) {
      if (!enabled) return notConfigured;
      if (!to || !text) return { ok: false, error: "send needs `to` and `text`." };
      if (!connected) return notConnected();
      let result;
      try {
        result = await client.send(to, { text, ...(replyTo ? { replyTo } : {}) });
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
      }
      const out = {
        ok: Boolean(result?.delivered),
        messageId: result?.id ?? null,
        delivery: result?.delivery ?? null,
        ...(result?.code ? { code: result.code } : {}),
        ...(result?.reason ? { reason: result.reason } : {}),
      };
      const seconds = Number.isInteger(expect_reply_s) && expect_reply_s >= 0 ? expect_reply_s : defaultAckS;
      if (out.ok && seconds > 0) {
        // Pin the deadline to the one session the broker would pick, when the roster says.
        let targetId = null;
        try {
          const hits = (await client.listSessions()).filter((x) => matchesTarget(to, x));
          if (hits.length === 1) targetId = hits[0].id;
        } catch { /* fall back to matching by the target text */ }
        const d = { to, targetId, messageId: out.messageId, seconds, timer: null };
        d.timer = setTimer(async () => {
          if (!deadlines.delete(d)) return;
          announce(`intercom: no message from ${to} within ${seconds} s after msg=${d.messageId}; its status: ${await peerStatus(to)}.`);
        }, seconds * 1000);
        deadlines.add(d);
        out.reply_deadline_s = seconds;
      }
      return out;
    },

    list,

    // Switches run one at a time.
    pool(args) {
      const run = switching.then(() => switchPool(args));
      switching = run.catch(() => {});
      return run;
    },

    async close() {
      closed = true;
      if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
      for (const d of deadlines) clearTimer(d.timer);
      deadlines.clear();
      if (client) await client.disconnect().catch(() => {});
    },
  };
}
