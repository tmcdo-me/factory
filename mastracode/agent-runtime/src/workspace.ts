import type { Readable, Writable } from 'node:stream';

import type { MastraSandbox, WorkspaceFilesystem } from '@mastra/core/workspace';

export type SandboxKind = 'local' | 'sprite';

/**
 * Key of a sandbox's {@link SandboxProcesses}. A `Symbol.for` key, so separate copies of this package
 * in one process agree on it.
 */
export const SANDBOX_PROCESSES: unique symbol = Symbol.for('factory.sandbox.processes');

/** The sandbox's processes capability, when its provider offers one. */
export function sandboxProcessesOf(sandbox: unknown): SandboxProcesses | undefined {
  if (typeof sandbox !== 'object' || sandbox === null || !(SANDBOX_PROCESSES in sandbox)) return undefined;
  return (sandbox as ProcessSandbox)[SANDBOX_PROCESSES];
}

/**
 * The place a session works. Runtimes never assume the checkout is on the Factory host: they work
 * through `sandbox` (command/file API) or launch processes inside it with `spawn`.
 */
export interface SessionWorkspace {
  /**
   * Where the checkout lives. `remote` is a provider whose sandbox runs commands but launches no
   * long-lived processes (Platform, E2B): `spawn` fails there.
   */
  kind: SandboxKind | 'remote';
  /** Repository checkout path inside the sandbox. */
  checkoutDir: string;
  /**
   * Command and file API for runtimes that drive the sandbox directly (Mastra Code). Absent only for
   * a workspace that offers a filesystem and no sandbox, as a Mastra Code agent's can.
   */
  sandbox?: MastraSandbox;
  /**
   * The workspace's filesystem, confined as the session's agent is (what Factory's tools read files
   * through, such as a file shared into a chat thread), when it has one.
   */
  filesystem?: WorkspaceFilesystem;
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

/** Files where a sandbox's processes run: what a runtime writes for its agent (skills, settings). */
export interface SandboxFiles {
  /** Create a directory and its parents. */
  mkdir(path: string): Promise<void>;
  /** Remove a file or directory tree; a missing one is not an error. */
  rm(path: string): Promise<void>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  isDirectory(path: string): Promise<boolean>;
}

/**
 * What a sandbox offers a runtime that launches its own agent process inside it (Claude Agent's
 * `spawnClaudeCodeProcess`): long-lived stdio processes, and files beside them. A sandbox provider
 * that supports this exposes it under {@link SANDBOX_PROCESSES}; see `sandboxProcessesOf`.
 */
export interface SandboxProcesses {
  kind: SandboxKind;
  spawn(command: string, args: string[], options: SpawnInSandboxOptions): SandboxProcess;
  files: SandboxFiles;
}

/** A sandbox (a `MastraSandbox` instance) that carries {@link SandboxProcesses}. */
export interface ProcessSandbox {
  readonly [SANDBOX_PROCESSES]: SandboxProcesses;
}
