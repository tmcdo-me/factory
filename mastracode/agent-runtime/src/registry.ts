import type { AgentRuntime } from './runtime';

/** The runtimes this Factory deployment offers. Built once at the composition root. */
export class RuntimeRegistry {
  readonly #runtimes = new Map<string, AgentRuntime>();
  readonly #defaultId: string;

  constructor(runtimes: AgentRuntime[], options: { defaultRuntimeId?: string } = {}) {
    if (runtimes.length === 0) throw new Error('RuntimeRegistry needs at least one runtime');
    for (const runtime of runtimes) {
      if (this.#runtimes.has(runtime.id)) throw new Error(`Duplicate runtime id "${runtime.id}"`);
      this.#runtimes.set(runtime.id, runtime);
    }
    this.#defaultId = options.defaultRuntimeId ?? runtimes[0]!.id;
    if (!this.#runtimes.has(this.#defaultId)) {
      throw new Error(`Default runtime "${this.#defaultId}" is not registered`);
    }
  }

  get defaultRuntimeId(): string {
    return this.#defaultId;
  }

  get(id: string): AgentRuntime | undefined {
    return this.#runtimes.get(id);
  }

  /** The runtime for `id`, or the default when `id` is omitted. Throws for an unknown id. */
  require(id?: string): AgentRuntime {
    const runtime = this.#runtimes.get(id ?? this.#defaultId);
    if (!runtime) {
      throw new Error(`Unknown agent runtime "${id}". Enabled: ${[...this.#runtimes.keys()].join(', ')}`);
    }
    return runtime;
  }

  list(): AgentRuntime[] {
    return [...this.#runtimes.values()];
  }

  async init(): Promise<void> {
    for (const runtime of this.#runtimes.values()) await runtime.init?.();
  }

  async shutdown(): Promise<void> {
    const results = await Promise.allSettled([...this.#runtimes.values()].map(runtime => runtime.shutdown?.()));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
}
