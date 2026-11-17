/**
 * Drives real Mastra AgentController sessions (mock model) and checks what Factory's interaction
 * broker is told about the calls they hold for a person: a gated call, an `ask_user` question, and
 * each way such a call stops waiting (answered in the session, or dropped by an abort).
 */
import type { HeldSettlement, InteractionRequest, PendingInteraction } from '@factory/agent-runtime';
import { MockLanguageModelV2, convertArrayToReadableStream } from '@internal/ai-sdk-v5/test';
import { Agent } from '@mastra/core/agent';
import { AgentController } from '@mastra/core/agent-controller';
import { InMemoryStore } from '@mastra/core/storage';
import { askUserTool, createTool } from '@mastra/core/tools';
import { Workspace } from '@mastra/core/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { observeMastraCodeInteractions } from './interactions';

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

type DoStream = NonNullable<ConstructorParameters<typeof MockLanguageModelV2>[0]>['doStream'];
type StreamPart =
  Awaited<ReturnType<Extract<DoStream, (...args: never[]) => unknown>>>['stream'] extends ReadableStream<infer P>
    ? P
    : never;

/** First the model calls `toolName`, then it says it is done. */
function model(toolName: string, input: unknown) {
  let calls = 0;
  const steps: StreamPart[][] = [
    [
      { type: 'stream-start', warnings: [] },
      { type: 'tool-call', toolCallId: 'call-1', toolName, input: JSON.stringify(input) },
      { type: 'finish', finishReason: 'tool-calls', usage },
    ],
    [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'Done.' },
      { type: 'text-end', id: 't' },
      { type: 'finish', finishReason: 'stop', usage },
    ],
  ];
  return new MockLanguageModelV2({
    doStream: async () => ({
      rawCall: { rawPrompt: null, rawSettings: {} },
      warnings: [],
      stream: convertArrayToReadableStream(steps[Math.min(calls++, 1)]!),
    }),
  });
}

async function until(check: () => boolean, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
  return check();
}

const controllers: AgentController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.destroy?.();
});

/** A session whose model calls `toolName` once, with what the broker is told about it. */
async function sessionCalling(
  toolName: string,
  input: unknown,
  tools: Record<string, unknown>,
  { allowed = false }: { allowed?: boolean } = {},
) {
  const agent = new Agent({
    id: 'code',
    name: 'code',
    instructions: 'test',
    model: model(toolName, input),
    tools: tools as never,
  });
  const controller = new AgentController({
    id: 'code',
    storage: new InMemoryStore(),
    workspace: new Workspace({ name: 'test', skills: ['/tmp/test-skills'] }),
    modes: [{ id: 'default', name: 'Default', default: true, agent }],
  });
  controllers.push(controller);
  await controller.init();
  const session = await controller.createSession({ id: 's1', ownerId: 'o' });
  // As Mastra Code allows its own interactive tools: they ask the person themselves.
  if (allowed) session.grantTool(toolName);

  const requested: Array<PendingInteraction & { heldBy: string }> = [];
  const settled: Array<{ callId: string; settlement: HeldSettlement }> = [];
  const errors: unknown[] = [];
  const left: string[] = [];
  observeMastraCodeInteractions(
    session,
    {
      requested: interaction => requested.push(interaction),
      left: callId => left.push(callId),
      // The broker applies a settlement to what it recorded: here, the request reported for the call.
      settled: (callId, settlement) => {
        const request: InteractionRequest | undefined = requested.find(r => r.callId === callId)?.request;
        if (request) settled.push({ callId, settlement: settlement(request) });
      },
    },
    { onError: error => errors.push(error) },
  );
  return { session, requested, settled, errors, left };
}

