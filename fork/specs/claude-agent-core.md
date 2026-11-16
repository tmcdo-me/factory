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
     A question still takes its typed answer in the session, as in Mastra Code.
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
7. **Remaining call sites** (integrations' session subscriptions, Slack, voice, routes/config,
   credentials) → seam. Lint allow-list empty; `factory.ts` builds the Mastra Code adapter only at
   the composition root.
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
     settings read-only even in the checkout: `git config`/`git remote add` fail in Claude's shell
     (commits and pushes, `push -u` included, work), and a command can't plant a hook. In a Sprite
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
     Linux host bubblewrap and socat must be installed or Claude Code refuses to start. Not
     covered: Claude's own Read/Grep tools, which run in Claude Code's process (a Read of
     `/proc/self/environ` in a Sprite would run as Claude Code itself; not checked); hooks in a
     trusted checkout's `.claude/settings.json` (they run outside the sandbox); files on the host
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
13. **Concurrency cap + docs.**
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

| Setting                                  | Default        | Meaning                                                                       |
| ---------------------------------------- | -------------- | ----------------------------------------------------------------------------- |
| `FACTORY_RUNTIMES`                       | `mastra-code`  | Enabled runtimes, e.g. `mastra-code,claude-agent`                             |
| `FACTORY_CLAUDE_AGENT_MAX_CONCURRENT`    | unset (no cap) | Optional cap on live Claude processes; dispatcher `maxInFlight` still applies |
| `FACTORY_CLAUDE_AGENT_EXECUTABLE`        | bundled        | Path to an installed `claude`                                                 |
| `CLAUDE_CODE_OAUTH_TOKEN`                | unset          | Operator-supplied; passed through, never read/stored/logged by Factory        |
| `FACTORY_SANDBOX_PROVIDER`               | auto           | `local` or `sprites` (fork); unset keeps upstream's selection                 |
| `SPRITES_TOKEN`                          | unset          | Sprites API token of the Fly.io organization, for `sprites`                   |
| `FACTORY_SPRITES_REGION`                 | unset          | Region new session Sprites are created in (Sprites default when unset)        |
| `FACTORY_SPRITES_PREFIX`                 | `factory`      | Sprite name prefix of this deployment (one per deployment sharing a token)    |
| `FACTORY_CLAUDE_AGENT_IDLE_CLOSE_MS`     | 10 minutes     | Stop an idle Claude Code after this long (`0`: never); the next turn resumes  |
| `FACTORY_CLAUDE_AGENT_BACKGROUND_MAX_MS` | 60 minutes     | Stop a Claude Code kept running only by background work after this long       |
| `FACTORY_CLAUDE_AGENT_BASH_SANDBOX`      | on             | `0`: trusted sessions' Bash outside Claude Code's sandbox (9c)                |
| `FACTORY_CLAUDE_AGENT_BASH_DENY_READ`    | unset          | More host files Claude's commands may not read (comma-separated paths)        |
| `FACTORY_DATABASE`                       | unset          | `libsql`: keep the local libSQL file outside development (one process) (14)   |

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
