import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createIntercom, intercomName } from "../src/intercom.mjs";
import { loadConfig, saveConfig } from "../src/config.mjs";
import { readFileSync } from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// A broker client stand-in with the surface src/intercom.mjs uses from pi-intercom's
// IntercomClient: connect, send, listSessions, disconnect, and the message/disconnected events.
class FakeClient extends EventEmitter {
  constructor({ failConnects = 0 } = {}) {
    super();
    this.failConnects = failConnects;
    this.connects = [];
    this.sent = [];
    this.disconnects = 0;
    this.sessions = [];
  }
  async connect(registration, sessionId) {
    this.connects.push(registration);
    this.connectIds = [...(this.connectIds ?? []), sessionId];
    if (this.failConnects > 0) {
      this.failConnects -= 1;
      throw new Error("broker unavailable");
    }
    this.sessionId = sessionId ?? "own-session-1";
  }
  async send(to, options) {
    this.sent.push({ to, ...options });
    return { id: `msg-${this.sent.length}`, delivered: true, delivery: "socket_delivered" };
  }
  async listSessions() { return this.sessions; }
  async disconnect() { this.disconnects += 1; }
}

// Manual timers: the test decides when time passes.
function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    set(fn, ms) { const id = next++; pending.set(id, { fn, ms }); return id; },
    clear(id) { pending.delete(id); },
    count() { return pending.size; },
    delays() { return [...pending.values()].map((t) => t.ms); },
    async fire(ms) {
      for (const [id, t] of [...pending]) {
        if (t.ms === ms) { pending.delete(id); await t.fn(); }
      }
    },
  };
}

const CONFIG = { intercom: { modules: "/x/node_modules", agent_dir: "/x/agent", name: "claude-test", ack_timeout_s: 60 } };

function setup({ config = CONFIG, client = new FakeClient() } = {}) {
  const lines = [];
  const timers = fakeTimers();
  const intercom = createIntercom({
    config,
    notifier: { broadcast: (line) => lines.push(line) },
    clientFactory: async () => client,
    setTimer: timers.set,
    clearTimer: timers.clear,
    log: () => {},
  });
  return { intercom, client, lines, timers };
}

const peer = { id: "01a20ddf-0305-751f-9e72-389275294565", name: "pi-1" };

test("without an intercom config the feature is off and says so", async () => {
  const { intercom } = setup({ config: {} });
  await intercom.start();
  assert.equal(intercom.enabled, false);
  const result = await intercom.send({ to: "pi-1", text: "hi" });
  assert.equal(result.ok, false);
  assert.match(result.error, /not configured/);
});

test("start registers under the configured name", async () => {
  const { intercom, client } = setup();
  await intercom.start();
  assert.equal(client.connects.length, 1);
  assert.equal(client.connects[0].name, "claude-test");
  assert.equal(client.connects[0].status, "idle");
});

test("the default name survives /reload-plugins: it follows the messaging socket, not the session id", () => {
  const socket = "/tmp/cc-socks/3342162.sock";
  const before = intercomName({}, { CLAUDE_CODE_MESSAGING_SOCKET: socket, CLAUDE_CODE_SESSION_ID: "a62909da" });
  const after = intercomName({}, { CLAUDE_CODE_MESSAGING_SOCKET: socket, CLAUDE_CODE_SESSION_ID: "c299557e" });
  assert.match(before, /^claude-[0-9a-f]{8}$/);
  assert.equal(before, after);
  assert.equal(intercomName({}, { CLAUDE_CODE_SESSION_ID: "f970d86b-d430" }), "claude-f970d86b");
  assert.equal(intercomName({ name: "claude-coord" }, { CLAUDE_CODE_SESSION_ID: "f970d86b" }), "claude-coord");
  assert.equal(intercomName({}, {}), "claude-coordinator");
});

test("an inbound message becomes one notification with sender, id and full text", async () => {
  const { intercom, client, lines } = setup();
  await intercom.start();
  client.emit("message", peer, { id: "m1", content: { text: "[V2] ACK\nsecond line" } });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^intercom from pi-1 \(01a20ddf\) msg=m1:\n\[V2\] ACK\nsecond line$/);
});

