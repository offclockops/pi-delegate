// Contract tests for four behaviours of a dispatch:
//   1. the task can arrive as an inline prompt, not only as a task book on disk;
//   2. the skills and extensions flags come from configuration;
//   3. steering a run that is not running is an error, not a silent "Sent";
//   4. the child process gets an allowlisted environment.
// Each test supplies its own config and pi defaults, so no result depends on the files in
// the home directory of the machine that runs it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPiArgs, dispatch } from "../src/dispatch.mjs";
import { createRegistry } from "../src/registry.mjs";
import { createToolHandlers, TOOL_DEFINITIONS } from "../src/server.mjs";
import { DEFAULTS, loadConfig, saveConfig } from "../src/config.mjs";
import { buildChildEnv } from "../src/child-env.mjs";

const CONFIG = { ...DEFAULTS, drafter_patterns: [...DEFAULTS.drafter_patterns] };
const NO_PI_DEFAULTS = { provider: null, model: null };
const FAKE_PI = ["node", "fixtures/fake-pi.mjs"];

function tmpDir(prefix = "pi-contract-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function tmpTask(body = "Modify a.ts") {
  const dir = tmpDir();
  const file = join(dir, "TASK.md");
  writeFileSync(file, body);
  return { dir, file };
}

const okVerdict = {
  status: "completed", write_count: 0, files_written: [],
  files_read_unrequested: [], git_diff_stat: "", duration_s: 1,
  tokens: { input: 1, output: 2 }, session_id: "s", last_message: "done",
  last_message_truncated: false,
};

function setup(dispatchFn, config = CONFIG) {
  return createToolHandlers({
    registry: createRegistry(),
    dispatchFn,
    eventsLogPath: join(tmpDir("pi-contract-log-"), "events.log"),
    gitDiffStatFn: () => "",
    config,
    piDefaults: NO_PI_DEFAULTS,
  });
}

// A dispatch function that records what it was given and finishes at once.
function recordingDispatch(seen) {
  return async (args) => {
    seen.push(args);
    return {
      handle: { sessionId: args.sessionId, steer() { return true; }, async abort() {}, state: () => ({ running: false }), events: [] },
      done: Promise.resolve({ ...okVerdict, session_id: args.sessionId }),
    };
  };
}

function sessionIdOf(result) {
  const match = /session_id: (\S+)/.exec(result.content[0].text);
  assert.ok(match, `no session_id in: ${result.content[0].text}`);
  return match[1];
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

// --- 1. Inline prompt ---

test("the pi_dispatch schema offers an inline prompt and requires only cwd", () => {
  const schema = TOOL_DEFINITIONS.find((t) => t.name === "pi_dispatch").inputSchema;
  assert.equal(schema.properties.prompt?.type, "string");
  assert.equal(schema.properties.task_file?.type, "string");
  assert.deepEqual(schema.required, ["cwd"]);
});

test("an inline prompt reaches dispatch as the prompt, with no task file", async () => {
  const seen = [];
  const handlers = setup(recordingDispatch(seen));
  const result = await handlers.pi_dispatch({ prompt: "List the exports of a.mjs.", cwd: tmpDir(), mode: "sync" });
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].prompt, "List the exports of a.mjs.");
  assert.equal(seen[0].taskFile ?? null, null);
});

test("a task file still reaches dispatch as the task file, with no prompt", async () => {
  const { dir, file } = tmpTask();
  const seen = [];
  const handlers = setup(recordingDispatch(seen));
  const result = await handlers.pi_dispatch({ task_file: file, cwd: dir, mode: "sync" });
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.equal(seen[0].taskFile, file);
  assert.equal(seen[0].prompt ?? null, null);
});

