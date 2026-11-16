# Spec: Agent runtime seam for Mastra Factory (Mastra Code + Claude Agent)

Status: **draft v2 — awaiting review** · Branch: `feat/claude-agent-core` · Owner: Tim

## 1. Objective

Factory today is welded to one agent, Mastra Code: it drives Mastra's `AgentController`/`Session`
classes directly, its UI streams Mastra's agent-controller endpoints, its board rules parse Mastra's
persisted message parts, and its tools are Mastra `createTool`s that find their session through
Mastra's request context.

Replace that with a **Factory-owned agent runtime seam** — a small interface Factory talks to for
everything agent-related — and put agents behind it as adapters:

1. **Mastra Code adapter** — today's behaviour, reimplemented behind the seam (first).
2. **Claude Agent adapter** — Claude Agent SDK, running the unmodified Claude Code binary.
3. Later, others (e.g. pi) without touching Factory.

**Mastra the framework stays** (server, routing, storage, auth, pubsub, workers, `MastraSandbox`).
Only **Mastra Code the agent** moves behind the seam.

### Done means

- Factory code outside the adapters has **no imports** of `@mastra/code-sdk` or
  `@mastra/core/agent-controller` (enforced by lint rule).
- A work item completes Intake → Planning → Building → Review → Done on **either** runtime,
  selected per project (default) and overridable per session.
- The Factory UI renders sessions from Factory's own endpoints and event format, for both runtimes.
- Existing Factory behaviour on Mastra Code is preserved (existing focused tests green at every step).

## 2. Compliance constraints (Claude Agent) — non-negotiable

Source: code.claude.com/docs/en/legal-and-compliance, /authentication, /agent-sdk/overview.

1. **Factory never handles Claude credentials.** No login UI, no token field, nothing in Factory's
   credential store, nothing logged. Auth is whatever `claude` finds: `claude /login` on the host,
   or operator-set `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) passed through untouched.
2. **Unmodified binary** — SDK-bundled, or installed via `pathToClaudeCodeExecutable`.
3. **Single user** — only the operator's own usage on the operator's subscription.
4. **Ordinary individual usage** — no limit by default; optional cap for tuning (§8).
5. **Branding** — "Claude Agent", never "Claude Code".
6. **Remove Factory's Claude subscription OAuth sign-in** (reuses Claude Code's OAuth client id).

## 3. Architecture

```
            Factory (dispatcher, boards, rules, tools, integrations, routes, UI)
                                  │  only talks to ▼
 ┌──────────────────────── @factory/agent-runtime (interface + Factory-owned services) ────────┐
 │ AgentRuntime · RuntimeSession · FactoryEvent · TranscriptStore · InteractionBroker ·        │
 │ FactoryToolDef · ContextProvider · RuntimeRegistry                                          │
 └──────────────┬───────────────────────────────────────────────┬──────────────────────────────┘
                ▼                                               ▼
     runtime-mastra-code                               runtime-claude-agent
     (wraps AgentController/Session,                   (query() per session, built-in tools,
      Mastra memory, createTool, suspend)               MCP bridge for Factory tools)
```

Composition root (the self-hosted entry, `src/mastra/index.ts`) registers adapters; Factory receives
a `RuntimeRegistry`.

### 3.1 Runtime interface (sketch — refined in slice 1)

```ts
interface AgentRuntime {
  readonly id: string; // 'mastra-code' | 'claude-agent'
  readonly label: string; // 'Mastra Code' | 'Claude Agent'
  capabilities: RuntimeCapabilities; // subagents, remoteSandbox, thinkingLevels, …
  listModels(ctx: TenantContext): Promise<RuntimeModel[]>;
  openSession(spec: SessionSpec): Promise<RuntimeSession>; // create or resume (idempotent by id)
  init?(): Promise<void>;
  shutdown?(): Promise<void>;
}

interface SessionSpec {
  sessionId: string;
  owner: { orgId: string; userId: string; resourceId: string };
  workspace: SessionWorkspace;
  tools: FactoryToolDef[]; // bound by Factory for this session
  context: ContextProvider[]; // work item / phase / environment, re-read per turn
  instructions: string; // Factory/role instructions (runtime adds its own)
  model?: string;
  runtimeState?: unknown; // adapter-private resume state (opaque to Factory)
}

