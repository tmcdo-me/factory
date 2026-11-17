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
  ✅ A custom (OpenAI-compatible) provider's model carries a window: set per model in Settings with
  the provider's models (`source: 'set'`), or, left blank, read on every save from the provider's
  `/v1/models` (`source: 'reported'`; its `context_length`, `context_window`, `max_model_len`,
  `max_input_tokens`, `max_context_length`, `top_provider.context_length`, `limit.context` or
  llama.cpp's `meta.n_ctx`, never `n_ctx_train`), asked with the provider's key, at most 5 s and
  1 MB, no redirects; an unreachable list keeps the last reported value. It is kept on the
  provider's row (`model_context_windows`), and the Mastra Code mirror stamps it on each step's
  `usage` event as `contextWindow` for the model that produced the step (its reply's model, else the
  session's), from the same per-org snapshot model calls read (`sessionModelContextWindow`), so the
  meter has a limit. Custom providers ask for usage on streamed replies
  (`stream_options.include_usage`), which servers only send when asked; one that refuses the option
  by name is asked again without it (and from then on). Only org admins add, change or remove
  custom providers (members read them; `canManage`). Saving without a key keeps the stored key only
  for the same provider at the same URL origin (else "Re-enter the API key when changing the URL"),
  never for a new provider whose name maps onto another's id; `clearApiKey` removes it. A session
  whose history predates the event log (drawn from Mastra's transcript) still has no window.

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
  filesystem?: WorkspaceFilesystem; // the agent's confined file API, when the workspace has one
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
| Repo checkout                | `<root>/<sessionId>/<repo>`            | `/home/sprite/<repo>` (the Sprite user's home, probed with `pwd`), cloned by Factory's existing materialization via `executeCommand`                      |
| Claude Code binary           | SDK-bundled                            | official installer, **pinned to the SDK's CLI version** and its release SHA-256 (checked at every launch); installed before setup, no auto-update         |
| Credentials into sandbox     | process env                            | spawn-time env only (`CLAUDE_CODE_OAUTH_TOKEN`, `GH_TOKEN*`), over the exec's stdin; never in the exec URL, argv or the sprite's disk                     |
| Lifecycle                    | dir per session                        | one sprite per session, named from the session id; created lazily; destroyed when the session closes or its work item reaches Done; hibernates in between |
| Resume after Factory restart | Claude transcripts in host `~/.claude` | Claude transcripts persist on the sprite disk (`~/.factory/claude-agent/.claude`) → `resume: sessionId` works                                             |
| Server config                | —                                      | `SPRITES_TOKEN` (the Fly org's Sprites token), optional `FACTORY_SPRITES_REGION`; Node ≥ 24 (required by `@fly/sprites`)                                  |

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
| `mastracode/sandbox-sprites/`      | `@factory/sandbox-sprites`      | agent-runtime, `@mastra/sprites`, `@fly/sprites`  |
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
   - **3c** ✅ UI data layer: `useFactorySessionTranscript` (snapshot, then stream from `seq`, gap →
     resync) and `projectTranscript` (Factory transcript → the existing timeline entry shapes, so
     the 4k+ LOC of renderers keep working). (Selected by `VITE_FACTORY_TRANSCRIPT_SOURCE` /
     `localStorage['factory:transcript-source']` until 3d made it the default and removed the flag.)
   - **3d** ✅ writes through Factory routes (send, abort, approvals, suspensions, model), runtime
     state (running, usage) from the seam, removal of the dropped Mastra-only UI (goals, OM,
     permissions, multi-thread sessions), then flip the default to `factory`.
     Renderers move from the projection to native transcript items opportunistically afterwards.
     - ✅ Writes: every session's send (and steer), stop, tool approval, `ask_user` answer, plan
       decision and model switch go to `/web/factory/sessions/:id/...`, whatever its runtime and
       transcript source (`hooks/useSessionCommandMutations.ts`); Mastra Code sessions reach
       `createMastraCodeSessionCommands` through `routeSessionCommands`. A refused answer keeps the
       runtime's reason (`no_pending_suspension` still ends the prompt); a failed command carries
       its HTTP status, so a refused first prompt is still told apart from one that may have
       landed. `/follow-up` (Mastra's queued follow-up, which the seam has no command for) is gone.
       Thinking-level changes (`/think`, the thinking picker) still write Mastra's session settings.
     - ✅ Dropped Mastra-only UI removed, with its client code: chat goals (`/goal*`, the goal bar
       and status; board phase goals are server-side and unchanged), observational memory (the
       Memory settings section, the composer's memory budgets and "saving memory" activity,
       `/om`), tool permissions (the Tool permissions settings and auto-approve, `/permissions`,
       `/yolo`; approving a waiting tool call stays) and multi-thread sessions (the Factory chat at
       `/new` and a session's new-thread composer at `/workspaces/:id` now redirect to a new session
       and to the session; route thread switching and thread lists are gone, and the tab title is
       the session's own). Server routes for these stay. A chat-only Slack channel session's
       threads (`?sessionId=channel:…`) can no longer be switched between in the UI.
     - ✅ Every session is drawn from Factory's event log by default, with its runtime state from
       the seam for both runtimes: running (the composer's stop/steer, the favicon, the activity
       line), connected/reconnecting (which gates sending), usage (`/cost`) and the context meter
       come from `/transcript` + `/events`. The UI no longer creates (init, state seed) or streams
       Mastra's agent-controller session for it; it still reads a Mastra Code session's model from
       Mastra's session state (where its model and thinking settings live), and that read rebuilds
       the live Mastra session on the server. The transcript-source flag is gone. The Mastra path stays for one case: a Mastra Code session whose conversation began
       before Factory mirrored it into the log (its first stored message is over a minute older
       than its first logged event, `historyPredatesEventLog` in `@factory/runtime-mastra-code`);
       `GET /web/factory/sessions/:id/runtime` says `transcript: 'mastra'` for it, and the UI draws
       it from Mastra memory and its agent-controller stream as before. While that can't be told
       (Factory starting, storage unreachable) the route answers 503 and the UI shows the history as
       failed to load, retrying, rather than guess; the answer is read again after 5 minutes. A session the composer
       creates is drawn from the log at once. Both sources' hooks are mounted and only one is
       enabled, so learning which one never remounts the chat. Mastra's queued-follow-up count
       and decode rate (tok/s) have no counterpart in the log and show only on that path.
4. ✅ **Tools on `FactoryToolDef`.** Port tool groups one at a time (read → work-item → source-control →
   integrations → sandbox); Mastra adapter adapts them; MCP endpoint serves the same defs.
   Every tool Factory defines is a definition now, served as it is to Claude Agent and adapted for
   Mastra Code and Factory's MCP endpoint. Still Mastra tools, by design: `ask_user` and
   `submit_plan` (Mastra Code's own, suspending; slice 5 puts them on the broker), the Chat SDK's
   Slack tools, a deployment's configured `tools` (Mastra Connect among them), and the MCP endpoint's
   own `search`/`fetch`; Claude Agent still runs these through `runMastraTool`. `tools/deliver.ts`
   delivers to Mastra Code sessions rather than defining a tool, so its row moved to slice 5.
   - **4a** ✅ The seam for it, and the read tools. A session's Factory tools
     (`FactorySessionTools`, `tools/toolset.ts`) are definitions (`FactoryToolDef`) or, until their
     group is ported, Mastra tools; one per-turn builder makes them for both runtimes. Mastra Code's
     `extraTools` gets each definition as a Mastra tool (`mastraTool`, `@factory/runtime-mastra-code`:
     same name, description and Zod schema, Mastra's validation, `approval: 'required'` as
     `requireApproval`), its context built from the call (Mastra's tool call id, empty for a call
     without one, and its abort signal) and the turn the tools were built for (the session, and the
     caller as `toolIdentity` reads them, as for Claude Agent); a call that brings another session's
     or thread's request context is refused. Claude Agent's in-process MCP server lists a definition
     as it is and runs the turn's own copy of it, its input checked against that copy's schema (a
     rejected input is observed as an error); a Mastra tool still goes through `runMastraTool`. A
     definition is told from a Mastra tool by the mark `defineFactoryTool` puts on it
     (`isFactoryToolDef`). Factory's MCP endpoint adapts the same definitions, with the
     connector session's scope as their context. `FactoryToolContext.workspace` is optional (Factory's
     MCP endpoint has none). Ported: `factory_list_work_items`, `factory_inspect_work_item`,
     `factory_list_attention`, `factory_list_audit_events`; the tools themselves are unchanged. No
     inventory row: these files never imported Mastra Code. Checked with a real Mastra Code session
     on aimock (`tools/toolset.integration.test.ts`), a real `AgentController` (`tools.integration.test.ts`)
     and the fake SDK's real MCP server (`claude-agent-sessions.test.ts`).
   - **4b** ✅ The work-item group as definitions: the user session's work-item, messaging, session
     and approval tools (`factory_create_work_item` … `factory_unsubscribe_work_item`,
     `factory_signal_session`, `factory_message_origin`, the side-session tools,
     `factory_start_session`, `factory_switch_session_model`, `factory_answer_approval`,
     `factory_answer_question`), and a bound run's `factory_transition_work_item`
     (`approval: 'required'`, so Mastra Code still asks unless the session allows it; Claude Agent, as before, runs
     it unasked), `factory_record_review_verdict` and `factory_review_source`. A bound run's tools use
     the call's id (`ctx.callId`, the transition's idempotent ingress; a call without one is refused,
     as before) and re-read the binding of the turn they were built for at each call. Upstream
     re-resolved the session from Mastra's execution context; a call whose context names another
     session or thread is now refused before the tool runs (`mastraCodeToolContext`).
     What the approval tools resume (Mastra Code's suspensions) is unchanged until slice 5.
   - **4c** ✅ The source-control tools as definitions (`source_control_*`, `session/source-control-tools.ts`).
     `source_control_push_branch` runs git in the call's session workspace (`ctx.workspace.sandbox`):
     Claude Agent's, or for Mastra Code the agent's workspace as the seam describes it
     (`mastraSessionWorkspace`: its sandbox, the session's checkout, the sandbox's processes where it
     has them; `kind: 'remote'` for a provider that launches none, such as Platform), built only
     when a tool reads it. The session a turn runs in is read in one place, `turnSession`
     (`session/turn-session.ts`): the `controller` entry of the turn's request context, which Mastra
     Code's controller sets and Claude Agent's turns mirror; the tool scope and the source-control
     tools read it there instead of through Mastra Code's types. Allowing Factory's no-approval tools
     on a new Mastra Code session is the adapter's (`allowToolsWithoutAsking`); Factory keeps the list
     and the check that the session is a Factory's. Inventory: `session/source-control-tools.ts`,
     `tools/scope.ts`, `tools/permissions.ts`.
   - **4d** ✅ The integrations' tools as definitions. GitHub (and Platform GitHub, which shares them):
     `github_refresh_token`, `github_upsert_factory_triage_comment`, `github_subscribe_pr`,
     `github_unsubscribe_pr`. Slack: `attach_file` (reads through the controller's workspace
     filesystem, else the call's session workspace's: `SessionWorkspace.filesystem`, which Claude
     Agent's session workspace now carries, and which a Mastra Code agent's workspace with a
     filesystem and no sandbox gives too: `SessionWorkspace.sandbox` is optional for it), `reply_in_thread` (its streamed post keyed by
     `ctx.callId`), and Factory's own `findChannel`, `searchMessages`, `findUser`,
     `sendDirectMessage`. The Chat SDK's Slack tools (`fetchMessages`, `postMessage` and the like,
     from `chat/ai`) are that library's own and stay as they are, reaching Claude Agent through
     `runMastraTool` like a deployment's configured tools. An integration's `agentTools` and
     `sessionTools` return `FactorySessionTools`. Both files read the turn's session through
     `turnSession`, which no longer needs a session id (empty ids where the controller names none); a
     subscription from a turn that names no session is refused.
     Inventory: `integrations/slack/share-file-tool.ts`, `integrations/github/session-subscriptions.ts`
     (its pull request subscriptions themselves went through the runtime in 6c).
   - **4e** ✅ The sandbox tools as definitions: `factory_recreate_sandbox` and
     `factory_sandbox_port_url`, which signs the session's browser in for the scope's thread (the
     turn's; upstream read it from Mastra's call, the same thread).
5. ✅ **Interactions on the broker.** `submit_plan`, `ask_user`, approvals, auto-approval,
   `factory_answer_approval`, follower notifications. Design (owner's decision): the **controller is
   the authority** for Mastra Code's own suspended and gated calls (it resumes them, and decides
   between two answers), and the `InteractionBroker` is the **one index** Factory reads for both
   runtimes. Claude Agent stays unasked before Factory tools (`bypassPermissions`); a definition's
   `approval` is the knob.
   - **5a** ✅ One record for both runtimes. Every call a Mastra Code session holds for a person (a
     gated call, `ask_user`, `submit_plan`, another paused tool) is a broker record held by its
     controller (`heldBy: 'mastra-code'`), id `<kind>:<toolCallId>` as the event mirror names it (a call
     id reused after its record settled gets `#2`, …), kept in the same store as Claude Agent's.
     `observeMastraCodeInteractions` (`@factory/runtime-mastra-code`) reads what the session waits on
     from each display-state snapshot its controller publishes (what its own UI renders), so a call
     the controller drops without an event of its own (an abort, a run that ends, a thread reset) is
     settled too; a call that finishes settles with the answer its result carries (also one taken up
     after a restart, which the controller holds only in storage). What it asks is read as Factory
     read it from the paused call (a question with its options and selection, a plan, a yes or no); a
     tool that resumes on input of its own (`request_access`) is the new `tool_input` kind, which
     nothing answers from outside its session. `broker.track`/`settleHeld` record these without
     publishing (the mirror logs the session's own events, unchanged). An answer to a held record goes
     to the runtime (`answerHeld`: `createMastraCodeSessionCommands.answer`, Mastra's own
     agent-controller handlers, with the answer's request context) and settles once it accepts, with
     who answered; of two answers in this process the second is `not_pending` without reaching the
     controller, and a `not_pending` from the controller settles the record (it holds nothing any
     more). One broker serves both runtimes (`factory.ts`). Held records survive a restart (a
     `held_by` column, added to an existing table). Readers are unchanged in 5a: parked runs and
     follower notices still come from the controller, so held records are indexed but not reported
     as parked or announced.
     After review: a call that leaves the controller's snapshot is let go of (hidden from lists) and
     settled by its outcome (its `tool_end` result, a cancellation, the run aborting or failing, a
     thread switch, or after a 15 s grace window: approved for a gate whose call is running), so an
     answer in the session records what was answered, and a session API answer records who
     (`broker.attribute`). A call that comes back (a resume that failed) is reported waiting again and
     the broker forgets what was said of it meanwhile; a runtime that refuses an answer and still waits
     keeps it pending. A call whose kind changes is settled and asked anew; a stored record the index
     missed is adopted. After a restart, held records whose session no longer waits on their call (asked
     of its controller and storage, without claiming) are settled, at most 100, one at a time. A
     Claude Agent record never writes `held_by`. Rollback: `UPDATE factory_agent_interactions SET status =
'cancelled' WHERE held_by IS NOT NULL AND status = 'pending'`. 5a–5c ship together (5a's gate
     records carry `gate: true` only from 5b).
   - **5b** ✅ Readers on the broker. Whether a session is parked, on what and since when is read
     from the broker's index (`PendingInteractions`) for both runtimes: `LiveSessions` no longer reads
     the controller's `pendingSuspensions` (it keeps run state and the feed touches), so the inbox
     (`agent-waiting`), `factory_list_attention`, the board's parked sessions, side-session and
     state-signal `isParked`, and the Waiting page read Mastra Code sessions from their records. A
     Mastra Code session parked before a restart is listed again as soon as the server starts
     (upstream showed it only once its controller session was live again). A gated call
     (`tool_approval` with `gate: true`) is answerable but, as before, doesn't count as a parked run;
     a tool that resumes on input of its own (`tool_input`) is parked with nothing to answer from
     outside. A Mastra Code call is still named by its tool call (no `interactionId`), and a question
     a tool other than `ask_user` asks is listed as `ask_user` (the record keeps what it asks, not the
     tool's name).
     After review: a gate whose run is no longer in flight (a restart: its approval persisted and can
     be answered) counts as parked. If the `agent-interactions` domain can't start, the broker keeps
     its records in memory (`FallbackInteractionStore`, said once at start), and a Mastra Code call
     whose write fails is still listed from memory and stops being listed when it settles.
   - **5c** ✅ Answers on the broker. `factory_answer_approval` and `factory_answer_question`
     (`answerParkedCall`/`answerParkedQuestion`), and the card's and inbox's `parked-approval` and
     `parked-question` routes, answer a Mastra Code session's call by its broker record
     (`broker.resolve`), as a Claude Agent one's already was (through its runtime, which resolves it in
     the broker). The broker hands the answer to the controller (`answerMastraCodeCall`,
     `@factory/runtime-mastra-code`), on the session it holds or the one it recovers from storage after a
     restart (`mastraCodeSessionToAnswer`, as Mastra's own agent-controller routes do): a gate opens
     with a decline's reason, a paused call is claimed before anything is awaited and resumed, a gate
     whose run outlived its process resumes from storage. The answer is awaited, so one the session
     couldn't carry on from is still refused with what to do, and the call stays waiting. Not through
     `createMastraCodeSessionCommands.answer` as first planned: Mastra's routes ack the resume in the
     background (a person's in-session card would otherwise time out) and take no decline reason, so
     the session API's in-session answers keep using them, and the broker settles such an answer from
     the controller's report. The owner's rule (#55), the follower and self-answer checks, private
     sessions and the "Answered by …" text are unchanged. `approval-tools.ts` no longer imports
     `@mastra/core/agent-controller`; `pausedToolInteraction`/`pausedCalls` are gone (the adapter's
     `mastraCodeInteractionRequest` reads a paused call), and `resumesOnDecision` lives in the adapter.
     Checked on aimock Mastra Code sessions: two answers at once resume once (the other is told it
     was answered), and a session parked on its plan or question before a restart is answered from
     outside it after one, the run carrying on as its owner.
     After review: an answer to a session that was never started (no thread to recover) settles its
     record (`not_pending`), while one Factory can't deliver yet (`unavailable`) is refused; a resume
     that fails after the controller let the call go keeps the call and its record waiting (checked
     on aimock with a failing `sendStreamResume`); the record keeps a question's answer as given (the
     model alone is told `Answered by …`, `delivered`). Factory runs as one server process: recovering a
     session from storage while another process holds it live is not guarded against (several
     replicas would need the controller's thread lease first).
   - **5d** ✅ Auto-approval and
     follower notices from the broker. A board run that approves its phase's own exit tool
     (`watchRun`, at most `MAX_PLAN_APPROVALS` a run) answers the paused call through its broker
     record (`broker.resolve`, `resolvedBy: 'factory'`, as the run's owner) instead of
     `respondToToolSuspension`; the record is kept a moment after the controller reports the pause,
     so the run waits for it (`whenWaitingOn`, up to 10 s; one never kept, or one a bare yes doesn't
     answer, waits for a person). A resume the controller refuses fails the decision (`run_failed`).
     A Mastra Code session's followers hear of a call from the broker as it starts waiting
     (`PendingInteractions.onRequested`, now for held records too; `createWaitingNotices`): a gate's
     urgent `approval` notice, anything else's `blocked` report, nothing for a call the board answers
     itself (`autoApproves`, set as the run sees the pause, before the broker has it). Timing: the
     notice comes as the call starts waiting, a moment before the run ends on it, not at that end. The
     run's report window still closes at that end (`observeSessionRunReports` reports nothing there for
     a run parked on a named call, and keeps its window open across a pause the board answers), and
     the notice is judged on the window the call started in (`SessionReportWindows`: an agent's own
     `blocked` in that run still stands in for it), so each wait is announced once, and not again
     after a restart. Claude Agent's notices and auto-approval are unchanged. Checked on aimock Mastra
     Code sessions (one `blocked` notice per plan or question, one `approval` per gate, none for a plan
     the board approves through the broker, the run carrying on as its owner) and on the dispatcher's
     fake sessions through a real broker (approvals capped at three, then a person is asked once).
     A call the board meant to answer and didn't (no record within the wait, one a bare yes doesn't
     answer, or a resume the session refused, which fails the decision with `run_failed`) is announced
     then (`DispatcherInteractions.announce`: the broker's record if it still waits, else the run-end
     `blocked` report).
   - **5e** ✅ Messages to Mastra Code sessions through its adapter (`tools/deliver.ts`):
     session-to-session notifications, replies and follower reports reach a Mastra Code session
     through `deliverMastraCodeNotification` (`@factory/runtime-mastra-code`), a Claude Agent one
     through `FactoryRuntimeSessions.message`; `deliverFactorySessionNotification` checks the thread is
     the target's own and picks the target's runtime. **Decision: each runtime keeps its own durable
     record behind one delivery path.** Mastra Code keeps Mastra's notification inbox (its store is the
     record and survives a restart; the inbox decides, by priority and whether the thread runs, to
     wake it, reach the running turn at its next step, or keep it for its dispatcher, and the agent's
     `notification-inbox` tool, coalescing and summaries read that store). Moving it onto
     `agent-messages` would have meant a second copy of every notification and re-implementing that
     inbox, and a message held for the next turn would no longer reach a running turn mid-run. What
     is shared: readers see both runtimes' records as one list (`factoryNotificationsOnThread`,
     `factoryNotificationReader`: the per-sender rate limit, "already answered", the run-end report
     backstop, which before missed a report kept for a Claude Agent follower, and side sessions' last
     reports), and the right to answer a message (`inReplyTo`) is claimed atomically in
     `agent-messages` for both runtimes, keyed by the answering session and the message id (upstream
     only looked for a reply already sent, which two answers in one turn both pass; upstream behaviour
     change). A Mastra Code message stays answerable as long as Mastra keeps it; its claim mark is
     forgotten after 7 days, when the reply already on the sender's thread still refuses a second.
     Dedupe keys: a notification with one (a gate's `factory-approval:<call>` notice) is kept under the
     id its key gives it (`dedupedMessageId`) on Claude Agent, so a second is `skipped: duplicate`
     (before, the key was dropped on that runtime); Mastra Code coalesces by key while the first is
     pending, as before. GitHub pull request events to subscribed sessions
     (`integrations/github/webhook.ts`, slice 7) are unchanged: one event is handled once by the event claims, whether
     webhook or poll brought it, for both runtimes, and the per-session keys from #48 stay. Checked on
     aimock Mastra Code sessions (libSQL): a message wakes an idle session, which reads it as its
     owner; two answers at once let one through, and a later one is refused; an urgent message
     reaches a running turn mid-run and that turn's next model call carries it; a low one is kept
     pending in Mastra's store across a real stop and start over the same storage and is answered
     from the restarted server (the sender, not live, opened as its owner and woken), once; the same
     GitHub review by webhook and then by poll reaches the session once.
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
     thread messages or events, stays on Mastra Code. Project default runtime in Settings → Manage Factory.
   - **6b** ✅ Claude Agent tool results count: each Factory tool call's result goes through the
     phase processor before Claude gets it (`ingestRuntimeToolResult`), so an approved
     `submit_plan` stamps the proof that lets the card leave Planning and the board's tool-result
     rules run; Claude Code's own `Bash` commands reach the git audit as `execute_command`.
   - **6c** ✅ Claude Agent run lifecycle (`rules/runtime-run-lifecycle.ts`): a phase goal is held on
     the session's thread in the same `threadState` record Mastra Code's objective API keeps (same
     id, count, `maxRuns`, statuses, card stamp, so leaving the phase ends it). After each turn that
     ended on its own, Factory judges it: met once the card left the phase or the run's pull request
     is on the card (attached to it, or filed on a card of its own), else re-kicked with a goal-judge
     reminder while runs remain (never behind another turn in flight: judged again once it ends),
     else parked as spent and the run fails `run_incomplete` (a retry runs its kickoff once more).
     Without `threadState` the phase runs once, as before. A run parked on a person ends the decision
     and is followed once they answer. Each run is on the open-run ledger (in `threadState`, renewed
     until it ends, parked or not) and in the audit log (`factory.run.started`/`ended`, with usage)
     from its kickoff to its end, one run however many re-kicks; a run live on another dispatcher
     hands the decision back, and a dead process's entries are swept.
     After each turn of a card's run that ended on its own (either runtime: each Claude Agent turn,
     a Mastra Code run's end), a card with no open pull request looks up the open pull requests of
     its session's repository whose head is the run's own branch (one listing,
     `head=<owner>:<branch>`; `findOwnBranchPullRequest`) and files the one it finds through the
     same own-pull-request path as a tool result naming it (`attachOwnBranchPullRequest`): GitHub's
     record must show a same-repository head on the card's or the run's branch, then provenance,
     the attach and the hand-off to the board's pull request review. So a pull request Claude opened
     with its own `gh pr create` (a `Bash` command, which reaches no phase processor) is on the card
     before the turn is judged, rather than when GitHub's "opened" or a reconcile arrives.
     A turn short of its goal that ended asking the person something in plain text (not with
     `ask_user`) is not re-kicked with a goal-judge reminder: before the re-kick, Factory asks whether
     it waits on a person. A cheap check of its last message first (`plainTextQuestion`: no question
     mark near its end and no phrase asking for something means no), and only when that can't tell,
     a judge that is Claude Code itself (`judgeWaitingOnPerson`): one turn of the unmodified binary
     through the Agent SDK on `claude-haiku-5-5`, with Claude Code's own system prompt and the
     judge's instructions appended, no tools, MCP servers, settings, skills or memory, nothing
     persisted, Claude Agent's own home, credential and binary (`FACTORY_CLAUDE_AGENT_EXECUTABLE`
     when set, as for local sessions), and an empty folder of its own (`<home>/goal-judge`);
     Factory calls no model API. Its first failure (no login, say) is logged. Its prompt is Mastra Code's goal judge's
     "waiting"/"continue" rules (asking for input the goal does not require, or for permission to go
     on, is "continue"); no answer within a minute, or none it can read, re-kicks as before. When it
     waits, the run is parked on the question as on an `ask_user`: a question interaction in the
     broker (inbox, `factory_list_attention`, the card), the goal kept active with its count
     unchanged, the decision settled and the run followed. The person's answer there, or a message
     they type in the session, is their reply; once that turn ends the goal is judged again. A new
     kickoff for the card drops the question (the run ends as aborted), and so does the process
     stopping its Claude Agent sessions (shutdown, lease lost), as a run parked on `ask_user` ends.
     **One process runs Claude Agent sessions** per database (`session/claude-agent-host.ts`): their
     Claude Code, in-memory run state and ledger writes (whole-value, no compare-and-set) live in
     it. The holder is one process (host, Claude Agent home, pid, boot nonce), renewing every 10s;
     another refuses to open Claude Agent sessions until the holder is silent for 30s or released
     it (clean shutdown), except that this instance's own process that died (same host and home,
     pid gone) is taken over at once. A claim is read back twice, 2s apart; the holder re-reads the
     record before each open and on each renewal, and stops after 30s of failed renewals. A holder
     that loses the lease stops its Claude Agent sessions (runs in flight end as aborted, saying
     another process took over) and opens no more.
   - **6c** ✅ Messages reach Claude Agent sessions: session-to-session notifications
     (`factory_signal_session`, replies, follower reports; `tools/deliver.ts`) and GitHub
     pull request subscriptions go through the runtime instead of waking the controller
     session; the integrations' post-tool observers (subscribe to the PR a session opened, Slack
     announcements) see Claude Agent's Factory tools and `Bash`.
   - **6d** ✅ Claude Agent approvals outside the session: a session waiting on a person (its
     `ask_user` question or `submit_plan` plan, pending in the broker) counts as a parked run
     (`session/pending-interactions.ts`), so it shows in the inbox (`agent-waiting`),
     `factory_list_attention`, the board and the session lists, and its followers get the
     `blocked` notice naming the call; a plan is answered from the card or inbox button or
     `factory_answer_approval` through the broker, the run carrying on as the session's owner.
     Questions are answered outside the session too, on both runtimes: a parked run carries what
     it asks (`session/parked-interaction.ts`: the tool call or broker interaction, the question
     and its options, or the plan) into `factory_list_attention` (with `answerWith`, the tool that
     answers it) and the inbox's `agent-waiting` items; `factory_answer_question` and
     `POST /web/user-sessions/:id/parked-question` take the answer. **Owner's rule:** an answer in
     words comes only from the session's owner, an org admin (web), or the person who filed its
     card; a follower keeps upstream's approve/decline for plans and gated calls but can't answer a
     question for the owner (the tool also needs the calling session to be the origin or a follower,
     and never the waiting session itself, for questions and approvals alike). The answer is checked
     against the question (one value for free text or a single choice; distinct values, at most one
     of the person's own, for a multiple choice, as the in-session "Other…" allows). The run carries
     on as the session's owner and the answer is audited as `factory.run.answered`; a Mastra Code
     session answered by someone else is told so (`Answered by <name>: …`), a Claude Agent one
     records it on the interaction. `factory_list_attention` never lists another person's private
     session, and the inbox caps a plan at 64 KB and a gated call's arguments at 4 KB. A Mastra Code `ask_user` resumes through the controller's claimed
     suspension; a Claude Agent question (an `ask_user` call, or a question a board run's turn
     ended on in plain text, named by its interaction id) resolves through the broker. The UI's
     Waiting page (`/factories/:id/waiting`, sidebar count) lists every card session waiting on a
     person and every proposal, and answers each in place with the session's own ask-user and
     plan cards (a Mastra Code plan is read from that session's workspace); a proposal is approved
     or dismissed through the decision route, which decides who may.
   - **6e** ✅ Factory messages to Claude Agent sessions are kept (fork-only `agent-messages`
     domain): one held for the session's next turn survives a restart (still at most 20 per
     session, the rest dropped and counted); each session-to-session notification carries its
     id, so `factory_message_origin({ inReplyTo })` answers it once, back to its sender, as in
     Mastra Code (claimed atomically, so two answers in one turn can't both go; the claim is
     leased for 15 minutes, or until a queued answer's slot plus 15, so one a restart lost can be
     sent again); and the per-sender rate limit counts them from storage, with no in-memory map.
     A message stays answerable for 7 days after Claude read it, then is forgotten (Mastra Code's
     notification records have no such window); one still waiting is never forgotten. Without the domain (a warning at start), messages wait in
     memory and `held` says a restart would lose them.
   - **6f** ✅ Pull requests on active cards, polled (a safety net beside webhooks, and the only
     source while GitHub can't reach the server): every minute
     (`MASTRACODE_GITHUB_ACTIVE_PR_POLL_INTERVAL_MS`, default 60000, at least 10000; `0` off) the
     pull requests bound to cards in a working column (their own, or an open one attached) are read
     with conditional requests (`If-None-Match` on the last ETag, so an unchanged pull request is
     three free `304`s: the pull request, its reviews following `Link` pages (a list of several pages
     is read whole each tick, since a later page can change while the first doesn't), its comments read from
     the newest one seen on), and what changed goes where a webhook delivery goes, the board's rules
     ingress and then the sessions subscribed to the pull request: closed or merged, new commits
     (`synchronize`), a review submitted, a comment. Each event is handled once whichever way it
     came, by its content key (`githubEventContentKey`: the merge, or a close with its `closed_at`
     so a close after a reopen is its own; a push as `before..after`, so a push back to an earlier
     head is its own; the review or comment id), claimed in storage (fork-only `github-events`
     domain, kept 30 days; a claim is taken, already done, or busy with another caller, and only its
     owner's token finishes or gives it back; a failure gives it back) on the webhook path and the
     poll alike (the poll leaves an event that is busy elsewhere, keeping neither its answer's ETag
     nor the event, and reads it again next tick), and each notification
     to a session carries that key as its dedupe key (Claude Agent sessions keep it with the message),
     so no session hears one event twice, also after a restart. An answer's ETag and what it
     delivered are kept only once every delivery from it succeeded. A `403`/`429` rate limit stops
     the tick until GitHub's `retry-after` or `x-ratelimit-reset`. One lease across replicas, kept
     from tick to tick, which the process running Claude Agent sessions takes first; per-process
     state: a pull request's first poll takes what it finds as known, delivering only a close and
     the reviews and comments since its card entered the column (at most 15 minutes back), and a
     repository whose cards can't be read keeps what was seen of it. The full sweeps keep their
     cadence. Check runs and statuses are not polled here (`active-pull-request-poll.ts`).
   - **6g** ✅ A card follows its pull request's CI and reviews (Settings → Manage Factory → "Pull
     request checks": off, show status (the default), or show status and fix; only an organization
     admin changes it, others see it disabled). The active pull request poll (6f) also reads the
     head's check runs (every page) and commit statuses, conditionally, for same-repository heads;
     Factory's own check runs don't count (its app, or the `external_id` `factory-review` it gives
     the ones it publishes), and `check_suite`, `check_run` and `status` webhooks only make the poll
     read again: within 5 seconds of the first, never later than the tick already due, a steady
     stream never postponing it, one arriving during a tick polling again after it. The status is
     kept on the card's record of the pull request (its source row, `pullRequestCi`), so the
     card's revision, which runs and moves check, doesn't change for it; it shows as a badge on the
     card and in list rows: "Checks failing" (a failed check or status; a cancelled run is not a
     failure) before "Changes requested" before "Checks running" before "Ready to merge" (an
     approval and every check green); reviews count only from people with write access; green and
     not approved shows nothing; a card that leaves its working column, or a project turned off,
     clears it. With fixing on, the card's own pull request (its head in the repository itself, on
     the card's own branch or the one its run's provenance names; never a fork's, never one only a
     tool result named, which records no provenance either) is followed: a failure goes to the
     board's rules as `pullRequestChecksFailed` once per head and failure, and only once nothing on
     the head still runs; a change request or a comment from someone with write access does too.
     The card goes from pull request review back to Build with a message to its own run: the
     failing checks' names, links and excerpts (or the review or comment) only inside escaped
     `<untrusted-…>` elements said to be data, never instructions; the run fixes and pushes, CI
     runs again and the card follows. What fixing doesn't act on keeps upstream's notice to the run
     (Factory's own verdict, feedback from anyone else, a phase it doesn't move from, a held fix
     while building). At most `FACTORY_CI_AUTOFIX_MAX_ATTEMPTS` (default 3) moves per pull request,
     each taken atomically before the move commits (and given back if it doesn't); a new pull
     request starts its own count. Past them, for a failure an earlier attempt already sent back,
     or when the count can't be read, the move waits for a person (`consent: 'required'`: a
     proposal in the inbox that only an organization admin may approve; `factory_resolve_proposal`
     refuses it). Factory never merges. Claude Agent sessions are denied `Bash(gh pr merge:*)` (it holds
     under `bypassPermissions`), but that is defense in depth only (`gh api` and `git push` to the
     default branch stay open, and a `gh api` pattern would block the API calls Claude needs): the
     real control is GitHub's branch protection or rulesets on the default branch, with a required
     review and no bypass for the app's installation token. A failure told to a run still building
     (no attempt spent) is told once per failure signature, so push, fail the same way, tell
     can't loop. A comment's payload names no head, so the card's attached record of the pull request
     must say its head lives in the repository itself (`headRepositoryId`, now kept with the pull
     request's facts). Build runs respect the Claude Agent cap.
   - **6h** (in progress, a stack of PRs: Mastra Code's half of the dispatcher on the seam) ✅
     _6h-1:_ `MastraCodeRuntimeSessions` (`rules/mastra-code-sessions.ts`) answers the dispatcher's
     questions about Mastra Code sessions in the seam's vocabulary over the agent controller
     (`runs`, `hasRun`, `awaitsPerson`, `abort`, plus the thread-keyed `isThreadRunning`,
     `anyRunning` and `holdsThread`, as Mastra Code's run registry is per thread). The dispatcher
     no longer calls `listActiveThreadRuns` or reads a session's run, suspension and stream state
     itself; kickoff and run watching still go through the controller (next PRs).
     Behaviour is unchanged.
     _6h-2:_ a rule's `sendMessage` to a Mastra Code session goes through the same seam call as
     Claude Agent's (`FactoryRuntimeSessions.message`, now with optional `priority`, `sourceId`,
     `idempotencyKey` and `thread`, which Claude Agent ignores): `MastraCodeRuntimeSessions.message`
     moves the session to the binding's thread as its owner and sends the same inbox notification.
     Errors keep their codes (`session_unavailable`, `notification_delivery_failed`); a session lookup or
     thread-switch failure (memory/model credentials) propagates unwrapped, as it did before, and the
     dispatcher wraps only a Claude Agent failure (`unknown`-classified for Mastra Code, pinned by test).
     _6h-3:_ a Mastra Code `invokeSkill` kickoff goes through the seam path (`#invokeSkillOnSeam` /
     `#runOnSeam`) on the Mastra Code adapter, `FactoryRuntimeSessions.kickoff` with `ownsGoal: true`: Mastra
     keeps its objective loop (it re-kicks inside one run and judges it), so the dispatcher holds the goal in
     the session and has the adapter remind it once the kickoff landed, never `#holdSeamGoal` nor
     `judgeRuntimeGoal`. `MastraCodeRuntimeSessions.kickoff` is the old Mastra block: resolve the skill or
     prompt, move to the binding's thread, append the card's description, cancel-in-flight abort, the rule's
     preface, then the `reactive` skill signal with `requireDelivery` and its deliver/wake loop, watched by
     `watchRun` (moved to `rules/watch-run.ts`, still used for the open-run wait and the replay). Its `ended`
     never rejects: it resolves with the verdict `settle()` threw in `failure` (so `run_overdue`,
     `run_terminal_event_missing`, `run_configuration_invalid` and the run-ended-in-error codes are
     unchanged) and `supersededAtEnd` evaluated at `agent_end`. Kept as before: the session's open-run
     ledger wait (`#waitForOpenRun`) and the replay of a kickoff that already landed (goal restarted,
     `#replayLanded`), failures from Mastra Code propagate unwrapped, a run suspended on a person ends the
     decision, and a clean end reconciles the binding then runs `afterRunTurn` only for a run working its
     phase. Ledger: a Mastra Code run records its start on the session (`recordSessionRunStart`, renewed only
     while watched) and the session's own listener records its end with real usage, so `#closeSeamRun`
     never records one for it (Claude Agent runs keep the thread-state ledger). Not moved:
     `#dispatchPendingStart`. Small differences: the skill is resolved when the kickoff is sent (an
     unknown skill now fails after the open-run wait, not before), the goal is held just before the preface
     rather than after it, and the working-phase `run_incomplete` check also accepts a pull request attached
     to the card, as for Claude Agent.
7. **Remaining call sites** (integrations' session subscriptions, Slack, voice, routes/config,
   credentials) → seam. Lint allow-list empty; `factory.ts` builds the Mastra Code adapter only at
   the composition root.
   Still reading the turn's session straight from the request context's `controller` entry rather
   than through `turnSession` (slice 4 moved the tools, the tool scope and the source-control and
   GitHub subscription code): `factory.ts`, `workspace.ts`, `rules/binding-context.ts` (4 reads),
   `rules/processor.ts`, `session/credential-policy.ts`, `session/environment-state-processor.ts`,
   `session/thinking-default.ts`, `storage/domains/audit/agent-audit.ts`,
   `storage/domains/audit/domain.ts`, `integrations/slack/integration.ts`,
   `integrations/slack/channel-session-link-processor.ts`, `integrations/slack/run-error-card.ts`.
8. **Claude Agent adapter** (local): text turn → built-in tools → Factory tools → interactions →
   resume/abort.
9. **Sprites sandbox**: `FactorySandbox` wrapper over `@mastra/sprites`, `workspace.spawn` via
   `sprite.spawn`, pinned Claude Code install, lifecycle (create/hibernate/destroy). Mastra Code on
   Sprites first (uses the sandbox API only), then Claude Agent on Sprites.
   - **9a** ✅ `SpritesFactorySandbox` (`@factory/sandbox-sprites`), selected with
     `FACTORY_SANDBOX_PROVIDER=sprites` + `SPRITES_TOKEN` (optional `FACTORY_SPRITES_REGION`): one
     Sprite per session, named `factory-<session id>`, created on first start and found again by
     name; Factory clones into it as for any remote sandbox, so Mastra Code runs on it unchanged.
     Its sandboxes carry the seam's `SANDBOX_PROCESSES` (`spawn` + `files`): a long-lived stdio
     process is a WebSocket exec (`sprite.spawn`). Every exec in the Sprite (commands, tools, the
     clone, agent processes) gets its environment base64-encoded over stdin, never in the exec URL,
     and Sprites errors are rebuilt without the URL the SDK writes into them. `FACTORY_SPRITES_PREFIX`
     keeps deployments sharing a token apart; `scripts/list-orphan-sprites.mjs` lists Sprites no
     session owns; `stop()` kills the long-lived processes. Not yet checked against a live Sprite.
   - **9b** ✅ Claude Agent on Sprites: `claude-agent-workspace.ts` runs Claude Code wherever the
     session's sandbox can launch processes (`sessionSandboxProcesses`: the sandbox's own, or this
     host's for a local one). In a Sprite, the web host's `prepare` installs Claude Code before the
     clone and setup command run, with the official installer, pinned to the SDK's
     `claudeCodeVersion` and verified against that release's SHA-256 from the SDK's `manifest.json`
     (the same digests as downloads.claude.ai's), in `~/.factory/claude-agent`; every open verifies
     it again (reinstalling a missing or changed binary, never running an unverified one), and every
     launch checks the checksum and the absence of managed settings (`/etc/claude-code`) before
     `exec`ing it. The install runs through the Sprite's processes with no environment. The
     workspace's `launch` gives the SDK that binary and a `spawnClaudeCodeProcess` through the
     Sprite. The environment is `claudeProcessEnv(…, { remote: true })`: Claude's credential, the
     sandbox's git credentials and the locale, nothing of the host; it is read again at every
     (re)start, after Factory's token refresh. An idle Claude Code stops after
     `FACTORY_CLAUDE_AGENT_IDLE_CLOSE_MS` (default 10 minutes), and one that ran 20 minutes restarts
     after its run, so a stale `GH_TOKEN` never outlives it (Factory re-mints tokens older than 10
     minutes before a command); neither stop happens while Claude Code reports background shells or
     subagents running (`background_tasks_changed`), except that background work alone keeps it
     at most until 45 minutes after it started (its token's deadline) or
     `FACTORY_CLAUDE_AGENT_BACKGROUND_MAX_MS` (default 60 minutes), never mid-run, with a notice in
     the transcript; a new process starts only once the stopped one exited; the next turn resumes
     from the transcript. Factory's skills plugin is written on the Sprite's filesystem; the in-process MCP
     server needs nothing, as its traffic rides Claude Code's stdio (checked with the real binary
     through a fake Sprite exec). Isolation is unchanged (`settingSources`, `CLAUDE_AGENT_ISOLATION`,
     `strictMcpConfig`). Transcripts stay on the Sprite's disk, so `resume` works after a restart.
     Claude's credential and its tool processes: see 9c. `sprites.live.test.ts` (install, turn,
     resume, sandboxed probe) passed against a live Sprite; the full Factory flow on a Sprite is
     not yet checked (`mastracode/sandbox-sprites/README.md`, "Live check").
   - **9c** ✅ Claude's credential is out of reach of Claude's own tool processes (Bash, a
     repository's tests), locally (macOS) and in Sprites, by default. Checked on real turns with a
     probe script (`bashSandboxProbeScript`, run by `session.live.test.ts` and
     `sprites.live.test.ts`). Without a sandbox, Claude Code 2.1.325 already leaves
     `CLAUDE_CODE_OAUTH_TOKEN` out of a command's environment, but a command reads it from Claude
     Code's own process (`ps eww` showed it on macOS; `/proc/<pid>/environ` in a Sprite) and, on
     the host, from Factory's own `mastracode/web/.env`. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` stays
     ruled out: Claude Code then starts in `default` instead of `bypassPermissions`, and it scrubs
     `GH_TOKEN`/`GITHUB_TOKEN` and every token-, secret- or key-like variable.
     Claude Code's Bash sandbox (`settings.sandbox`, `claudeAgentBashSandbox`) now runs every Bash
     command (`allowUnsandboxedCommands: false`, `failIfUnavailable`), with
     `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` denied (`GH_TOKEN` kept:
     git and `gh` need it) and `~/.claude/.credentials.json` unreadable; locally also the server's
     env files (`.env*` from its entry point and working directory upwards) and
     `FACTORY_CLAUDE_AGENT_BASH_DENY_READ`. Commands see no other process: Seatbelt hides them
     on macOS; in a Sprite bubblewrap gives each command its own PID namespace and `/proc`. In
     the live checks the token was in no command's environment, no visible process's environment,
     no file under Claude's home, and (macOS) a keychain item was unreadable, while `npm install`,
     `git ls-remote` with the session's `gh auth git-credential` helper, `gh api` (TLS), curl to
     the npm registry and PyPI, `git commit` and `git push` worked. What the sandbox's rules break
     and what was done: under `bypassPermissions` every host stays reachable without a prompt (no
     allow-list needed); `gh` failed TLS verification on macOS until `enableWeakerNetworkIsolation`
     (lets Go reach `trustd`; with every host reachable it opens nothing new); writes outside the
     checkout and the temp directory are refused, so the package caches under Claude's home
     (`BASH_SANDBOX_WRITABLE_HOME_DIRS`: `.npm`, `.cache`, pnpm, yarn, bun, Go, Cargo, Gradle,
     Maven, `Library/Caches`) are writable, created before Claude Code starts (a Linux rule for a
     missing path does nothing). Claude Code keeps `.git/config`, `.git/hooks` and `.claude/`
     settings read-only even in the checkout: `git config`/`git remote add` fail in Claude's shell,
     and a command can't plant a hook. Commits and pushes work, but git can't record a branch's
     upstream there: live, `git push -u` pushed and printed "could not lock config file", so later
     plain pushes had no upstream, and `git checkout -b <b> origin/main` exited 1 (it records
     `origin/main` as the upstream). Claude Code's environment now carries git config instead
     (`GIT_CONFIG_COUNT`, after any entries the sandbox sets; `CLAUDE_GIT_CONFIG`), locally and in
     Sprites: `push.default=current` (plain `git push` pushes the current branch to `origin` under
     its own name) and `branch.autoSetupMerge=false`; `push.autoSetupRemote` is left off (every
     push would try to record the upstream and print the error). `-u` still prints the error and
     plain `git pull` has no upstream on a branch Claude created (git has no default to fall back
     on; `git pull origin <branch>` works), so sandboxed sessions' instructions say to push with
     plain `git push` and pull with `git pull origin <branch>` (`BASH_SANDBOX_INSTRUCTIONS`).
     Checked live on macOS against a local bare `origin` (`session.live.test.ts`: new branch, two
     commits, two plain pushes). Factory's own pushes (`source_control_*`) run outside Claude's
     sandbox and still record upstreams; Mastra Code sessions don't get this environment. In a Sprite
     (Ubuntu 26.04) bubblewrap and socat are missing; `ensureBashSandbox` installs them with
     `apt-get` (the archive's signed index) in `prepare` and on every sandboxed open. Two more
     things stopped bubblewrap there: the Sprite's user holds the container's default capabilities
     as ambient ones (bubblewrap refuses: "Unexpected capabilities but not setuid"), so the launch
     `exec`s Claude Code through `setpriv --inh-caps=-all --ambient-caps=-all`; and the container
     masks `/proc/kcore`, `/proc/keys`, `/proc/timer_list`, `/proc/scsi`, which makes the kernel
     refuse bubblewrap's fresh `/proc` ("Can't mount proc"), so the launch unmounts those masks
     with `sudo` (each launch: a restart brings them back; the Sprite is its own VM). A setuid
     bubblewrap fails too (`capset`: no `CAP_SYS_PTRACE` in the bounding set), and
     `enableWeakerNestedSandbox` would bind the container's `/proc`, exposing Claude Code's
     environment, so neither is used. Each sandboxed launch runs a trial sandbox first and
     refuses to start Claude Code without one (exit 97). It is on by default
     (`FACTORY_CLAUDE_AGENT_BASH_SANDBOX=0` turns it off for trusted sessions); an untrusted
     checkout always runs sandboxed, and a session whose posture changes restarts with it. On a
     Linux host bubblewrap and socat must be installed or Claude Code refuses to start.
     Claude's file tools (Read, Grep, Glob, Edit, Write, NotebookEdit) run in Claude Code's own
     process, outside the sandbox, so every session also gets permission deny rules for them
     (`claudeAgentFileToolDeny`, passed as `disallowedTools`: deny rules hold under
     `bypassPermissions`, and `--disallowedTools` ones even where managed settings drop other
     settings' rules) over the same files the sandbox denies (`claudeAgentSecretFiles`: Claude's
     saved login, and on the host the server's env files and `FACTORY_CLAUDE_AGENT_BASH_DENY_READ`),
     with the Bash sandbox on or off; where Claude Code runs on Linux or in a Sprite, `/proc` too
     (`/proc/self/environ` is Claude Code's own environment). A `Read` rule covers Grep and Glob,
     an `Edit` rule Write and NotebookEdit. Checked live on macOS
     (`claude-agent-sessions.live.test.ts`): with a stand-in file named in
     `FACTORY_CLAUDE_AGENT_BASH_DENY_READ`, Read was refused it directly and through a symlink in
     the checkout, Grep over its folder returned nothing of it, the stand-in value appeared nowhere
     in the session's events, and a Read of a checkout file worked. The `/proc` rule was not checked
     in a Sprite. Not covered: hooks in a trusted checkout's `.claude/settings.json` (they run outside the sandbox); files on the host
     other than those denied (the sandbox lets commands read the rest of the machine); and `sudo`
     inside the sandbox (bubblewrap sets `no_new_privs`, so `sudo apt-get install` from Claude's
     shell doesn't work).
10. **Runtime + sandbox selection**: project defaults + per-session override in UI and API.
11. **Full board run on Claude Agent** on a scratch repo, local and on Sprites (manual E2E).
12. ✅ **Remove Claude subscription OAuth sign-in** (`routes/oauth.ts`, UI option, refuse stored
    `anthropic` OAuth creds). The Anthropic paste-code flow is gone with everything only it used:
    its `WEB_OAUTH_PROVIDERS` entry, the `/oauth/complete` route, the `paste-code` login-session
    kind and the UI's paste-code dialog, so `POST …/providers/anthropic/oauth/start` answers 404
    `oauth_not_supported` and Settings offers Anthropic as an API key only (OpenAI, Copilot and xAI
    keep their device-code sign-ins). Stored Claude subscription credentials (an `anthropic` OAuth
    row, or an `sk-ant-oat…` token saved as a key) are refused, not deleted:
    `MastraFactory`'s constructor turns on the code-sdk's `refuseClaudeSubscriptionCredentials()`
    policy (`@mastra/code-sdk/auth/claude-subscription-policy`, off by default so the TUI is
    unchanged), under which the gateway never treats such a credential as auth, never falls back to
    the Claude Max provider, refuses those tokens in `auth.json` and `ANTHROPIC_API_KEY`, and the
    OAuth registry has no `anthropic` provider, so nothing can read or refresh the token; the
    tenant store also leaves those rows out of its snapshot and never serves or refreshes them. An
    `anthropic/*` model without an API key fails with `ClaudeSubscriptionRefusedError` ("add a
    Claude API key, or run the session on Claude Agent"; run-error title "Anthropic API key
    required"), which account rotation does not answer with a token refresh. Settings lists a
    refused credential (`userCredentialRefused` / `orgCredentialRefused`) as "Not usable" with its
    Sign out / Remove key action and never counts it as a source, connection or model access;
    saving an `sk-ant-oat…` token as a key is a 400. Nothing hands `CLAUDE_CODE_OAUTH_TOKEN` to
    Mastra Code's model layer (only `runtime-claude-agent` reads it, for Claude Code). Checked
    through the real `resolveModel` against real storage and a stand-in Anthropic API
    (`routes/claude-subscription-refusal.test.ts`), not against the live server. The TUI's own
    `/login anthropic` (`mastracode/tui`) is untouched.
13. **Concurrency cap + docs.** ✅ How many Claude Agent sessions run a turn at once, on the
    whole server: Settings → Manage Factory ("Claude Agent runs at once", beside the default runtime;
    a deployment-wide value in the agent-sessions domain's runtime settings), defaulting to
    `FACTORY_CLAUDE_AGENT_MAX_CONCURRENT`; unset or `0` is no limit. A change applies without a
    restart: at once in the process that runs Claude Agent sessions, within 15 seconds from another
    sharing the database. What counts is what holds a Claude Code turn running
    (`ClaudeTurnLimiter`): a session takes a slot when its first turn opens and frees it when its last
    open turn ends; background work between turns doesn't count, and a turn waiting on a person
    (`ask_user`, `submit_plan`) frees its slot while they decide, going on at once when they answer
    (so the count can pass the cap briefly; the next turn to start waits). Over the cap nothing fails
    or is dropped: the turn is open but not sent to Claude Code, its transcript says it waits
    (`turn-queued` notice), a person's own turns go ahead of Factory's (board runs, notifications),
    the kickoff still returns at once so the dispatcher watches the run as usual, and the card shows
    "Queued (#n)" from the run queue (`claudeAgent` in `GET …/run-queue`). Stopping a waiting turn
    ends it without starting Claude Code, and so does the process stopping its sessions (shutdown,
    host lease lost). Only an organization administrator may see or change the setting (the route
    answers 403 `organization_admin_required`, and Settings leaves the row out). The cap is the
    deployment's, so on a deployment with several organizations any of their administrators may
    change it; a deployment-operator role would fit better, but this deployment has one
    organization and Factory has no such role yet. The dispatcher's
    own `maxInFlight` (10) still applies on top, and a board run waiting for a Claude Agent slot
    holds a dispatcher run slot while it waits. A turn that hangs holds its slot until it ends:
    the dispatcher's overdue timeout stops watching such a run, it does not stop the turn, so a
    person stops it from the session.
    The plain-text-question judge (6c) is a one-shot Claude Code of its own and is not counted.
14. **Production service** ✅ (`fork/ops/`): `pnpm --dir mastracode/web build` bundles the server
    without installing its dependencies from npm (the fork's `@factory/*` packages are not
    published, and npm's `@mastra/*` lack the fork's changes), so the bundle loads the monorepo's
    built packages through the host's `link:` dependencies; `pnpm start` runs it with
    `NODE_ENV=production` through varlock on `PORT` (default 5873). Production keeps the local
    libSQL file with `FACTORY_DATABASE=libsql` (it refused to start without `DATABASE_URL`). The
    server's SIGTERM handler calls only `mastra.shutdown()`, and nothing called Factory's own
    `shutdown()`, so a restart never stopped Claude Code cleanly, ended runs in flight or released
    the Claude Agent host lease; `finalize()` now runs Factory's shutdown first inside Mastra's.
    `fork/ops/` has the LaunchAgent template and start script (`homelab.factory`), a deploy script
    building each release beside the running one with automatic switch-back, and an online SQLite
    backup (database and the Claude Agent home's transcripts; not sandbox checkouts, which are
    cloned again; not `.env`, which belongs in the owner's vault) with a restore script.
    Checked by running the build on another port with a throwaway database and env. The
    LaunchAgent itself is the homelab repository's to install.
15. **Container deployment** ✅ (`fork/deploy/`, `.github/workflows/fork-image.yml`): the server off
    mac-mini as a Compose stack on the homelab, every session on a Sprite (Fly.io Machine: an
    untested option). A multi-stage image: the build stage installs only the ~70 workspace projects
    `prebuild` builds, runs the same `pnpm --dir mastracode/web build`, and `stage-runtime.mjs`
    hard-links what the bundle loads (dependencies, optional and peer dependencies from its imports,
    never dev dependencies; a missing one fails the build) into `/app`. The runtime stage is pinned
    Node 24 slim with tini, sqlite3 and tzdata; an entrypoint gives a fresh volume to `node` and
    drops to it (setpriv) before tini takes PID 1, and tini, varlock and node pass SIGTERM on to Factory's
    shutdown. One volume, `/data` (database and snapshots; no Claude Agent home, which a Sprite keeps
    on its own disk), and configuration from the environment only. `FACTORY_DEPLOYMENT=container`
    (set by the image) refuses to start unless sessions run on Sprites, and refuses the local
    browser; the goal judge, which built the SDK's default local workspace from `projectPath` on the
    server's filesystem even for a host with its own workspace, now uses the host's (every other
    non-session path, Slack threads and wakes included, already got Factory's workspace, which never
    hands out the host's filesystem). `factory-snapshot` makes the online, integrity-checked copy
    (`mastra.db-YYYY-MM-DD`, backup-verify's dated-copy pattern; libSQL checks a vector index), as
    `node`, by hand or from the stack's sidecar; the only public route is GitHub's
    `POST /web/github/webhook`, through the Cloudflare tunnel. The `Fork image` workflow builds it on
    Blacksmith, runs `smoke.sh` (boot, UI, guard, ownership, snapshot, shutdown) and pushes
    `ghcr.io/tmcdo-me/factory:<sha>` from main.

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

| Setting                                  | Default        | Meaning                                                                      |
| ---------------------------------------- | -------------- | ---------------------------------------------------------------------------- |
| `FACTORY_RUNTIMES`                       | `mastra-code`  | Enabled runtimes, e.g. `mastra-code,claude-agent`                            |
| `FACTORY_CLAUDE_AGENT_MAX_CONCURRENT`    | unset (no cap) | Default cap on Claude Agent turns at once (Settings override); see slice 13  |
| `FACTORY_CLAUDE_AGENT_EXECUTABLE`        | bundled        | Path to an installed `claude`                                                |
| `CLAUDE_CODE_OAUTH_TOKEN`                | unset          | Operator-supplied; passed through, never read/stored/logged by Factory       |
| `FACTORY_SANDBOX_PROVIDER`               | auto           | `local` or `sprites` (fork); unset keeps upstream's selection                |
| `SPRITES_TOKEN`                          | unset          | Sprites API token of the Fly.io organization, for `sprites`                  |
| `FACTORY_SPRITES_REGION`                 | unset          | Region new session Sprites are created in (Sprites default when unset)       |
| `FACTORY_SPRITES_PREFIX`                 | `factory`      | Sprite name prefix of this deployment (one per deployment sharing a token)   |
| `FACTORY_CLAUDE_AGENT_IDLE_CLOSE_MS`     | 10 minutes     | Stop an idle Claude Code after this long (`0`: never); the next turn resumes |
| `FACTORY_CLAUDE_AGENT_BACKGROUND_MAX_MS` | 60 minutes     | Stop a Claude Code kept running only by background work after this long      |
| `FACTORY_CLAUDE_AGENT_BASH_SANDBOX`      | on             | `0`: trusted sessions' Bash outside Claude Code's sandbox (9c)               |
| `FACTORY_CLAUDE_AGENT_BASH_DENY_READ`    | unset          | More host files Claude's file tools and commands may not read (comma list)   |
| `FACTORY_DATABASE`                       | unset          | `libsql`: keep the local libSQL file outside development (one process) (14)  |
| `FACTORY_DEPLOYMENT`                     | unset          | `container`: sessions only on Sprites, no local browser (15)                 |

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
  incident.io.** ✅ Removed, with Vanta, Dependabot (GitHub alert intake) and the unwired WorkOS
  audit-log mirror: their integrations, Platform variants, agent tools, routes and webhooks, rule
  sources and events, board event handlers, intake/branch/people/filter branches, GitLab review
  skills and MR checkout refresh, the Platform provider connect routes (they served only those
  providers), web entry wiring and env vars, and tests; in the UI, their settings sections,
  onboarding rows, the create-Factory wizard's project-management step (it only offered Linear and
  Jira), the board's Linear-project filter, and the GitLab host choice. Kept: the
  Platform GitHub integration and the Platform API client (GitHub via Mastra Platform; they go with
  "Mastra platform paths"), the Mastra Connect tools route and its GitHub/GitLab tool filter, and
  WorkOS _sign-in_ (`@mastra/auth-workos`, an auth provider, not an integration). No table or
  migration was dropped: stored rows naming removed providers (integration connections, intake
  config keys such as `repositoryByLinearProject`, cards with those sources) are left in place and
  simply no longer read as provider-specific.
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
