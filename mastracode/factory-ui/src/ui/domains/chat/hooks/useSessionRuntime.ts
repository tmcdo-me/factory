// fork(claude-agent): which agent runtime the chat is on (a draft's choice, or a session's).
import { useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';

import { useApiConfig } from '../../../../api/config';
import {
  CLAUDE_AGENT_RUNTIME,
  MASTRA_CODE_RUNTIME,
  fetchProjectRuntime,
  fetchRuntimeCatalog,
  fetchSessionRuntime,
  runtimeKeys,
} from '../services/factoryRuntimes';
import type { SessionRuntime } from '../services/factoryRuntimes';

export const CLAUDE_AGENT_DEFAULT_MODEL = 'claude-opus-5-5';

/** Draft choices live outside React state so the composer and the draft's create step share them. */
const drafts = new Map<string, SessionRuntime>();
const listeners = new Set<() => void>();
const draftStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get: (draftId: string) => drafts.get(draftId),
  set(draftId: string, runtime: SessionRuntime) {
    drafts.set(draftId, runtime);
    for (const listener of listeners) listener();
  },
};

export function useRuntimeCatalog() {
  const { baseUrl } = useApiConfig();
  return useQuery({ queryKey: runtimeKeys.catalog, queryFn: () => fetchRuntimeCatalog(baseUrl), staleTime: Infinity });
}

export function useProjectRuntime(projectId: string | undefined) {
  const { baseUrl } = useApiConfig();
  return useQuery({
    queryKey: runtimeKeys.project(projectId ?? ''),
    queryFn: () => fetchProjectRuntime(baseUrl, projectId!),
    enabled: Boolean(projectId),
    staleTime: 60_000,
  });
}

export function useSessionRuntimeQuery(sessionId: string | undefined) {
  const { baseUrl } = useApiConfig();
  return useQuery({
    queryKey: runtimeKeys.session(sessionId ?? ''),
    queryFn: () => fetchSessionRuntime(baseUrl, sessionId!),
    enabled: Boolean(sessionId),
    // A session's runtime never changes once chosen.
    staleTime: Infinity,
  });
}

/** A draft's runtime: what the composer picked, else the project's default. */
export function useDraftRuntime(draftId: string | undefined, projectId: string | undefined) {
  const picked = useSyncExternalStore(draftStore.subscribe, () => (draftId ? draftStore.get(draftId) : undefined));
  const projectDefault = useProjectRuntime(projectId).data?.runtimeId;
  const runtimeId = picked?.runtimeId ?? projectDefault ?? MASTRA_CODE_RUNTIME;
  return {
    runtimeId,
    modelId: picked?.modelId ?? (runtimeId === CLAUDE_AGENT_RUNTIME ? CLAUDE_AGENT_DEFAULT_MODEL : undefined),
    setRuntime: (next: SessionRuntime) => {
      if (draftId) draftStore.set(draftId, next);
    },
  };
}

export function draftRuntimeChoice(draftId: string, projectDefault: string | undefined): SessionRuntime {
  const picked = draftStore.get(draftId);
  const runtimeId = picked?.runtimeId ?? projectDefault ?? MASTRA_CODE_RUNTIME;
  return {
    runtimeId,
    ...(picked?.modelId
      ? { modelId: picked.modelId }
      : runtimeId === CLAUDE_AGENT_RUNTIME
        ? { modelId: CLAUDE_AGENT_DEFAULT_MODEL }
        : {}),
  };
}

/**
 * Whether this session is drawn from Factory's own session event log: every session is, unless the
 * server says its conversation began before the log (and until it says, it is).
 */
export function usesFactorySessionApi(runtime: SessionRuntime | undefined): boolean {
  return runtime?.transcript !== 'mastra';
}