describe('observeMastraCodeInteractions on a real AgentController session', () => {
  it('reports a gated call once, and settles it when the person approves it in the session', async () => {
    const ship = createTool({
      id: 'ship_release',
      description: 'Ship a release',
      inputSchema: z.object({ version: z.string() }),
      requireApproval: true,
      execute: async ({ version }) => ({ shipped: version }),
    });
    const { session, requested, settled, errors, left } = await sessionCalling(
      'ship_release',
      { version: '1.2.0' },
      { ship_release: ship },
    );

    void session.sendMessage({ content: 'Ship it' });
    expect(await until(() => requested.length > 0)).toBe(true);
    expect(requested).toEqual([
      expect.objectContaining({
        id: 'tool_approval:call-1',
        sessionId: 's1',
        callId: 'call-1',
        heldBy: 'mastra-code',
        request: { kind: 'tool_approval', toolName: 'ship_release', input: { version: '1.2.0' } },
      }),
    ]);

    session.respondToToolApproval({ decision: 'approve', toolCallId: 'call-1' });
    expect(await until(() => settled.some(s => s.settlement.status === 'resolved'))).toBe(true);
    // Its gate opened (the snapshot let it go) and it is settled once, by its result: allowed.
    expect(settled).toEqual([
      { callId: 'call-1', settlement: { status: 'resolved', response: { kind: 'tool_approval', approved: true } } },
    ]);
    expect(left).toEqual(['call-1']);
    expect(requested).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('reports an ask_user question with its options, and settles it when the run is aborted', async () => {
    const { session, requested, settled, errors } = await sessionCalling(
      'ask_user',
      {
        question: 'Which branch?',
        options: [{ label: 'main' }, { label: 'release/1.x', description: 'Maintenance' }],
        selectionMode: 'multi_select',
      },
      { ask_user: askUserTool },
      { allowed: true },
    );

    void session.sendMessage({ content: 'Fix it' });
    expect(await until(() => requested.length > 0)).toBe(true);
    expect(requested[0]).toMatchObject({
      id: 'question:call-1',
      callId: 'call-1',
      request: {
        kind: 'question',
        question: 'Which branch?',
        options: [{ label: 'main' }, { label: 'release/1.x', description: 'Maintenance' }],
        selection: 'multiple',
      },
    });
    expect(await until(() => !session.run.isRunning())).toBe(true);
    expect(settled).toEqual([]);

    // Aborting a parked session drops its question with no event of its own, only a new snapshot.
    session.abort();
    expect(await until(() => settled.length > 0)).toBe(true);
    // Its call ends too, denied: neither reads as an answer.
    expect(settled[0]).toEqual({ callId: 'call-1', settlement: { status: 'cancelled', reason: expect.any(String) } });
    expect(settled.every(s => s.settlement.status === 'cancelled')).toBe(true);
    expect(errors).toEqual([]);
  });

  it('settles an ask_user question answered in the session with the answer its result carries', async () => {
    const { session, requested, settled } = await sessionCalling(
      'ask_user',
      { question: 'Which branch?' },
      { ask_user: askUserTool },
      { allowed: true },
    );

    void session.sendMessage({ content: 'Fix it' });
    expect(await until(() => requested.length > 0 && !session.run.isRunning())).toBe(true);
    const claim = session.claimToolSuspension('call-1');
    if (!claim.accepted) throw new Error(claim.reason);
    await session.respondToToolSuspension({ address: claim.address, resumeData: 'main' });
    session.releaseToolResponse(claim.claimKey);

    expect(await until(() => settled.some(s => s.settlement.status === 'resolved'))).toBe(true);
    // Settled once, with its answer: not first as dropped when the snapshot let it go.
    expect(settled).toEqual([
      {
        callId: 'call-1',
        settlement: { status: 'resolved', response: { kind: 'question', answer: expect.stringContaining('main') } },
      },
    ]);
  });
});

/** A session that publishes the snapshots and events given to it, as a controller would. */
function scriptedSession() {
  const listeners = new Set<(event: never) => void>();
  return {
    identity: { getId: () => 's1' },
    subscribe: (listener: (event: never) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    emit: (event: Record<string, unknown>) => listeners.forEach(listener => listener(event as never)),
  };
}

const question = { toolName: 'ask_user', suspendPayload: { question: 'Which branch?' } };
const snapshot = (suspensions: Record<string, unknown>, approvals: Record<string, unknown> = {}) => ({
  type: 'display_state_changed',
  displayState: { pendingSuspensions: suspensions, pendingApprovals: approvals },
});

describe('observeMastraCodeInteractions, as calls leave and come back', () => {
  function watch() {
    const session = scriptedSession();
    const events: string[] = [];
    observeMastraCodeInteractions(
      session,
      {
        requested: interaction => events.push(`requested ${interaction.id}`),
        left: callId => events.push(`left ${callId}`),
        settled: (callId, settlement) => {
          const settled = settlement({ kind: 'tool_approval', toolName: 'x', input: {} });
          events.push(`settled ${callId} ${settled.status}`);
        },
      },
      { graceMs: 20 },
    );
    return { session, events };
  }

  it('reports a call waiting again when a failed resume puts it back, without settling it', () => {
    const { session, events } = watch();
    session.emit(snapshot({ 'call-1': question }));
    session.emit(snapshot({}));
    session.emit(snapshot({ 'call-1': question }));

    expect(events).toEqual(['requested question:call-1', 'left call-1', 'requested question:call-1']);
  });

  it('settles a call whose kind changed, and asks again', () => {
    const { session, events } = watch();
    session.emit(snapshot({}, { 'call-1': { toolName: 'ask_user', args: {} } }));
    session.emit(snapshot({ 'call-1': question }));

    expect(events).toEqual(['requested tool_approval:call-1', 'settled call-1 cancelled', 'requested question:call-1']);
  });

  it('settles a gate that let its call through as approved, and a paused call as gone, after the grace window', async () => {
    const { session, events } = watch();
    session.emit(snapshot({ 'call-2': question }, { 'call-1': { toolName: 'ship', args: {} } }));
    session.emit(snapshot({}));

    await vi.waitFor(() => expect(events).toHaveLength(6));
    expect(events.slice(2).sort()).toEqual([
      'left call-1',
      'left call-2',
      'settled call-1 resolved',
      'settled call-2 cancelled',
    ]);
  });

  it('settles a call it let go of when the session switches threads', () => {
    const { session, events } = watch();
    session.emit(snapshot({ 'call-1': question }));
    session.emit(snapshot({}));
    session.emit({ type: 'thread_changed', threadId: 't2', previousThreadId: 't1' });

    expect(events).toEqual(['requested question:call-1', 'left call-1', 'settled call-1 cancelled']);
  });
});
