# @factory/agent-runtime

Factory's agent runtime seam (fork-only). Factory talks to agents only through this package;
runtimes (Mastra Code, Claude Agent, …) implement it as adapters. Design:
[`fork/specs/claude-agent-core.md`](../../fork/specs/claude-agent-core.md).

## Contracts

| Module            | What                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime.ts`      | `AgentRuntime`, `RuntimeSession`, `SessionSpec`, `TurnInput`, `ContextProvider`                                                                                                       |
| `events.ts`       | `FactoryEvent` — the one runtime-neutral event format — and `EventEnvelope` (`seq` per session)                                                                                       |
| `tools.ts`        | `FactoryToolDef` / `FactoryToolContext` — Factory tools defined once, adapted per runtime (Mastra Code: `mastraTool` in `@factory/runtime-mastra-code`; Claude Agent: its MCP server) |
| `interactions.ts` | Questions, plan approvals, tool approvals; `InteractionStore`                                                                                                                         |
| `workspace.ts`    | `SessionWorkspace` (checkout, sandbox API, filesystem, env, `spawn`) and `SandboxProcess`                                                                                             |

## Factory-owned services

| Module                  | What                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `event-log.ts`          | `EventLog` interface (append-only per session) + in-memory reference impl                   |
| `event-hub.ts`          | `SessionEventHub` — ordered publish, replay-then-live subscribe (SSE resume by `seq`)       |
| `transcript.ts`         | Pure reducer `FactoryEvent` → `Transcript`; shared by server (board rules, audits) and UI   |
| `interaction-broker.ts` | `InteractionBroker` — request/resolve/cancel; re-delivery after restart via `onUndelivered` |
| `registry.ts`           | `RuntimeRegistry` — enabled runtimes and the default                                        |

Storage-backed `EventLog` / `InteractionStore` implementations live in `@mastra/factory`'s
storage domains.

## Develop

```sh
pnpm --filter @factory/agent-runtime test
pnpm --filter @factory/agent-runtime check   # needs @mastra/core built
```
