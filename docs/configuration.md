# Configuration

Everything you can change about a dispatch, and the edges of what the mode hook covers, for
someone who has pi-delegate running and has hit something they want to adjust.

## Pinning a provider and a model

If you want to pin a different model long-term (for example, a cheap local model dedicated to
dispatches while interactive pi uses something else), write
`~/.claude/pi-delegate/config.json`:

```json
{
  "provider": "ollama",
  "model": "qwen3:8b",
  "timeout_s": 1500,
  "thinking": "off",
  "tools": "read,write,edit",
  "no_context_files": true,
  "drafter_patterns": ["-draft", "_assistant", "-assistant"]
}
```

Every field is optional. Resolution order is **`pi_dispatch` call arguments → this file → pi's
own defaults**.

## Overriding one dispatch

To override one of the measured defaults for a single dispatch, specify it directly in the
`pi_dispatch` call (`thinking`, `tools`, `no_context_files`, `append_system_prompt`, `provider`,
`model`, `timeout_s`).

`--mode rpc` and `--session-id` are structural and not overridable; `--no-session` is
**deliberately never passed** (omitting it is what makes the session land on disk, which is what
gives `pi_transcript` something to read).

## Skills, extensions and the child environment

These keys go in the same `config.json`. They apply to every dispatch.

| Key | Default | Effect |
|---|---|---|
| `no_skills` | `true` | Passes `--no-skills`, so pi does not load the user's skills into a dispatch. Set `false` to let pi discover them. |
| `no_extensions` | `true` | Passes `--no-extensions`, so pi does not discover extensions. Set `false` to let pi discover them. |
| `extensions` | `[]` | Paths of extension files. Each one becomes `--extension <path>`, in order. They load even while `no_extensions` is `true`. Use absolute paths: pi resolves a relative one against the working directory of the dispatch. |
| `env_passthrough` | `[]` | Names of environment variables the child may inherit. See below. |

```json
{
  "extensions": ["/opt/ext/guard.ts"],
  "env_passthrough": ["SOME_PROVIDER_KEY"]
}
```

The pi child process does **not** inherit the whole environment of the host process. It gets a
fixed base set: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LANGUAGE`, every `LC_*`,
`TERM`, `COLORTERM`, `TMPDIR`, `TZ`, the `XDG_*` base-directory names, and on Windows the usual
system names (`Path`, `PATHEXT`, `SystemRoot`, `USERPROFILE`, `APPDATA`, `TEMP`, and so on).
Anything else stays out, including session tokens of the host. If pi reads a provider key from
the environment, list its name in `env_passthrough`, or the child will not see it.

## Task as a file or as text

`pi_dispatch` takes exactly one of `task_file` (the absolute path of a task book; pi is told to
read it) or `prompt` (the task text; it is sent to pi word for word). Giving both, giving
neither, or giving a blank `prompt` is an error and nothing is dispatched.

## Steering

`pi_steer` returns an error, and sends nothing, when the run has already ended (the message names
the final status), when the pi child process has exited, or when the message could not be written.
It also returns an error while a run is being closed out after an abort or a timeout. It answers
`Sent: <message>` only when the message was written to a child that was still running.

## Modes, and what counts as existing product code

Switch modes with `/pi-delegate:mode <mode>`; state lives in `~/.claude/pi-delegate/modes.json`,
remembered per project. "Existing product code" means a source file that already exists under
the project root's `src/`; `tasks/`, `scripts/`, `docs/`, markdown, config files, and brand-new
files are all allowed through.

`strict` is a discipline guardrail, not enforcement: the hook is only wired to `Write|Edit`, so
editing the same file with `Bash` (`sed -i`, a heredoc, `python - <<EOF`, …) is never intercepted.
There's always a way around it — it blocks editing the file yourself out of habit, not a
deliberate workaround.

To make one hand-edit (a probe), run `/pi-delegate:probe` first for a one-time bypass.
