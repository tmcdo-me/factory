// fork(claude-agent): slice 7k. What Factory's workspace resolver needs from the runtime that supplies the agent's
// workspace pieces, owned by Factory and passed into `createWorkspaceFactory`. `@factory/runtime-mastra-code`
// implements it (`mastraCodeWorkspaceBuilders`) and checks the types at compile time.
import type { Mastra } from '@mastra/core/mastra';
import type { RequestContext } from '@mastra/core/request-context';
import type { SkillSource, WorkspaceFilesystem, WorkspaceToolsConfig } from '@mastra/core/workspace';

/** What a sandbox must offer to back a filesystem: its id and a command runner. */
export interface RuntimeSandboxExec {
  readonly id: string;
  readonly filesystem?: WorkspaceFilesystem;
  executeCommand(
    command: string,
    args?: string[],
    options?: { timeout?: number; maxRetainedBytes?: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/** Skill roots a workspace adds to the project's own, and how they are read. */
export interface RuntimeSkillExtension {
  /** Distinguishes extended workspaces from the default resolver cache. */
  id: string;
  /** Additional read-only skill roots prepended to normal project/global skill roots. */
  paths: string[];
  /** Compose the additional roots with the workspace's normal skill source. */
  createSource: (fallback: SkillSource, fallbackSkillRoots: string[]) => SkillSource;
}

/** The context a workspace resolver is called with: the turn's request context and Mastra instance. */
export interface RuntimeWorkspaceContext {
  requestContext: RequestContext;
  mastra?: Mastra;
  skillExtension?: RuntimeSkillExtension;
}

/**
 * The live session of a turn as the workspace resolver uses it: its coordinates, and the project path and
 * instruction roots it records in the session's state once the checkout is known.
 */
export interface RuntimeWorkspaceSession {
  sessionId?: string;
  threadId?: string | null;
  getState(): Readonly<{ projectPath?: string; instructionRoots?: string[] }> | undefined;
  setState(updates: { projectPath?: string; projectName?: string; instructionRoots?: string[] }): Promise<void>;
}

/** The runtime's pieces of an agent workspace. */
export interface RuntimeWorkspaceBuilders {
  /** The agent's filesystem over a session's sandbox; `workdir` may resolve lazily (a remote sandbox's root). */
  createSandboxFilesystem(options: {
    id: string;
    sandbox: RuntimeSandboxExec;
    workdir: string | (() => Promise<string> | string);
  }): WorkspaceFilesystem;
  /** The workspace tools the agent gets, with plans written under `plansDir`. */
  workspaceTools(plansDir: string): WorkspaceToolsConfig;
  /** The runtime's per-project config directory, whose `skills` folder holds project skills. */
  readonly configDir: string;
}