test("pi_dispatch refuses both a prompt and a task file, neither, and a blank prompt", async () => {
  const { dir, file } = tmpTask();
  const seen = [];
  const handlers = setup(recordingDispatch(seen));
  const cases = [
    { task_file: file, prompt: "Also this.", cwd: dir, mode: "sync" },
    { cwd: dir, mode: "sync" },
    { prompt: "   ", cwd: dir, mode: "sync" },
  ];
  for (const args of cases) {
    const result = await handlers.pi_dispatch(args);
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(seen.length, 0, "dispatch must not run for a refused call");
});

test("the handler passes an inline prompt on unchanged, surrounding space included", async () => {
  const seen = [];
  const handlers = setup(recordingDispatch(seen));
  const prompt = "  keep  every  space \n";
  await handlers.pi_dispatch({ prompt, cwd: tmpDir(), mode: "sync" });
  assert.equal(seen[0].prompt, prompt);
});

test("dispatch sends an inline prompt to the child word for word", async () => {
  const prompt = "List the exported names of src/a.mjs; answer in one line.";
  const { done } = await dispatch({
    prompt, cwd: tmpDir(), config: CONFIG, piDefaults: NO_PI_DEFAULTS, timeoutS: 10,
    sessionId: "p1", piCommand: [...FAKE_PI, "--echo-prompt"], gitDiffStat: "",
  });
  const verdict = await done;
  assert.equal(verdict.status, "completed");
  assert.ok(verdict.last_message.includes(`Received: ${prompt}`), verdict.last_message);
});

test("dispatch still passes a task file by reference", async () => {
  const { dir, file } = tmpTask();
  const { done } = await dispatch({
    taskFile: file, cwd: dir, config: CONFIG, piDefaults: NO_PI_DEFAULTS, timeoutS: 10,
    sessionId: "p2", piCommand: [...FAKE_PI, "--echo-prompt"], gitDiffStat: "",
  });
  const verdict = await done;
  assert.equal(verdict.status, "completed");
  assert.ok(verdict.last_message.includes(`Read ${file} and follow it.`), verdict.last_message);
});

// --- 2. Skills and extensions flags from configuration ---

test("by default the child still gets --no-skills and --no-extensions, and no --extension", () => {
  assert.equal(DEFAULTS.no_skills, true);
  assert.equal(DEFAULTS.no_extensions, true);
  assert.deepEqual([...DEFAULTS.extensions], []);
  const args = buildPiArgs({ sessionId: "s", config: CONFIG, piDefaults: NO_PI_DEFAULTS });
  assert.ok(args.includes("--no-skills"));
  assert.ok(args.includes("--no-extensions"));
  assert.ok(!args.includes("--extension"));
});

test("no_skills: false and no_extensions: false each drop their own flag only", () => {
  const skillsOn = buildPiArgs({ sessionId: "s", config: { ...CONFIG, no_skills: false }, piDefaults: NO_PI_DEFAULTS });
  assert.ok(!skillsOn.includes("--no-skills"));
  assert.ok(skillsOn.includes("--no-extensions"));
  const extensionsOn = buildPiArgs({ sessionId: "s", config: { ...CONFIG, no_extensions: false }, piDefaults: NO_PI_DEFAULTS });
  assert.ok(extensionsOn.includes("--no-skills"));
  assert.ok(!extensionsOn.includes("--no-extensions"));
});

test("each configured extension becomes an --extension flag, in order, beside --no-extensions", () => {
  const extensions = ["/opt/ext/guard.ts", "/opt/ext/loop.ts"];
  const args = buildPiArgs({ sessionId: "s", config: { ...CONFIG, extensions }, piDefaults: NO_PI_DEFAULTS });
  const given = args.flatMap((arg, index) => (arg === "--extension" ? [args[index + 1]] : []));
  assert.deepEqual(given, extensions);
  assert.ok(args.includes("--no-extensions"), "explicit paths load while discovery stays off");
});

test("a config object without the new keys keeps the default argument list", () => {
  // A config in the shape it had before these keys existed.
  const { no_skills, no_extensions, extensions, env_passthrough, ...legacy } = CONFIG;
  const args = buildPiArgs({ sessionId: "s", config: legacy, piDefaults: NO_PI_DEFAULTS });
  assert.ok(args.includes("--no-skills"));
  assert.ok(args.includes("--no-extensions"));
  assert.ok(!args.includes("--extension"));
});

test("configured extensions still load when extension discovery is on", () => {
  const config = { ...CONFIG, no_extensions: false, extensions: ["/opt/ext/guard.ts"] };
  const args = buildPiArgs({ sessionId: "s", config, piDefaults: NO_PI_DEFAULTS });
  assert.equal(args[args.indexOf("--extension") + 1], "/opt/ext/guard.ts");
  assert.ok(!args.includes("--no-extensions"));
});

test("loadConfig reads the new keys, and falls back to the defaults for bad values", () => {
  const file = join(tmpDir(), "config.json");
  writeFileSync(file, JSON.stringify({
    no_skills: false, no_extensions: false,
    extensions: ["/opt/ext/guard.ts", "", 7, "/opt/ext/loop.ts"],
    env_passthrough: ["SOME_PROVIDER_KEY", "", null],
  }));
  const config = loadConfig(file);
  assert.equal(config.no_skills, false);
  assert.equal(config.no_extensions, false);
  assert.deepEqual(config.extensions, ["/opt/ext/guard.ts", "/opt/ext/loop.ts"]);
  assert.deepEqual(config.env_passthrough, ["SOME_PROVIDER_KEY"]);

  writeFileSync(file, JSON.stringify({ no_skills: "no", no_extensions: 0, extensions: "x", env_passthrough: "y" }));
  const fallback = loadConfig(file);
  assert.equal(fallback.no_skills, true);
  assert.equal(fallback.no_extensions, true);
  assert.deepEqual(fallback.extensions, []);
  assert.deepEqual(fallback.env_passthrough, []);
});

test("saveConfig keeps the new keys instead of dropping them", () => {
  const file = join(tmpDir(), "config.json");
  saveConfig({ no_skills: false, extensions: ["/opt/ext/guard.ts"], env_passthrough: ["SOME_PROVIDER_KEY"] }, file);
  saveConfig({ timeout_s: 30 }, file);
  const config = loadConfig(file);
  assert.equal(config.no_skills, false);
  assert.equal(config.no_extensions, true);
  assert.deepEqual(config.extensions, ["/opt/ext/guard.ts"]);
  assert.deepEqual(config.env_passthrough, ["SOME_PROVIDER_KEY"]);
  assert.equal(config.timeout_s, 30);
});

// --- 3. Steering a run that is not running ---

function steerableDispatch({ steerCalls, running = true, steerResult = true, done = new Promise(() => {}) }) {
  return async ({ sessionId }) => ({
    handle: {
      sessionId,
      steer(message) { steerCalls.push(message); return steerResult; },
      async abort() {},
      state: () => ({ running }),
      events: [],
    },
    done: done ?? Promise.resolve({ ...okVerdict, session_id: sessionId }),
  });
}

test("pi_steer on a running dispatch sends the message", async () => {
  const steerCalls = [];
  const handlers = setup(steerableDispatch({ steerCalls }));
  const id = sessionIdOf(await handlers.pi_dispatch({ prompt: "Work.", cwd: tmpDir(), mode: "async" }));
  const result = await handlers.pi_steer({ session_id: id, message: "go left" });
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.match(result.content[0].text, /Sent:/);
  assert.deepEqual(steerCalls, ["go left"]);
});

test("pi_steer on a finished dispatch is an error and sends nothing", async () => {
  const steerCalls = [];
  const handlers = setup(steerableDispatch({ steerCalls, running: false, done: null }));
  const id = sessionIdOf(await handlers.pi_dispatch({ prompt: "Work.", cwd: tmpDir(), mode: "async" }));
  await handlers.pi_result({ session_id: id });
  const result = await handlers.pi_steer({ session_id: id, message: "go left" });
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content[0].text, /^Sent:/);
  assert.match(result.content[0].text, /completed/, "the error names the run's status");
  assert.deepEqual(steerCalls, []);
});

