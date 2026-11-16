# @factory/runtime-claude-agent

Claude Agent as a Factory agent runtime (fork-only): drives the **unmodified** Claude Code binary
through the Claude Agent SDK. Design and compliance constraints:
[`fork/specs/claude-agent-core.md`](../../fork/specs/claude-agent-core.md) §2, §4.2.

| Module             | What                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.ts`       | `ClaudeAgentSession`: one long-lived `query()` (streaming input) per Factory session; each `send` is a run, closed by the turn's `result`               |
| `event-mapper.ts`  | `SDKMessage` → `FactoryEvent` (streamed text/thinking/tool input, tool results with stdout/stderr, subagents, `TodoWrite` → tasks, usage and cost)      |
| `commands.ts`      | `SessionCommands` over live sessions                                                                                                                    |
| `factory-tools.ts` | Factory's tools (`FactoryToolDef`) as the in-process MCP server `factory`; each call gets the context the host binds for Claude's `tool_use` id and run |
| `skills.ts`        | `writeSkillsPlugin`: the host's chosen skills written as one local plugin (`factory:<name>`), skills only                                               |
| `builtin-tools.ts` | The allow-list of Claude Code's built-in tools, and the deny-list of those that act outside the session                                                 |
| `env.ts`           | Subprocess environment allow-list: Claude's own credential passes through untouched; server secrets never do                                            |

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
  auto-memory.
- **MCP:** only Factory's own in-process `factory` server (`strictMcpConfig`).
- **Skills:** only the skills Factory passes, as a local plugin (`plugins` + `skills`); bundled and
  repository skills stay off. Without skills, the `Skill` tool is disallowed too.
- **Built-in tools:** an allow-list (`tools`): shell, files, search, notebooks, subagents, the todo
  list, web search and fetch. Schedules and wake-ups, notifications, remote triggers, messages to
  other sessions, workflows and worktrees stay off, as do Claude Code's own question and plan prompts
  (Factory's `ask_user` and `submit_plan` replace them). See `builtin-tools.ts`.

```sh
pnpm --filter @factory/runtime-claude-agent test
# one real turn against the bundled Claude Code, on this machine's Claude login:
CLAUDE_AGENT_LIVE=1 pnpm --filter @factory/runtime-claude-agent exec vitest run src/session.live.test.ts
```