test("an inbound ask is marked as one that waits for a replyTo answer", async () => {
  const { intercom, client, lines } = setup();
  await intercom.start();
  client.emit("message", peer, { id: "m3", expectsReply: true, content: { text: "which branch?" } });
  assert.match(lines[0], /msg=m3 ask \(answer with replyTo\):/);
});

test("an inbound reply names the message it answers", async () => {
  const { intercom, client, lines } = setup();
  await intercom.start();
  client.emit("message", peer, { id: "m2", replyTo: "m1", content: { text: "yes" } });
  assert.match(lines[0], /msg=m2 replyTo=m1:/);
});

test("send passes text and replyTo and returns the delivery", async () => {
  const { intercom, client } = setup();
  await intercom.start();
  const result = await intercom.send({ to: "pi-1", text: "task", replyTo: "m9" });
  assert.deepEqual(client.sent[0], { to: "pi-1", text: "task", replyTo: "m9" });
  assert.equal(result.ok, true);
  assert.equal(result.delivery, "socket_delivered");
  assert.equal(result.messageId, "msg-1");
});

test("a send without a reply within the deadline reports once, with the peer status", async () => {
  const { intercom, client, lines, timers } = setup();
  await intercom.start();
  client.sessions = [{ ...peer, status: "idle", cwd: "/w" }];
  await intercom.send({ to: "pi-1", text: "task" });
  assert.deepEqual(timers.delays(), [60_000]);
  await timers.fire(60_000);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /no message from pi-1 within 60 s after msg=msg-1; its status: idle/);
  assert.equal(timers.count(), 0);
});

test("a message from the target clears its deadline", async () => {
  const { intercom, client, lines, timers } = setup();
  await intercom.start();
  await intercom.send({ to: "pi-1", text: "task" });
  client.emit("message", peer, { id: "m1", content: { text: "[V2] ACK" } });
  assert.equal(timers.count(), 0);
  await timers.fire(60_000);
  assert.equal(lines.length, 1);
});

test("a target named by id prefix is cleared by a message from that id", async () => {
  const { intercom, client, timers } = setup();
  await intercom.start();
  await intercom.send({ to: "01a20ddf", text: "task" });
  client.emit("message", peer, { id: "m1", content: { text: "ok" } });
  assert.equal(timers.count(), 0);
});

test("deadline matching follows the broker: any-case name and a short id prefix", async () => {
  const { intercom, client, timers } = setup();
  await intercom.start();
  await intercom.send({ to: "PI-1", text: "task" });
  await intercom.send({ to: "01a", text: "task" });
  client.emit("message", peer, { id: "m1", content: { text: "ok" } });
  assert.equal(timers.count(), 0);
});

test("a target resolved through the roster is cleared only by that session", async () => {
  const { intercom, client, timers } = setup();
  await intercom.start();
  client.sessions = [{ ...peer, status: "idle" }, { id: "cafe0000-1111", name: "other" }];
  await intercom.send({ to: "pi-1", text: "task" });
  client.emit("message", { id: "cafe0000-1111", name: "other" }, { id: "x", content: { text: "unrelated" } });
  assert.equal(timers.count(), 1);
  client.emit("message", peer, { id: "m1", content: { text: "ok" } });
  assert.equal(timers.count(), 0);
});

test("expect_reply_s 0 arms no deadline, and a per-send value overrides the default", async () => {
  const { intercom, timers } = setup();
  await intercom.start();
  await intercom.send({ to: "pi-1", text: "fyi", expect_reply_s: 0 });
  assert.equal(timers.count(), 0);
  await intercom.send({ to: "pi-1", text: "task", expect_reply_s: 5 });
  assert.deepEqual(timers.delays(), [5_000]);
});