interface RuntimeSession {
  readonly id: string;
  send(input: TurnInput): Promise<RunHandle>; // user message or skill kickoff
  abort(reason?: string): Promise<void>;
  setModel(modelId: string): Promise<void>;
  events(): AsyncIterable<FactoryEvent>; // live; Factory persists + fans out
  status(): SessionStatus; // idle | running | awaiting_interaction | error
  close(): Promise<void>;
}

type TurnInput =
  | { kind: 'message'; text: string; attachments?: Attachment[]; author: Author }
  | { kind: 'skill'; skillName: string; arguments: string; goal?: Goal; deliveryId: string };
```

### 3.2 Factory event + transcript format (Factory-owned, runtime-neutral)

One normalized stream; Factory persists it (single writer, same for every runtime) and serves it to
the UI. Adapters keep their own private state (Mastra memory threads, Claude session files) only
for resuming.

```ts
type FactoryEvent =
  | { type: 'run.started'; runId; input: TurnInput }
  | { type: 'run.ended'; runId; reason: 'complete' | 'aborted' | 'error' | 'awaiting_interaction' }
  | { type: 'message.started' | 'message.ended'; messageId; role: 'assistant' | 'user' }
  | { type: 'message.delta'; messageId; part: 'text' | 'reasoning'; delta: string }
  | {
      type: 'tool.started';
      callId;
      name;
      category: ToolCategory;
      input;
      executor: 'runtime' | 'factory';
      parentCallId?;
    }
  | { type: 'tool.updated'; callId; output?: string /* shell stdout etc. */ }
  | { type: 'tool.ended'; callId; result?: unknown; error?: string }
  | { type: 'interaction.requested'; interaction: PendingInteraction }
  | { type: 'interaction.resolved'; interactionId; response }
  | { type: 'usage'; inputTokens; outputTokens; costUsd?; contextTokens?; contextWindow? }
  | { type: 'subagent.started' | 'subagent.ended'; callId; label }
  | { type: 'error'; message; retryable: boolean };

