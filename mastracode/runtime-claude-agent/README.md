# @factory/runtime-claude-agent

Claude Agent as a Factory agent runtime (fork-only): drives the **unmodified** Claude Code binary
through the Claude Agent SDK. Design and compliance constraints:
[`fork/specs/claude-agent-core.md`](../../fork/specs/claude-agent-core.md) §2, §4.2.

| Module             | What                                                                                                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.ts`       | `ClaudeAgentSession`: one long-lived `query()` (streaming input) per Factory session; each `send` is a run, closed by the turn's `result`; a turn can carry context and show as a notice |
| `event-mapper.ts`  | `SDKMessage` → `FactoryEvent` (streamed text/thinking/tool input, tool results with stdout/stderr, subagents, `TodoWrite` → tasks, usage and cost)                                       |
| `commands.ts`      | `SessionCommands` over live sessions                                                                                                                                                     |
| `factory-tools.ts` | Factory's tools (`FactoryToolDef`) as the in-process MCP server `factory`; each call gets the context the host binds for Claude's `tool_use` id and run                                  |
| `skills.ts`        | `writeSkillsPlugin`: the host's chosen skills written as one local plugin (`factory:<name>`), skills only; `skillKickoffText` starts one for a board run                                 |
| `builtin-tools.ts` | The allow-list of Claude Code's built-in tools, and the deny-list of those that act outside the session                                                                                  |
| `env.ts`           | Subprocess environment allow-list: Claude's own credential passes through untouched; server secrets never do                                                                             |
| `install.ts`       | `ensureClaudeCode`: the official installer in a sandbox, pinned to the SDK's bundled CLI version and its release checksums; `runInProcesses` runs it with no environment                 |
| `launch.ts`        | `sandboxClaudeCodeLaunch`: Claude Code inside a sandbox, started through its `spawn` behind a checksum and managed-settings check                                                        |

Credentials: Factory never handles Claude credentials. The binary uses its own saved login
(`claude /login`) or `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` set by the operator in the
server's environment.

Isolation: a session gets nothing of the operator's Claude setup beyond the model.

- **Home:** `claudeProcessEnv(…, { home })` gives Claude Code its own `HOME` and `CLAUDE_CONFIG_DIR`.
  Factory sets it to `FACTORY_CLAUDE_AGENT_HOME`, default `~/.mastracode/web/claude-agent-home`.
  The operator's saved login does not carry over, so set `CLAUDE_CODE_OAUTH_TOKEN` (from
  `claude setup-token`) or sign in once with that home.
- **Settings:** only the repository's own CLAUDE.md and settings load (`settingSources: ['project']`),
  plus `CLAUDE_AGENT_ISOLATION`. That turns off claude.ai connectors, bundled skills and
  auto-memory. An untrusted checkout (`untrustedCheckout`: a pull request under review) loads
  none of its own settings or instructions, hooks included.
- **MCP:** only Factory's own in-process `factory` server (`strictMcpConfig`).
- **Skills:** only the skills Factory passes, as a local plugin (`plugins` + `skills`); bundled and
  repository skills stay off. Without skills, the `Skill` tool is disallowed too.
- **Built-in tools:** an allow-list (`tools`): shell, files, search, notebooks, subagents, the todo
  list, web search and fetch. Schedules and wake-ups, notifications, remote triggers, messages to
  other sessions, workflows and worktrees stay off, as do Claude Code's own question and plan prompts
  (Factory's `ask_user` and `submit_plan` replace them). See `builtin-tools.ts`.

## In a sandbox (Fly.io Sprites)

A session whose sandbox carries `SANDBOX_PROCESSES` (`@factory/sandbox-sprites`) runs Claude Code
inside it, with the same isolation as on the host:

- **Binary:** `ensureClaudeCode` runs Anthropic's installer (`curl -fsSL https://claude.ai/install.sh
| bash -s <version>`, from Claude's own home) in the sandbox: from the Sprite's `prepare`, before
  the clone and the repository's setup command, and again on every Claude Agent open when the binary
  is missing or changed. The version is the SDK package's `claudeCodeVersion` (2.1.325 for SDK
  0.3.325), never hard-coded, and the installed file must have one of that release's published
  SHA-256s (the SDK's `manifest.json`, the same as the release manifest on downloads.claude.ai). The
  check never runs the binary. It lives in `~/.factory/claude-agent`, read-only (root-owned where
  `sudo -n` works), and runs with `DISABLE_AUTOUPDATER=1`. Managed settings in `/etc/claude-code`
  (which load even with `settingSources: []`) make the install and every launch refuse.
- **Launch check:** every start runs `claudeCodeLaunchScript` first, in the same exec: the binary's
  checksum again (a repository's setup or tests could have replaced it), no managed settings,
  `CLAUDE_CODE_MANAGED_SETTINGS_PATH` unset, then `exec` with the SDK's arguments.
- **Spawn:** `sandboxClaudeCodeLaunch` gives the SDK the installed path
  (`pathToClaudeCodeExecutable`) and a `spawnClaudeCodeProcess` that starts it through the
  sandbox. The SDK talks to it over stdio as to a local process; Factory's in-process MCP server and
  the SDK's control requests ride the same stdio, so nothing in the sandbox calls back to Factory.
- **Environment:** `claudeProcessEnv(…, { home, remote: true })`: Claude's credential
  (`CLAUDE_CODE_OAUTH_TOKEN`), the sandbox's git credentials and the locale; nothing of this host
  (`HOME`, `PATH`, `TMPDIR`, certificates, proxies). `HOME`/`CLAUDE_CONFIG_DIR` point at the
  sandbox's Claude home. In a Sprite the environment travels over the process's stdin, never
  in the exec request or on disk. It is read again whenever Claude Code (re)starts.
- **Lifetime:** `idleCloseMs` stops an idle Claude Code (Factory: `FACTORY_CLAUDE_AGENT_IDLE_CLOSE_MS`,
  default 10 minutes), so it no longer keeps its Sprite awake; `recycleAfterMs` (Factory: 20
  minutes) restarts one that ran long once its run ends, so a re-minted `GH_TOKEN` reaches it. The
  next turn resumes the conversation in a new process, which starts only once the stopped one has
  exited (two processes never share a transcript). Neither stop happens while Claude Code reports
  background work (its `background_tasks_changed` level signal: background shells, subagents,
  monitors; ambient watchers don't count), since stopping would kill it; the stop is armed again
  when the work ends. The install and launch scripts run their checks with PATH pinned to the
  system's own directories.
- **Known gap:** Claude Code's tool processes (Bash, a repository's tests) inherit
  `CLAUDE_CODE_OAUTH_TOKEN`, here as on the host. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` exists in
  2.1.325 but is its CI hardening mode: it forces the permission mode to `default` and scrubs
  `GH_TOKEN` and every token-like variable too, so it is not used (see `env.ts`).
- **Skills:** `writeSkillsPlugin(dir, skills, launch.files)` writes the plugin on the sandbox's
  filesystem, under its Claude home.
- **Resume:** transcripts stay in the sandbox's Claude home (on the Sprite's disk), so a restarted
  Factory reopens the same Sprite and resumes the conversation by its session id.

```sh
pnpm --filter @factory/runtime-claude-agent test
# one real turn against the bundled Claude Code, on this machine's Claude login:
CLAUDE_AGENT_LIVE=1 pnpm --filter @factory/runtime-claude-agent exec vitest run src/session.live.test.ts
```
