import { ComposerStatus } from '@mastra/playground-ui/components/Composer';
import type { ReactNode } from 'react';

import { CLAUDE_AGENT_RUNTIME } from '../../services/factoryRuntimes';
import { useChatRuntime as useAgentRuntime } from '../RuntimePicker';
import { ConnectionActivity } from './ConnectionActivity';
import { ContextWindowStatus } from './ContextWindowStatus';
import { GoalStatus } from './GoalStatus';
import { OperationalMemoryStatus } from './OperationalMemoryStatus';
import { QueuedFollowUps } from './QueuedFollowUps';
import { RuntimeActivity } from './RuntimeActivity';

/**
 * Session status row above the composer, right-aligned and hidden when empty. Pure
 * composition root: each child reads its own slice of the existing chat/session context.
 * The model picker lives in the composer actions instead.
 */
export function StatusLine({ children }: { children?: ReactNode }) {
  // fork(claude-agent): Claude Code manages its own context, so Mastra's observational-memory
  // budgets mean nothing there; every runtime gets the context meter.
  const { runtimeId } = useAgentRuntime();
  return (
    <ComposerStatus aria-label="Session status line">
      {children}
      <ContextWindowStatus />
      {runtimeId !== CLAUDE_AGENT_RUNTIME && <OperationalMemoryStatus />}
      <RuntimeActivity />
      <ConnectionActivity />
      <QueuedFollowUps />
      <GoalStatus />
    </ComposerStatus>
  );
}