type ToolCategory = 'shell' | 'file.read' | 'file.write' | 'search' | 'factory' | 'web' | 'other';
```

- **Board rules** (`onResult`, exit-tool detection, verdicts) read `tool.ended` items for
  `executor: 'factory'` from the transcript — not Mastra message parts.
- **Audits** (git audit, first-exec capture) key on `category: 'shell'` + input command, so they
  work for Mastra's `execute_command` and Claude's `Bash` alike. Adapters map tool names → category.
- **Context meter.** `usage.contextTokens` is the whole prompt of the main agent's latest model
  call (a snapshot, not a sum); `contextWindow` is that model's window when the runtime reports it
  (Claude Code does, in `result.modelUsage`; Mastra's model catalog has none). The composer shows
  both, and hides Mastra's observational-memory budgets in Claude Agent sessions.

### 3.3 Factory tools, defined once

```ts
interface FactoryToolDef<I, O> {
  name: string;
  description: string;
  input: ZodType<I>;
  output?: ZodType<O>;
  approval?: 'none' | 'required'; // seam asks the human before execute
  execute(input: I, ctx: FactoryToolContext): Promise<O>;
}
interface FactoryToolContext {
  sessionId;
  projectId;
  orgId;
  userId;
  workItemId?;
  phase?;
  workspace: SessionWorkspace;
  signal: AbortSignal;
  interact<R>(req: InteractionRequest): Promise<R>; // questions, plan approval
}
```

Every Factory tool (`factory_*`, `source_control_*`, `github_*`/`linear_*`/…, `submit_plan`,
`ask_user`) is ported to this shape. Adapters translate: Mastra adapter → `createTool`; Claude
adapter → in-process MCP server (`createSdkMcpServer`). The Factory MCP endpoint
(`/web/factory/projects/:id/mcp`) serves the same defs.

### 3.4 Human-in-the-loop: InteractionBroker (Factory-owned)

- Kinds: `question` (ask_user), `plan_approval` (submit_plan), `tool_approval` (approval: required,
  plus runtime-native permission prompts if an adapter surfaces them).
- `ctx.interact()` persists a `PendingInteraction`, emits `interaction.requested`, and awaits.
- The UI / `factory_answer_approval` / board auto-approval answer through the broker.
- If the runtime process is gone when the answer arrives (restart), the broker reopens the session
  via its adapter and delivers the answer (`RuntimeSession.send` with an interaction-response input;
  adapters may implement a native resume, e.g. Mastra `resumeStream`).

### 3.5 Workspace contract

```ts
interface SessionWorkspace {
  kind: 'local' | 'sprite';
  checkoutDir: string; // repo path *inside* the sandbox
  sandbox: MastraSandbox; // command/file API (Mastra Code uses this)
  env(): Promise<Record<string, string>>; // sandbox env incl. GH_TOKEN*, git credential helper
  spawn(
    cmd: string,
    args: string[],
    opts: { cwd: string; env: Record<string, string>; signal?: AbortSignal },
  ): SandboxProcess; // long-lived stdio process inside the sandbox
}
interface SandboxProcess {
  // shape matches the Agent SDK's SpawnedProcess
  stdin: Writable;
  stdout: Readable;
  stderr?: Readable;
  readonly exitCode: number | null;
  readonly killed: boolean;
  kill(signal: NodeJS.Signals): boolean;
  on(event: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}
```

Runtimes never assume the checkout is on the Factory host: Claude Agent always launches through
`workspace.spawn` (via the SDK's `spawnClaudeCodeProcess`), so local and Sprites work the same way.

### 3.6 Sandbox providers: Local + Fly.io Sprites

|                              | Local                                  | Sprites                                                                                                                                                   |
| ---------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider                     | `LocalFactorySandbox` (existing)       | `SpritesSandbox` from `@mastra/sprites` (existing, `workspaces/sprites`), wrapped as a `FactorySandbox`                                                   |
| Isolation                    | none (host user)                       | Firecracker VM per session, persistent disk, auto-hibernate when idle                                                                                     |
| `spawn`                      | `child_process.spawn`                  | `sprite.spawn()` from `@fly/sprites` — WebSocket exec with stdin/stdout/stderr, `kill`, `wait`                                                            |
| Repo checkout                | `<root>/<sessionId>/<repo>`            | `/home/sprite/<repo>` (path TBD in slice), cloned by Factory's existing `materializeRepo` via `executeCommand`                                            |
| Claude Code binary           | SDK-bundled                            | official installer in the sprite, **pinned to the SDK's bundled CLI version**, unmodified; installed once per sprite in the sandbox start hook            |
| Credentials into sandbox     | process env                            | spawn-time env only (`CLAUDE_CODE_OAUTH_TOKEN`, `GH_TOKEN*`); never written to the sprite's disk by Factory                                               |
| Lifecycle                    | dir per session                        | one sprite per session, named from the session id; created lazily; destroyed when the session closes or its work item reaches Done; hibernates in between |
| Resume after Factory restart | Claude transcripts in host `~/.claude` | Claude transcripts persist on the sprite disk → `resume: sessionId` works                                                                                 |
| Server config                | —                                      | `SPRITES_TOKEN` (Fly token), optional `FACTORY_SPRITES_ORG`/region; Node ≥ 24 (required by `@fly/sprites`)                                                |

Selection: `FACTORY_SANDBOX_PROVIDER=local|sprites` as the deployment default, overridable per
project. Platform and E2B sandbox paths are left in place but unsupported by this fork.
Later: Sprites network policy to restrict egress; checkpoints before Building for cheap rollback.

Compliance note: running the unmodified Claude Code binary in a sandbox the operator owns, signed
in with the operator's own subscription, is explicitly allowed ("Nor does it prevent an end user
from signing in to the unmodified Claude Code binary with their own Claude subscription, including
where a platform hosts Claude Code"). The commercial-terms conditions apply to offering Claude Code
inside a product to _other_ users, which this fork does not do.

### 3.7 Context, goals, models, credentials

- **Context providers** replace Mastra state-signal input processors: work item, phase, environment,
  repo instructions. The seam evaluates them at each turn and hands them to the adapter.
- **Goals** (`maxRuns` re-kick until the exit tool succeeds) move from Mastra's objective API into a
  Factory-owned loop over `RuntimeSession` — runtime-neutral.
- **Models:** `runtime.listModels()`; session model = `{ runtimeId, modelId }` stored on Factory's
  session row. Project default `{runtimeId, modelId}`; per-session override.
- **Credentials:** adapter-specific. Mastra Code keeps the tenant credential resolver; Claude Agent
  has none (host auth, §2).

### 3.8 UI transport

Factory serves its own session API, backed by the seam:
`GET /web/factory/sessions/:id/stream` (SSE `FactoryEvent`), `GET …/transcript`, `POST …/messages`,
`POST …/abort`, `POST …/interactions/:iid`, `PUT …/model`. The UI's chat domain (≈45 files, incl.
`services/transcript.ts` 1428 LOC, `agentControllerClient.ts`, `useAgentController*` hooks,
`ToolFactory.tsx`) moves to this API; tool renderers key on `category` + `name`.

## 4. Adapters

### 4.1 Mastra Code (`runtime-mastra-code`)

Owns everything that is Mastra-Code-specific today: `prepareAgentControllerMount`, the
`AgentController`, Mastra memory threads, workspace tools (`view`, `execute_command`, …), state-signal
processors (fed by context providers), `submit_plan`/`ask_user` via suspend (bridged to the broker),
the credential resolver, OM settings. Maps `AgentControllerEvent` → `FactoryEvent`. Behaviour parity
with today is the acceptance bar.

### 4.2 Claude Agent (`runtime-claude-agent`)

- One live `query()` per session in streaming-input mode; registry keyed by `sessionId`; idle eviction.
- `cwd = workspace.checkoutDir`; `env` = allow-list + `workspace.env()` + `CLAUDE_CODE_OAUTH_TOKEN`
  if set. Server secrets (`DATABASE_URL`, encryption keys, GitHub App key) never pass through —
  tested.
- `systemPrompt: { type: 'preset', preset: 'claude_code', append: instructions + context }`;
  per-turn context changes delivered with the turn's user message.
- `settingSources: ['project']` — repo `CLAUDE.md`/`.claude/` apply; operator's `~/.claude`
  hooks/plugins don't run in Factory sessions.
- Built-in tools with `permissionMode: 'bypassPermissions'` in the checkout (same trust as Mastra
  Code's local sandbox). Native `Task` subagents allowed.
- Factory tools via `createSdkMcpServer`; their handlers call `FactoryToolDef.execute` (broker
  handles approval/interaction, so Claude simply awaits the result).
- Resume: Claude `session_id` stored as `runtimeState`; new process uses `resume`.
- `abort` → `interrupt()`; `close` → `close()`. Models: Claude aliases/IDs; effort from thinking level.

## 5. Package layout (all fork-only paths)

| Path                               | Package                         | Depends on                                        |
| ---------------------------------- | ------------------------------- | ------------------------------------------------- |
| `mastracode/agent-runtime/`        | `@factory/agent-runtime`        | zod, `@mastra/core/workspace` (sandbox type)      |
| `mastracode/runtime-mastra-code/`  | `@factory/runtime-mastra-code`  | agent-runtime, `@mastra/code-sdk`, `@mastra/core` |
| `mastracode/runtime-claude-agent/` | `@factory/runtime-claude-agent` | agent-runtime, `@anthropic-ai/claude-agent-sdk`   |
| `mastracode/factory/`              | `@mastra/factory` (modified)    | agent-runtime only for agent concerns             |

Lint: `no-restricted-imports` in `mastracode/factory` and `factory-ui` for `@mastra/code-sdk*` and
`@mastra/core/agent-controller`, with an allow-list that shrinks to empty by the last slice.

## 6. Migration plan (strangler — every slice ships green)

Each slice: implement → focused tests → manual check where noted → commit.

1. **Seam package + contracts.** Interfaces, `FactoryEvent`, `TranscriptStore` (new storage domain),
   `InteractionBroker`, `RuntimeRegistry`. Unit tests. No Factory changes.
2. **Mastra Code adapter, read path.** ✅ `AgentControllerEvent` → `FactoryEvent` mapping
   (`@factory/runtime-mastra-code`); storage-backed event log + interaction store (Factory domains
   `agent-events`, `agent-interactions`); every Mastra Code session mirrored into the log (shadow
   write, deltas coalesced). Verified against a real `AgentController` session driven by a mock
   model. Finding: Mastra Code delivers typed user turns as `role: 'signal'` messages with a
   `data-user-message` part; `data-signal` / `data-system-reminder` signals are system context.
3. **Factory session API + UI on the seam**, in four parts:
   - **3a** ✅ read API: `/web/factory/sessions/:id/events` (SSE, replay by `seq`) and `/transcript`,
     behind the existing session access guard.
   - **3b** ✅ richer `FactoryEvent` for what the UI renders for any runtime (message meta and
     attachments, streamed tool input, exits, progress, notices, tasks, subagents, error codes).
   - **3c** UI data layer: `useFactorySessionTranscript` (snapshot, then stream from `seq`, gap →
     resync) and `projectTranscript` (Factory transcript → the existing timeline entry shapes, so
     the 4k+ LOC of renderers keep working). Selected by `VITE_FACTORY_TRANSCRIPT_SOURCE=factory` or
     `localStorage['factory:transcript-source']`; default stays Mastra until 3d.
   - **3d** writes through Factory routes (send, abort, approvals, suspensions, model), runtime
     state (running, usage) from the seam, removal of the dropped Mastra-only UI (goals, OM,
     permissions, multi-thread sessions), then flip the default to `factory`.
     Renderers move from the projection to native transcript items opportunistically afterwards.
4. **Tools on `FactoryToolDef`.** Port tool groups one at a time (read → work-item → source-control →
   integrations → sandbox); Mastra adapter adapts them; MCP endpoint serves the same defs.
5. **Interactions on the broker.** `submit_plan`, `ask_user`, approvals, auto-approval,
   `factory_answer_approval`, follower notifications.
6. **Dispatcher, start coordinator, goals, context providers on the seam.** Board rules read the
   Factory transcript. Removes the processor/state-signal coupling from Factory.
   - **6a** ✅ Claude Agent board runs start: a run's session that never ran takes its project's
     default runtime (`session/run-runtime.ts`); the dispatcher kicks off, messages and watches
     Claude Agent sessions through `FactoryRuntimeSessions` (`rules/runtime-sessions.ts`), with
     the same supersession, staleness and "the run moved the card" rules; Claude Code restarts
     (resuming) at each kickoff so the phase's tools and skills apply; `factory-phase` and
     `factory-work-item` reach Claude with each turn they changed; a review session or one on a
     pull request card (read from its binding, failing closed) loads none of its checkout's own
     settings. Only a session minted by the start takes the default: one the card holds, or with
     thread messages or events, stays on Mastra Code. Project default runtime in Settings → Manage Factory. Phase goals
     (`maxRuns` re-kicks) stay Mastra Code only for now.
   - **6b** ✅ Claude Agent tool results count: each Factory tool call's result goes through the
     phase processor before Claude gets it (`ingestRuntimeToolResult`), so an approved
     `submit_plan` stamps the proof that lets the card leave Planning and the board's tool-result
     rules run; Claude Code's own `Bash` commands reach the git audit as `execute_command`.
7. **Remaining call sites** (integrations' session subscriptions, Slack, voice, routes/config,
   credentials) → seam. Lint allow-list empty; `factory.ts` builds the Mastra Code adapter only at
   the composition root.
8. **Claude Agent adapter** (local): text turn → built-in tools → Factory tools → interactions →
   resume/abort.
9. **Sprites sandbox**: `FactorySandbox` wrapper over `@mastra/sprites`, `workspace.spawn` via
   `sprite.spawn`, pinned Claude Code install, lifecycle (create/hibernate/destroy). Mastra Code on
   Sprites first (uses the sandbox API only), then Claude Agent on Sprites.
10. **Runtime + sandbox selection**: project defaults + per-session override in UI and API.
11. **Full board run on Claude Agent** on a scratch repo, local and on Sprites (manual E2E).
12. **Remove Claude subscription OAuth sign-in** (`routes/oauth.ts`, UI option, refuse stored
    `anthropic` OAuth creds). Can land any time; scheduled early if convenient.
13. **Concurrency cap + docs.**

Inventory to migrate (non-test): **67** files in `mastracode/factory/src` import
`@mastra/core/agent-controller` or `@mastra/code-sdk` (heaviest: `factory.ts`, `rules/dispatcher.ts`,
`workspace.ts`, `routes/*`, `session/*`, `integrations/*`, `tools/*`); **~45** files in
`mastracode/factory-ui/src` use the agent-controller client or Mastra message types. Slice 1 checks in
the full list as `fork/specs/inventory.md` and each slice ticks its rows.

## 7. Testing

- Seam + adapters: Vitest, colocated; Claude adapter uses a fake `query()` (no model calls in CI).
- Mastra Code parity: golden event/transcript tests from recorded sessions; existing focused Factory
  tests stay green each slice (per `mastracode/factory/README.md` "Development").
- Env allow-list test asserting no server secrets reach the Claude subprocess.
- Manual E2E per slice 3, 8, 10 on a local self-hosted Factory.

## 8. Config

| Setting                               | Default        | Meaning                                                                       |
| ------------------------------------- | -------------- | ----------------------------------------------------------------------------- |
| `FACTORY_RUNTIMES`                    | `mastra-code`  | Enabled runtimes, e.g. `mastra-code,claude-agent`                             |
| `FACTORY_CLAUDE_AGENT_MAX_CONCURRENT` | unset (no cap) | Optional cap on live Claude processes; dispatcher `maxInFlight` still applies |
| `FACTORY_CLAUDE_AGENT_EXECUTABLE`     | bundled        | Path to an installed `claude`                                                 |
| `CLAUDE_CODE_OAUTH_TOKEN`             | unset          | Operator-supplied; passed through, never read/stored/logged by Factory        |

## 9. Upstream

After slice 3 we stop rebasing. Upstream Factory server changes are reviewed and cherry-picked or
re-implemented; UI non-chat, integrations, boards definitions and storage remain the cheapest to
take. `FORK.md` documents this.

## 10. Boundaries

- **Always:** slices land green; new agent-facing code goes through the seam; fork notes in `FORK.md`.
- **Ask first:** changes in `packages/core` or `packages/server`; new dependencies beyond
  `@anthropic-ai/claude-agent-sdk`; dropping a Factory feature rather than porting it.
- **Never:** read, store, log or proxy Claude credentials; modify the Claude Code binary; label
  anything "Claude Code".

## 11. Decisions

- Package scope: `@factory/*`.
- Sandboxes: Local + Fly.io Sprites (§3.6).
- Runtime selection UI: a **runtime selector in the new-session composer** ("Mastra Code / Claude
  Agent", beside the model and thinking pickers), preset from a **per-project default runtime** in
  project settings; the model list follows the selected runtime; fixed once the session starts.
  Board runs use the project default.
- Claude Agent sessions get their checkout from **Factory's own workspace factory** (the same
  instance Mastra Code uses): resolve the session's workspace with the caller's identity, start
  the sandbox (clones the repo), read the checkout path and sandbox env, run Claude Code there.
  A fork-only `agent-sessions` storage domain records each session's runtime and resume state,
  and each project's default runtime.
- Integrations: **keep GitHub, Slack** (Slack unused today, planned). **Drop Linear, GitLab, Jira,
  incident.io.**
- Mastra-Code-era features:

| Feature                                                              | Decision                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Board goals (`maxRuns` re-kick)                                      | Port as a Factory-owned loop                                        |
| Goals UI                                                             | Drop                                                                |
| Observational memory                                                 | Mastra Code adapter only, defaults; drop settings UI                |
| Voice input                                                          | Drop                                                                |
| Browser automation provider                                          | Drop (Claude may use a browser MCP later)                           |
| Knowledge runtime                                                    | Drop                                                                |
| Scorers                                                              | Drop                                                                |
| Task tools (`task_*`)                                                | Mastra Code adapter only                                            |
| LSP tools                                                            | Mastra Code adapter only                                            |
| Modes / Mastra subagents                                             | Drop (Claude native `Task` subagents allowed)                       |
| Per-category tool permissions UI                                     | Drop (broker keeps Factory-tool approvals)                          |
| Thread title generation                                              | Replace with work-item / first-message title                        |
| Model packs / onboarding                                             | Trim to Mastra Code settings                                        |
| Custom providers (OpenAI-compatible)                                 | Keep                                                                |
| Encrypted model API keys                                             | Keep (Mastra Code)                                                  |
| Thinking level                                                       | Port (→ Claude `effort`)                                            |
| Workspace `skill` tool                                               | Mastra Code adapter only; board skills delivered to both as kickoff |
| Workspace viewer, sandbox port URLs, recreate sandbox                | Keep                                                                |
| Factory MCP endpoint                                                 | Keep                                                                |
| Mastra Connect / custom tools in sessions                            | Keep via `FactoryToolDef`                                           |
| Product telemetry (PostHog)                                          | Remove                                                              |
| Health metrics                                                       | Keep, untouched                                                     |
| Mastra platform paths (auth, integrations, polling workers, sandbox) | Drop                                                                |
| TUI remote controller                                                | Drop                                                                |

Dropped features are removed in the slice that would otherwise have to port them.

## 12. Open questions

None currently.