test("pi_steer is an error when the child has ended before the verdict is stored", async () => {
  const steerCalls = [];
  const handlers = setup(steerableDispatch({ steerCalls, running: false }));
  const id = sessionIdOf(await handlers.pi_dispatch({ prompt: "Work.", cwd: tmpDir(), mode: "async" }));
  const result = await handlers.pi_steer({ session_id: id, message: "go left" });
  assert.equal(result.isError, true);
  assert.deepEqual(steerCalls, []);
});

test("pi_steer is an error when the handle could not write the message", async () => {
  const steerCalls = [];
  const handlers = setup(steerableDispatch({ steerCalls, steerResult: false }));
  const id = sessionIdOf(await handlers.pi_dispatch({ prompt: "Work.", cwd: tmpDir(), mode: "async" }));
  const result = await handlers.pi_steer({ session_id: id, message: "go left" });
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content[0].text, /^Sent:/);
});

test("handle.steer reports true while the child runs and false after it has ended", async () => {
  const live = await dispatch({
    prompt: "Work.", cwd: tmpDir(), config: CONFIG, piDefaults: NO_PI_DEFAULTS, timeoutS: 30,
    sessionId: "st1", piCommand: [...FAKE_PI, "--hang"], gitDiffStat: "",
  });
  assert.equal(live.handle.steer("go left"), true);
  await live.handle.abort();
  await live.done;

  const ended = await dispatch({
    prompt: "Work.", cwd: tmpDir(), config: CONFIG, piDefaults: NO_PI_DEFAULTS, timeoutS: 10,
    sessionId: "st2", piCommand: FAKE_PI, gitDiffStat: "",
  });
  await ended.done;
  assert.ok(await waitFor(() => ended.handle.state().running === false), "the child should have ended");
  assert.equal(ended.handle.steer("go left"), false);
});

test("handle.steer reports false while an aborted run is being closed out", async () => {
  // --ignore-sigterm keeps the child alive through the grace period, which is the window
  // where a steer used to be written to a child that was already being killed.
  const { handle, done } = await dispatch({
    prompt: "Work.", cwd: tmpDir(), config: CONFIG, piDefaults: NO_PI_DEFAULTS, timeoutS: 30,
    sessionId: "st3", piCommand: [...FAKE_PI, "--ignore-sigterm"], gitDiffStat: "",
  });
  await handle.abort();
  assert.equal(handle.state().running, true, "the child is still alive in the grace period");
  assert.equal(handle.steer("go left"), false);
  assert.equal((await done).status, "aborted");
});