test("a failed send arms no deadline and returns the reason", async () => {
  const { intercom, client, timers } = setup();
  await intercom.start();
  client.send = async () => ({ delivered: false, delivery: "failed", code: "E_REPLY_TARGET", reason: "no pending ask" });
  const result = await intercom.send({ to: "pi-1", text: "x", replyTo: "nope" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "E_REPLY_TARGET");
  assert.equal(timers.count(), 0);
});

test("list returns this session's name and the roster", async () => {
  const { intercom, client } = setup();
  await intercom.start();
  client.sessions = [{ ...peer, status: "thinking", cwd: "/w" }];
  const result = await intercom.list();
  assert.equal(result.self, "claude-test");
  assert.deepEqual(result.sessions, [{ name: "pi-1", id: "01a20ddf", status: "thinking", cwd: "/w" }]);
});

test("a lost broker is announced once and the client reconnects with backoff", async () => {
  const client = new FakeClient();
  const { intercom, lines, timers } = setup({ client });
  await intercom.start();
  client.failConnects = 1;
  client.emit("disconnected", new Error("socket closed"));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /intercom: lost the broker/);
  assert.deepEqual(timers.delays(), [2_000]);
  await timers.fire(2_000);
  assert.deepEqual(timers.delays(), [4_000]);
  await timers.fire(4_000);
  assert.equal(client.connects.length, 3);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /intercom: reconnected as claude-test/);
});

test("a failed start is reported, not thrown, and retried", async () => {
  const client = new FakeClient({ failConnects: 1 });
  const { intercom, lines, timers } = setup({ client });
  await intercom.start();
  assert.match(lines[0], /intercom: lost the broker|intercom: could not reach the broker/);
  assert.deepEqual(timers.delays(), [2_000]);
  await timers.fire(2_000);
  assert.equal(client.connects.length, 2);
});

test("a reconnect keeps the broker id peers may address", async () => {
  const client = new FakeClient();
  const { intercom, timers } = setup({ client });
  await intercom.start();
  client.emit("disconnected", new Error("socket closed"));
  await timers.fire(2_000);
  assert.deepEqual(client.connectIds, [undefined, "own-session-1"]);
});

test("close during a pending client load leaves no connection behind", async () => {
  const client = new FakeClient();
  let release;
  const lines = [];
  const intercom = createIntercom({
    config: CONFIG, notifier: { broadcast: (l) => lines.push(l) },
    clientFactory: () => new Promise((resolve) => { release = () => resolve(client); }),
    setTimer: () => 0, clearTimer: () => {}, log: () => {},
  });
  const started = intercom.start();
  await intercom.close();
  release();
  await started;
  assert.equal(client.connects.length, 0);
});

test("close clears deadlines and disconnects", async () => {
  const { intercom, client, timers } = setup();
  await intercom.start();
  await intercom.send({ to: "pi-1", text: "task" });
  await intercom.close();
  assert.equal(timers.count(), 0);
  assert.equal(client.disconnects, 1);
  client.emit("disconnected", new Error("closed"));
  assert.equal(timers.count(), 0);
});

test("loadConfig keeps a valid intercom block and drops an invalid one", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-delegate-intercom-"));
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ intercom: { modules: "/m", agent_dir: "/a", ack_timeout_s: 30 } }));
  assert.deepEqual(loadConfig(file).intercom, { modules: "/m", agent_dir: "/a", name: null, ack_timeout_s: 30 });
  writeFileSync(file, JSON.stringify({ intercom: { modules: "/m" } }));
  assert.equal(loadConfig(file).intercom, null);
  writeFileSync(file, JSON.stringify({}));
  assert.equal(loadConfig(file).intercom, null);
  writeFileSync(file, JSON.stringify({ intercom: { modules: "/m", agent_dir: "/a", ack_timeout_s: null } }));
  assert.equal(loadConfig(file).intercom.ack_timeout_s, 60);
});

test("saveConfig keeps a hand-written intercom block, even one that does not validate yet", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-delegate-intercom-"));
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ intercom: { modules: "/m" } }));
  saveConfig({ thinking: "low" }, file);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).intercom, { modules: "/m" });
  saveConfig({ intercom: { modules: "/m", agent_dir: "/a" } }, file);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).intercom.agent_dir, "/a");
  writeFileSync(file, JSON.stringify({}));
  saveConfig({ thinking: "low" }, file);
  assert.equal("intercom" in JSON.parse(readFileSync(file, "utf8")), false);
});
