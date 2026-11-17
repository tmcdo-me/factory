// fork(claude-agent)
import type { InteractionRecord } from '@factory/agent-runtime';
import { describe, expect, it } from 'vitest';

import type { FactoryApprovalRequest } from '../tools/reports.js';
import { SessionReportWindows, createWaitingNotices } from './waiting-notices.js';

const held = (overrides: Partial<InteractionRecord>): InteractionRecord => ({
  id: 'plan_approval:call-plan',
  sessionId: 's1',
  callId: 'call-plan',
  heldBy: 'mastra-code',
  request: { kind: 'plan_approval', planPath: '.artifacts/plans/a.md' },
  requestedAt: '2030-01-01T00:00:30.000Z',
  status: 'pending',
  ...overrides,
});

function notices(answersItself: (toolCallId: string) => boolean = () => false) {
  const reports: Array<{ threadId: string | null; since: Date; outcome: unknown }> = [];
  const approvals: FactoryApprovalRequest[] = [];
  const windows = new SessionReportWindows();
  const announce = createWaitingNotices({
    reportRunEnd: async ({ threadId, since, outcome }) => void reports.push({ threadId, since, outcome }),
    notifyApproval: async request => void approvals.push(request),
    windows,
    answersItself,
  });
  return { announce, reports, approvals, windows };
}

describe('createWaitingNotices', () => {
  // The run's end moves its window before the broker has kept the call it parked on.
  it("judges a Mastra Code call on the run window it started waiting in, though that run's end came first", async () => {
    const { announce, reports, windows } = notices();
    const open = windows.watch('s1', () => 'thread-7');
    open(new Date('2030-01-01T00:00:00.000Z'));
    open(new Date('2030-01-01T00:01:00.001Z'));

    await announce(held({}));

    expect(reports).toEqual([
      {
        threadId: 'thread-7',
        since: new Date('2030-01-01T00:00:00.000Z'),
        outcome: { status: 'blocked', toolName: 'submit_plan', toolCallId: 'call-plan', decision: true },
      },
    ]);
  });

  it('tells of a gate as an approval, quoting its call, and of nothing the board answers itself', async () => {
    const { announce, reports, approvals } = notices(toolCallId => toolCallId === 'call-plan');

    await announce(
      held({
        id: 'tool_approval:call-ship',
        callId: 'call-ship',
        request: { kind: 'tool_approval', toolName: 'ship_release', input: { version: '1.2.0' }, gate: true },
      }),
    );
    await announce(held({}));

    expect(approvals).toEqual([
      {
        sessionId: 's1',
        threadId: 's1',
        toolName: 'ship_release',
        toolCallId: 'call-ship',
        args: { version: '1.2.0' },
      },
    ]);
    expect(reports).toEqual([]);
  });

  it("tells of a Claude Agent session's wait from the moment it asked, as before", async () => {
    const { announce, reports } = notices(() => true);

    await announce(held({ id: 'int-1', heldBy: undefined, callId: 'toolu_plan' }));

    expect(reports).toEqual([
      {
        threadId: 's1',
        since: new Date('2030-01-01T00:00:30.000Z'),
        outcome: { status: 'blocked', toolName: 'submit_plan', toolCallId: 'toolu_plan', decision: true },
      },
    ]);
  });
});