test("dispatch refuses a call with no task and a call with two", async () => {
  const { dir, file } = tmpTask();
  const base = { cwd: dir, config: CONFIG, piDefaults: NO_PI_DEFAULTS, timeoutS: 5, sessionId: "x1", piCommand: FAKE_PI, gitDiffStat: "" };
  await assert.rejects(dispatch({ ...base }), /exactly one/);
  await assert.rejects(dispatch({ ...base, taskFile: file, prompt: "Also this." }), /exactly one/);
  await assert.rejects(dispatch({ ...base, prompt: "  " }), /exactly one/);
});

// --- 4. Allowlisted child environment ---

test("buildChildEnv keeps the base variables and drops everything else", () => {
  const parent = {
    PATH: "/usr/bin", HOME: "/home/u", USER: "u", SHELL: "/bin/sh", LANG: "C.UTF-8", LC_ALL: "C",
    TERM: "xterm", TMPDIR: "/tmp", TZ: "UTC", XDG_CONFIG_HOME: "/home/u/.config",
    Path: "C:\\bin", SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\u", APPDATA: "C:\\a",
    CLAUDE_CODE_MESSAGING_TOKEN: "token", CLAUDE_CODE_SESSION_ID: "sid",
    ANTHROPIC_API_KEY: "k1", OPENAI_API_KEY: "k2", MY_SECRET: "s",
  };
  const before = JSON.stringify(parent);
  const env = buildChildEnv(parent);
  for (const name of ["PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR", "TZ", "XDG_CONFIG_HOME", "Path", "SystemRoot", "USERPROFILE", "APPDATA"]) {
    assert.equal(env[name], parent[name], name);
  }
  for (const name of ["CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_SESSION_ID", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "MY_SECRET"]) {
    assert.ok(!(name in env), `${name} must not reach the child`);
  }
  assert.equal(JSON.stringify(parent), before, "the parent environment is not changed");
});

test("buildChildEnv adds the passthrough names that exist, and only those", () => {
  const env = buildChildEnv({ PATH: "/usr/bin", OPENAI_API_KEY: "k2", MY_SECRET: "s" }, ["OPENAI_API_KEY", "NOT_SET"]);
  assert.equal(env.OPENAI_API_KEY, "k2");
  assert.ok(!("NOT_SET" in env));
  assert.ok(!("MY_SECRET" in env));
});

test("buildChildEnv passes through own variables only, not inherited property names", () => {
  const env = buildChildEnv(process.env, ["constructor", "toString", "__proto__", "hasOwnProperty"]);
  for (const name of ["constructor", "toString", "hasOwnProperty"]) {
    assert.ok(!Object.hasOwn(env, name), `${name} must not become a variable`);
  }
  assert.equal(Object.getPrototypeOf(env), Object.prototype);
});

test("the default configuration passes nothing through", () => {
  assert.deepEqual([...DEFAULTS.env_passthrough], []);
});

test("dispatch gives the child the allowlisted environment, not the parent's", async () => {
  const dumpFile = join(tmpDir(), "env.json");
  const names = ["PI_CONTRACT_TEST_SECRET", "PI_CONTRACT_TEST_KEEP", "CLAUDE_CODE_MESSAGING_TOKEN"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.PI_CONTRACT_TEST_SECRET = "secret";
  process.env.PI_CONTRACT_TEST_KEEP = "keep";
  process.env.CLAUDE_CODE_MESSAGING_TOKEN = "token";
  try {
    const { done } = await dispatch({
      prompt: "Work.", cwd: tmpDir(), timeoutS: 10, sessionId: "e1", gitDiffStat: "",
      config: { ...CONFIG, env_passthrough: ["PI_CONTRACT_TEST_KEEP"] }, piDefaults: NO_PI_DEFAULTS,
      piCommand: [...FAKE_PI, `--dump-env=${dumpFile}`],
    });
    assert.equal((await done).status, "completed");
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
  const childEnv = JSON.parse(readFileSync(dumpFile, "utf8"));
  assert.equal(childEnv.PI_CONTRACT_TEST_KEEP, "keep");
  assert.ok(!("PI_CONTRACT_TEST_SECRET" in childEnv));
  assert.ok(!("CLAUDE_CODE_MESSAGING_TOKEN" in childEnv));
  assert.ok("PATH" in childEnv || "Path" in childEnv, "the child keeps a search path");
});
