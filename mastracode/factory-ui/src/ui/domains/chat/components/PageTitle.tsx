import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useParams } from 'react-router';

import { queryKeys } from '../../../../api/keys';
import { useDocumentTitle } from '../../../../hooks/useDocumentTitle';
import { useRouteSessionId } from '../../../../hooks/useRouteSessionId';
import { setCachedSessionTitle, useUserSessionQuery } from '../../../../hooks/useWorkspaces';
import { useSessionCard } from '../../factory/hooks/useSessionCard';
import { useSessionRepository } from '../../factory/hooks/useSessionRepository';
import { workItemReference } from '../../factory/services/relationships';
import { useChatTranscript } from '../context/useChatTranscript';

/** Tab title for the open session: its card's reference (`PR #1567`, `ENG-123`), else the session's title. */
export function PageTitle() {
  const { factoryId } = useParams<{ factoryId?: string }>();
  const routeSessionId = useRouteSessionId();
  const { item } = useSessionCard();
  const { repository } = useSessionRepository();
  // fork(claude-agent): a session is one conversation, so its title is the session's own, which the
  // server writes when the agent names the conversation.
  const sessionTitle = useUserSessionQuery(routeSessionId).data?.title?.trim();
  const namedTitle = useShowNameGivenWhileOpen(factoryId, routeSessionId);
  useRefreshSessionAfterRun(factoryId, routeSessionId);

  const reference = item && workItemReference(item, repository?.slug);
  useDocumentTitle(reference ?? (namedTitle || sessionTitle || undefined));
  return null;
}

/** The name the session was given while open (its rename event), shown in the header and sidebar too. */
function useShowNameGivenWhileOpen(factoryId: string | undefined, sessionId: string | undefined) {
  const queryClient = useQueryClient();
  const title = useChatTranscript().transcript.title;
  useEffect(() => {
    if (title && sessionId) setCachedSessionTitle(queryClient, factoryId, sessionId, title);
  }, [factoryId, queryClient, sessionId, title]);
  return title;
}

/** A run can name its session; read the session again once the run ends so the new title shows. */
function useRefreshSessionAfterRun(factoryId: string | undefined, sessionId: string | undefined) {
  const queryClient = useQueryClient();
  const { busy } = useChatTranscript();
  const wasBusy = useRef(busy);
  useEffect(() => {
    const ended = wasBusy.current && !busy;
    wasBusy.current = busy;
    if (!ended || !sessionId) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.userSession(sessionId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.sessions(factoryId) });
  }, [busy, factoryId, queryClient, sessionId]);
}
