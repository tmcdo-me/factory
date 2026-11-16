import type { Readable, Writable } from 'node:stream';

import type { MastraSandbox } from '@mastra/core/workspace';

export type SandboxKind = 'local' | 'sprite';

/**
 * The place a session works. Runtimes never assume the checkout is on the Factory host: they work
 * through `sandbox` (command/file API) or launch processes inside it with `spawn`.
 */
export interface SessionWorkspace {
  kind: SandboxKind;
  /** Repository checkout path inside the sandbox. */
  checkoutDir: string;
  /** Command and file API for runtimes that drive the sandbox directly (Mastra Code). */
  sandbox: MastraSandbox;
  /**
   * Environment for processes in the sandbox: git credentials (`GH_TOKEN*`, credential helper) and
   * other sandbox-scoped values. Never contains Factory server secrets.
   */
  env(): Promise<Record<string, string>>;
  /** Start a long-lived process with stdio inside the sandbox. */
  spawn(command: string, args: string[], options: SpawnInSandboxOptions): SandboxProcess;
}

export interface SpawnInSandboxOptions {
  cwd: string;
  env: Record<string, string>;
  signal?: AbortSignal;
}

/** Mirrors the Claude Agent SDK's `SpawnedProcess`, so an adapter can return it unchanged. */
export interface SandboxProcess {
  stdin: Writable;
  stdout: Readable;
  stderr?: Readable;
  readonly killed: boolean;
  readonly exitCode: number | null;
  kill(signal: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
  off(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  off(event: 'error', listener: (error: Error) => void): void;
}
