# @factory/runtime-claude-agent

Claude Agent as a Factory agent runtime (fork-only): drives the **unmodified** Claude Code binary
through the Claude Agent SDK. Design and compliance constraints:
[`fork/specs/claude-agent-core.md`](../../fork/specs/claude-agent-core.md) §2, §4.2.

| Module            | What                                                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.ts`      | `ClaudeAgentSession`: one long-lived `query()` (streaming input) per Factory session; each `send` is a run, closed by the turn's `result`          |
| `event-mapper.ts` | `SDKMessage` → `FactoryEvent` (streamed text/thinking/tool input, tool results with stdout/stderr, subagents, `TodoWrite` → tasks, usage and cost) |
| `commands.ts`     | `SessionCommands` over live sessions                                                                                                               |
| `env.ts`          | Subprocess environment allow-list: Claude's own credential passes through untouched; server secrets never do                                       |

Credentials: Factory never handles Claude credentials. The binary uses its own saved login
(`claude /login`) or `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` set by the operator in the
server's environment.

```sh
pnpm --filter @factory/runtime-claude-agent test
# one real turn against the bundled Claude Code, on this machine's Claude login:
CLAUDE_AGENT_LIVE=1 pnpm --filter @factory/runtime-claude-agent exec vitest run src/session.live.test.ts
```
