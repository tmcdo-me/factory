// fork(claude-agent): which agent runtime each session runs on, and each project's default.
import { FactoryStorageDomain, UniqueViolationError } from '@mastra/core/storage';
import type { CollectionSchema } from '@mastra/core/storage';

const SESSIONS = 'factory_agent_sessions';
const DEFAULTS = 'factory_agent_runtime_defaults';
const SETTINGS = 'factory_agent_runtime_settings';

export const AGENT_SESSIONS_SCHEMA: CollectionSchema = {
  name: SESSIONS,
  columns: {
    session_id: { type: 'text', primaryKey: true },
    runtime_id: { type: 'text' },
    model_id: { type: 'text', nullable: true },
    runtime_state: { type: 'json', nullable: true },
    created_at: { type: 'timestamp' },
    updated_at: { type: 'timestamp' },
  },
};

export const AGENT_RUNTIME_DEFAULTS_SCHEMA: CollectionSchema = {
  name: DEFAULTS,
  columns: {
    id: { type: 'uuid-pk' },
    org_id: { type: 'text' },
    project_id: { type: 'text' },
    runtime_id: { type: 'text' },
    updated_at: { type: 'timestamp' },
  },
  uniqueIndexes: [{ name: 'factory_agent_runtime_defaults_project_key', columns: ['org_id', 'project_id'] }],
};

/** Deployment-wide runtime settings (the Claude Agent concurrency cap), one value per key. */
export const AGENT_RUNTIME_SETTINGS_SCHEMA: CollectionSchema = {
  name: SETTINGS,
  columns: {
    id: { type: 'uuid-pk' },
    key: { type: 'text' },
    value: { type: 'json', nullable: true },
    updated_at: { type: 'timestamp' },
  },
  uniqueIndexes: [{ name: 'factory_agent_runtime_settings_key', columns: ['key'] }],
};

export interface AgentSessionRecord {
  sessionId: string;
  runtimeId: string;
  modelId?: string;
  /** Adapter-private resume state (e.g. the Claude Code session id). */
  runtimeState?: unknown;
  createdAt: Date;
  updatedAt: Date;
}

interface SessionRow extends Record<string, unknown> {
  session_id: string;
  runtime_id: string;
  model_id: string | null;
  runtime_state: unknown;
  created_at: Date;
  updated_at: Date;
}

interface SettingRow extends Record<string, unknown> {
  id: string;
  key: string;
  value: unknown;
  updated_at: Date;
}

interface DefaultRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  project_id: string;
  runtime_id: string;
  updated_at: Date;
}

const toRecord = (row: SessionRow): AgentSessionRecord => ({
  sessionId: row.session_id,
  runtimeId: row.runtime_id,
  ...(row.model_id ? { modelId: row.model_id } : {}),
  ...(row.runtime_state != null ? { runtimeState: row.runtime_state } : {}),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Sessions without a record run on the deployment's default runtime (Mastra Code). */
export class AgentSessionsStorage extends FactoryStorageDomain {
  constructor() {
    super('agent-sessions');
  }

  async init(): Promise<void> {
    await this.ensureCollections([AGENT_SESSIONS_SCHEMA, AGENT_RUNTIME_DEFAULTS_SCHEMA, AGENT_RUNTIME_SETTINGS_SCHEMA]);
  }

  async dangerouslyClearAll(): Promise<void> {
    await this.ops.deleteMany(SESSIONS, {});
    await this.ops.deleteMany(DEFAULTS, {});
    await this.ops.deleteMany(SETTINGS, {});
  }

  async get(sessionId: string): Promise<AgentSessionRecord | undefined> {
    const row = await this.ops.findOne<SessionRow>(SESSIONS, { session_id: sessionId });
    return row ? toRecord(row) : undefined;
  }

  /** Choose a session's runtime. Refused (returns false) once it has a different one. */
  async assign(sessionId: string, runtimeId: string, modelId?: string): Promise<boolean> {
    const now = new Date();
    try {
      await this.ops.insertOne<SessionRow>(SESSIONS, {
        session_id: sessionId,
        runtime_id: runtimeId,
        model_id: modelId ?? null,
        runtime_state: null,
        created_at: now,
        updated_at: now,
      });
      return true;
    } catch (error) {
      if (!(error instanceof UniqueViolationError)) throw error;
      const existing = await this.get(sessionId);
      if (existing?.runtimeId !== runtimeId) return false;
      if (modelId && existing.modelId !== modelId) await this.setModel(sessionId, modelId);
      return true;
    }
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.ops.updateMany(SESSIONS, { session_id: sessionId }, { model_id: modelId, updated_at: new Date() });
  }

  async setRuntimeState(sessionId: string, runtimeState: unknown): Promise<void> {
    await this.ops.updateMany(
      SESSIONS,
      { session_id: sessionId },
      { runtime_state: runtimeState, updated_at: new Date() },
    );
  }

  async getProjectDefault(scope: { orgId: string; projectId: string }): Promise<string | undefined> {
    const row = await this.ops.findOne<DefaultRow>(DEFAULTS, { org_id: scope.orgId, project_id: scope.projectId });
    return row?.runtime_id;
  }

  async setProjectDefault(scope: { orgId: string; projectId: string }, runtimeId: string): Promise<void> {
    await this.ops.upsertOne<DefaultRow>(DEFAULTS, ['org_id', 'project_id'], {
      org_id: scope.orgId,
      project_id: scope.projectId,
      runtime_id: runtimeId,
      updated_at: new Date(),
    });
  }

  /** A deployment-wide runtime setting, or `undefined` when it was never set. */
  async getSetting<T = unknown>(key: string): Promise<T | undefined> {
    const row = await this.ops.findOne<SettingRow>(SETTINGS, { key });
    return row?.value == null ? undefined : (row.value as T);
  }

  /** Set a deployment-wide runtime setting; `null` clears it (back to the default). */
  async setSetting(key: string, value: unknown): Promise<void> {
    await this.ops.upsertOne<SettingRow>(SETTINGS, ['key'], { key, value, updated_at: new Date() });
  }

  /** fork(claude-agent): read, change and write one setting atomically; resolves with what was written. */
  async updateSetting<T = unknown>(key: string, change: (current: T | undefined) => T): Promise<T> {
    try {
      const value = change(undefined);
      await this.ops.insertOne<SettingRow>(SETTINGS, { key, value, updated_at: new Date() });
      return value;
    } catch (error) {
      if (!(error instanceof UniqueViolationError)) throw error;
    }
    let written: T | undefined;
    await this.ops.updateAtomic<SettingRow>(SETTINGS, { key }, current => {
      written = change((current.value ?? undefined) as T | undefined);
      return { value: written, updated_at: new Date() };
    });
    return written as T;
  }
}
