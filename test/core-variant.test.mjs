// The core variant (variants/core) is a second plugin in this marketplace: the MCP server
// and the completion monitor, plus the user-only /pi-pool command, without the discipline skills
// and the hooks. It shares its code with the
// full plugin through relative symlinks, so these tests guard the three things that can
// drift: the component set, the version, and the paths the manifests point at.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VARIANT = join(ROOT, "variants", "core");

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const inVariant = (value) => value.replaceAll("${CLAUDE_PLUGIN_ROOT}", VARIANT);

test("the core variant holds the MCP server and the monitor, and nothing else", () => {
  // package.json is here for its "type": "module". An installed copy of the variant has no
  // parent package, and without that field the extensionless scripts in bin/ would depend
  // on Node guessing their module format.
  assert.deepEqual(readdirSync(VARIANT).sort(), [".claude-plugin", ".mcp.json", "bin", "monitors", "package.json", "skills", "src"]);
  assert.deepEqual(readdirSync(join(VARIANT, ".claude-plugin")), ["plugin.json"]);
});

test("the core variant's one skill is the user-only /pi-pool command, linked from the full plugin", () => {
  assert.deepEqual(readdirSync(join(VARIANT, "skills")), ["pi-pool"]);
  const link = join(VARIANT, "skills", "pi-pool");
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readlinkSync(link), "../../../skills/pi-pool");
  assert.match(readFileSync(join(link, "SKILL.md"), "utf8"), /^disable-model-invocation: true$/m);
});

test("the core variant shares its code through relative links that stay inside the repository", () => {
  for (const name of [".mcp.json", "bin", "monitors", "package.json", "src"]) {
    const link = join(VARIANT, name);
    assert.ok(lstatSync(link).isSymbolicLink(), `${name} should be a symlink`);
    assert.equal(readlinkSync(link), `../../${name}`);
  }
});

test("the core variant has its own name and the full plugin's version", () => {
  const full = readJson(join(ROOT, ".claude-plugin", "plugin.json"));
  const core = readJson(join(VARIANT, ".claude-plugin", "plugin.json"));
  assert.notEqual(core.name, full.name);
  assert.equal(core.version, full.version);
  for (const key of ["skills", "hooks", "commands", "agents"]) {
    assert.ok(!(key in core), `the core manifest must not declare ${key}`);
  }
});

test("the marketplace lists both plugins, the variant from its own directory", () => {
  const { plugins } = readJson(join(ROOT, ".claude-plugin", "marketplace.json"));
  const core = readJson(join(VARIANT, ".claude-plugin", "plugin.json"));
  const entry = plugins.find((plugin) => plugin.name === core.name);
  assert.ok(entry, "the variant needs a marketplace entry under its manifest name");
  assert.equal(entry.source, "./variants/core");
  assert.equal(new Set(plugins.map((plugin) => plugin.name)).size, plugins.length);
});

test("the variant's MCP server and monitor commands point at files that exist", () => {
  const { mcpServers } = readJson(join(VARIANT, ".mcp.json"));
  const servers = Object.values(mcpServers);
  assert.equal(servers.length, 1);
  const scripts = servers[0].args.filter((arg) => arg.includes("${CLAUDE_PLUGIN_ROOT}")).map(inVariant);
  assert.ok(scripts.length > 0);
  for (const script of scripts) assert.ok(existsSync(script), script);

  const monitors = readJson(join(VARIANT, "monitors", "monitors.json"));
  assert.ok(monitors.length > 0);
  for (const monitor of monitors) {
    const match = /"(\$\{CLAUDE_PLUGIN_ROOT\}[^"]+)"/.exec(monitor.command);
    assert.ok(match, `no plugin path in: ${monitor.command}`);
    assert.ok(existsSync(inVariant(match[1])), match[1]);
  }
});

// The checks above only prove that the files exist. This one starts the server the way the
// variant's .mcp.json does, through the symlinked directory, because a main-module guard
// that is false on that path makes the process exit 0 without a byte and every other test
// here stays green.
test("the variant's MCP server answers initialize when started through the variant directory", async () => {
  const { mcpServers } = readJson(join(VARIANT, ".mcp.json"));
  const [server] = Object.values(mcpServers);
  const args = server.args.map(inVariant);
  const { code, stdout, stderr } = await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", reject);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`server did not exit within 15s; stdout so far: ${out}`));
    }, 15_000);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolvePromise({ code: exitCode, stdout: out, stderr: err });
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    })}\n`);
    child.stdin.end();
  });
  assert.notEqual(stdout.trim(), "", `the server wrote nothing (exit ${code}); stderr: ${stderr}`);
  const reply = stdout.trim().split("\n").map((line) => JSON.parse(line)).find((message) => message.id === 1);
  assert.ok(reply, stdout);
  const core = readJson(join(VARIANT, ".claude-plugin", "plugin.json"));
  assert.equal(reply.result.serverInfo.version, core.version);
});
