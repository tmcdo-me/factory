// fork(claude-agent): slice 7l. The live session and the controller as Factory's dispatcher, start coordinator,
// session creation and the adapter-side session queries call them, owned by Factory so those files do not name
// Mastra Code's agent controller. `@factory/runtime-mastra-code` checks at compile time that the controller's own
// `Session` and `AgentController` types are assignable to these (`live-session.test.ts`). Method-style members, so
// the controller's narrower parameter types stay assignable (bivariance).
import type { Agent } from '@mastra/core/agent';
import type { AgentChannels } from '@mastra/core/channels';
import type { SendNotificationSignalInput } from '@mastra/core/notifications';
import type { RequestContext } from '@mastra/core/request-context';
import type { Workspace } from '@mastra/core/workspace';

import type {
  RuntimeSessionEvents,
  RuntimeThreadLookup,
  RuntimeSessionState,
  RuntimeSessionStateAccess,
} from './session-surface';

/** What sending a notification or signal to a session reports back. */
export interface RuntimeSignalResult {
  persisted?: Promise<unknown>;
  accepted?: Promise<{
    accepted?: boolean;
    runId?: string;
    action?: string;
    output?: { consumeStream(): Promise<unknown> };
  }>;
}

/** The signal Factory sends a session (a system reminder, a kickoff message). */
export interface RuntimeSignalInput {
  id: string;
  type: 'user' | 'reactive' | 'system-reminder';
  tagName?: string;
  attributes?: Record<string, string>;
  metadata?: Record<string, unknown>;
  contents: string;
}

/** A live session as Factory drives it. */
export interface RuntimeLiveSession<
  State extends Record<string, unknown> = RuntimeSessionState,
> extends RuntimeSessionEvents {
  identity: { getId(): string; getOwnerId(): string; getResourceId(): string };
  thread: {
    getId(): string | null | undefined;
    requireId(): string;
    switch(input: { threadId: string; requestContext?: RequestContext; emitEvent?: boolean }): Promise<unknown>;
    rename(input: { title: string; pin?: boolean }): Promise<unknown>;
    getSetting(input: { key: string }): Promise<unknown>;
    setSetting(input: { key: string; value: unknown }): Promise<void>;
    listActiveMessages(): Promise<Array<{ id: string }>>;
  };
  model: { get(): string | undefined; switch(modelId: string): Promise<unknown> };
  mode: { resolve(): { defaultModelId?: string } };
  permissions: { setForTool(input: { toolName: string; policy: 'allow' | 'ask' | 'deny' }): Promise<unknown> };
  suspensions: { hasPending(): boolean };
  run: { isRunning(): boolean };
  stream: { isActive(): boolean };
  state: RuntimeSessionStateAccess<State>;
  machinery: { getAgent(): Agent };
  subagents: { model: { set(input: { modelId: string; agentType: string }): Promise<unknown> } };
  getWorkspace(): Workspace | undefined;
  abort(): void;
  sendSignal(
    input: RuntimeSignalInput,
    options: { requestContext: RequestContext; requireDelivery?: boolean },
  ): { accepted: Promise<{ accepted?: boolean; runId?: string; action?: string }> };
  sendNotificationSignal(
    input: SendNotificationSignalInput,
    options: {
      requestContext?: RequestContext;
      requireDelivery?: boolean;
      ifActive?: { behavior?: 'deliver' | 'persist' | 'discard' };
      ifIdle?: { behavior?: 'wake' | 'persist' | 'discard' };
      scopes?: string[];
    },
  ): Promise<RuntimeSignalResult>;
}

/** The controller's session registry and run registry, as Factory calls them. */
export interface RuntimeController<Session = RuntimeLiveSession> extends RuntimeThreadLookup {
  createSession(args: {
    id?: string;
    ownerId?: string;
    resourceId?: string;
    threadId?: string;
    tags?: Record<string, string>;
    createInitialThread?: boolean;
    resumeOnly?: boolean;
    workspace?: Workspace;
    requestContext?: RequestContext;
  }): Promise<Session>;
  getChannels?(): AgentChannels | null | undefined;
  getSession(sessionId: string, requestContext?: RequestContext): Promise<Session | undefined>;
  listActiveThreadRuns(): Array<{ threadId: string; resourceId?: string; runId?: string }>;
}
