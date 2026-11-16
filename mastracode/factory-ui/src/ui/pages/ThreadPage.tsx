import { Button } from '@mastra/playground-ui/components/Button';
import { EmptyState } from '@mastra/playground-ui/components/EmptyState';
import { cn } from '@mastra/playground-ui/utils/cn';
import type { ReactNode } from 'react';
import { useRef } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router';

import { ChatPageLayout } from '../domains/chat/components/ChatPageLayout';
import { EmptyThreadState } from '../domains/chat/components/EmptyThreadState';
import { PageTitle } from '../domains/chat/components/PageTitle';
import { SessionChatSurface } from '../domains/chat/components/SessionChatSurface';
import { ThreadRailLayer } from '../domains/chat/components/ThreadRailLayer';
import { TeammateSessionLine } from '../domains/chat/components/TeammateSessionLine';
import { ChatSessionBoundary } from '../domains/chat/context/ChatSessionProvider';
import { useChatTranscript } from '../domains/chat/context/useChatTranscript';
import { useGlobalShortcuts } from '../domains/chat/hooks/useGlobalShortcuts';
import { DraftSessionCreateError, isSessionNotFound } from '../domains/workspaces/services/user-sessions';
import { useHandoffPrompt } from '../domains/chat/hooks/useHandoffPrompt';
import { failedDraftState } from '../domains/chat/services/handoffFiles';
import { FactorySessionPage } from '../domains/factory/components/RelatedFactorySessions';
import { SessionPanelOverview } from '../domains/factory/components/SessionPanelOverview';
import { SessionPanelSubject } from '../domains/factory/components/SessionPanelSubject';
import type { WorkspacePanelPage } from '../domains/workspace-viewer/context/WorkspacePanelContext';
import { WorkspaceFilesProvider } from '../domains/workspace-viewer/context/WorkspaceFilesProvider';
import { useThreadWorkspacePath } from '../domains/workspace-viewer/hooks/useThreadWorkspacePath';
import { useWiderThan } from '../domains/workspace-viewer/hooks/useWiderThan';
import { chatColumnClass, RAIL_MIN_REM } from '../domains/workspace-viewer/layout';
import { useInvalidateWorkspaceChangesOnRunCompletion } from '../domains/workspace-viewer/useInvalidateWorkspaceChangesOnRunCompletion';
import { useRefreshWorkspaceFilesOnToolCalls } from '../domains/workspace-viewer/useRefreshWorkspaceFilesOnToolCalls';
import { newUserSessionPath } from '../domains/workspaces/services/factoryPaths';

import '../domains/chat/components/chat-enter.css';
import { IconBubbleCrossed } from '@mastra/playground-ui/icons/central/IconBubbleCrossed';

const threadShellClass = cn(chatColumnClass, '[--chat-gutter:0.25rem]');

const SESSION_PANEL: WorkspacePanelPage = {
  subject: lead => <SessionPanelSubject lead={lead} />,
  overview: workspace => <SessionPanelOverview workspace={workspace} />,
};

export function ThreadPage() {
  const { factoryId, sessionId, threadId } = useParams<{ factoryId: string; sessionId?: string; threadId?: string }>();
  const { search, state } = useLocation();
  const workspace = useThreadWorkspacePath();

  // fork(claude-agent): a session is one conversation, its own thread. A link to another of its threads
  // (from before multi-thread sessions were dropped) opens the session, so nothing is sent to a thread
  // it isn't on. A chat-only Slack session (`channel`, named by `?sessionId=`) keeps its thread link.
  if (factoryId && sessionId && sessionId !== 'channel' && threadId && threadId !== sessionId) {
    return (
      <Navigate
        replace
        state={state}
        to={`/factories/${factoryId}/workspaces/${encodeURIComponent(sessionId)}/threads/${encodeURIComponent(sessionId)}${search}`}
      />
    );
  }

  if (workspace.error instanceof DraftSessionCreateError) {
    return (
      <Navigate
        replace
        to={workspace.error.draftPath}
        state={failedDraftState(workspace.error.draft, workspace.error.message)}
      />
    );
  }

  if (workspace.error && isSessionNotFound(workspace.error)) return <SessionNotFoundMain factoryId={factoryId} />;

  return (
    <ChatSessionBoundary threadId={threadId}>
      <PageTitle />
      <WorkspaceFilesProvider page={SESSION_PANEL}>
        <ThreadPageMain workspacePath={workspace.workspacePath} threadId={workspace.threadId} />
      </WorkspaceFilesProvider>
    </ChatSessionBoundary>
  );
}

function SessionNotFoundMain({ factoryId }: { factoryId: string | undefined }) {
  const navigate = useNavigate();
  return (
    <ChatPageLayout>
      <div className="grid min-h-0 place-items-center">
        <EmptyState
          as="h1"
          iconSlot={<IconBubbleCrossed />}
          titleSlot="Session not found"
          descriptionSlot="This session does not exist, or it is private to another user."
          actionSlot={
            factoryId && (
              <Button variant="primary" onClick={() => void navigate(newUserSessionPath(factoryId))}>
                Start a new session
              </Button>
            )
          }
        />
      </div>
    </ChatPageLayout>
  );
}

function ThreadPageMain({
  workspacePath,
  threadId,
}: {
  workspacePath: string | undefined;
  threadId: string | undefined;
}) {
  return (
    <ThreadSessionEffects workspacePath={workspacePath}>
      <FactorySessionPage>
        <SessionChatSurface
          emptyState={<EmptyThreadState />}
          composerLabel="Thread composer"
          composerStatus={<TeammateSessionLine />}
          className={threadShellClass}
          contentOverlay={<ThreadRailSlot />}
        />
      </FactorySessionPage>
    </ThreadSessionEffects>
  );
}

function ThreadRailSlot() {
  const boxRef = useRef<HTMLDivElement>(null);
  const { wider: railFits } = useWiderThan(boxRef, RAIL_MIN_REM);

  return (
    <div ref={boxRef} className="pointer-events-none absolute inset-0">
      {railFits && <ThreadRailLayer />}
    </div>
  );
}

function ThreadSessionEffects({ workspacePath, children }: { workspacePath: string | undefined; children: ReactNode }) {
  useGlobalShortcuts();
  useHandoffPrompt();
  const { busy, transcript } = useChatTranscript();
  useInvalidateWorkspaceChangesOnRunCompletion(workspacePath, busy);
  useRefreshWorkspaceFilesOnToolCalls(workspacePath, transcript.entries);
  return children;
}
