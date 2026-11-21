// The environment a pi child process gets. The child no longer inherits everything the
// host process has: a session token or an unrelated API key in the parent would otherwise
// reach a model that runs tools. Only a fixed base allowlist crosses, plus the names the
// user lists in `env_passthrough` (for example the provider key that pi reads from the
// environment).

const POSIX_NAMES = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL",
  "LANG", "LANGUAGE", "TERM", "COLORTERM", "TMPDIR", "TZ",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
];

const WINDOWS_NAMES = [
  "Path", "PATHEXT", "SystemRoot", "SystemDrive", "ComSpec", "windir",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "TEMP", "TMP", "USERNAME", "ProgramFiles", "ProgramData",
];

const BASE_NAMES = new Set([...POSIX_NAMES, ...WINDOWS_NAMES]);

function isBaseName(name) {
  return BASE_NAMES.has(name) || name.startsWith("LC_");
}

// Returns a new object; parentEnv is never changed.
export function buildChildEnv(parentEnv, passthrough = []) {
  const env = {};
  for (const name of Object.keys(parentEnv)) {
    if (isBaseName(name) && parentEnv[name] !== undefined) env[name] = parentEnv[name];
  }
  for (const name of passthrough) {
    // Own variables only: a name such as "constructor" must not pick up an inherited
    // property of the environment object.
    if (typeof name === "string" && name !== "" && Object.hasOwn(parentEnv, name) && parentEnv[name] !== undefined) {
      env[name] = parentEnv[name];
    }
  }
  return env;
}
