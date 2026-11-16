import { ComposerStatus } from '@mastra/playground-ui/components/Composer';
import type { ReactNode } from 'react';

import { ConnectionActivity } from './ConnectionActivity';
import { ContextWindowStatus } from './ContextWindowStatus';
import { QueuedFollowUps } from './QueuedFollowUps';
import { RuntimeActivity } from './RuntimeActivity';

/**
 * Session status row above the composer, right-aligned and hidden when empty. Pure
 * composition root: each child reads its own slice of the existing chat/session context.
 * The model picker lives in the composer actions instead.
 */
export function StatusLine({ children }: { children?: ReactNode }) {
  // fork(claude-agent): every runtime gets the context meter; Mastra's observational-memory
  // budgets and the goal indicator are gone with their UI.
  return (
    <ComposerStatus aria-label="Session status line">
      {children}
      <ContextWindowStatus />
      <RuntimeActivity />
      <ConnectionActivity />
      <QueuedFollowUps />
    </ComposerStatus>
  );
}
