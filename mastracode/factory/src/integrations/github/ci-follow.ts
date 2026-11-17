// fork(claude-agent): each project's setting for following its pull requests' CI and reviews.
import type { CiFollowAttemptKey, CiFollowSettings } from './rules.js';

export type CiFollowMode = 'off' | 'status' | 'autofix';

export const CI_FOLLOW_MODES = ['off', 'status', 'autofix'] as const;

/** What a project does until it says otherwise: show CI on its cards, send nothing back. */
export const DEFAULT_CI_FOLLOW_MODE: CiFollowMode = 'status';

/** Fix attempts on one pull request before a person decides: `FACTORY_CI_AUTOFIX_MAX_ATTEMPTS`, default 3. */
export function ciAutoFixMaxAttempts(env: Record<string, string | undefined> = process.env): number {
  const raw = env.FACTORY_CI_AUTOFIX_MAX_ATTEMPTS?.trim();
  const value = raw && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isInteger(value) && value > 0 ? Math.min(value, 20) : 3;
}

/** Where the settings and attempts are kept (the agent-sessions domain's runtime settings). */
export interface CiFollowStore {
  getSetting<T = unknown>(key: string): Promise<T | undefined>;
  setSetting(key: string, value: unknown): Promise<void>;
  /** Read, change and write one setting atomically (no other write lands between). */
  updateSetting<T = unknown>(key: string, change: (current: T | undefined) => T): Promise<T>;
}

const modeKey = (project: { orgId: string; factoryProjectId: string }) =>
  `ci-follow:${project.orgId}:${project.factoryProjectId}`;
const attemptsKey = (key: CiFollowAttemptKey) =>
  `ci-autofix:${key.orgId}:${key.factoryProjectId}:${key.repositoryId}:${key.pullRequestNumber}`;

/** How many signatures an attempt record keeps, newest last. */
const KEPT_SIGNATURES = 10;

/** Each project's mode and its pull requests' fix attempts, kept in `store`. */
export function ciFollowSettings(
  store: CiFollowStore,
  env: Record<string, string | undefined> = process.env,
): CiFollowSettings & {
  setMode(project: { orgId: string; factoryProjectId: string }, mode: CiFollowMode): Promise<void>;
} {
  const maxAttempts = ciAutoFixMaxAttempts(env);
  return {
    maxAttempts,
    mode: async project => {
      const value = await store.getSetting<unknown>(modeKey(project)).catch(() => undefined);
      return CI_FOLLOW_MODES.includes(value as CiFollowMode) ? (value as CiFollowMode) : DEFAULT_CI_FOLLOW_MODE;
    },
    setMode: (project, mode) => store.setSetting(modeKey(project), mode),
    attempts: async key => {
      let value: { attempts?: unknown; signatures?: unknown } | undefined;
      try {
        value = await store.getSetting<{ attempts?: unknown; signatures?: unknown }>(attemptsKey(key));
      } catch {
        // Fail closed: a fix waits for a person rather than risk passing the cap.
        return { attempts: 0, signatures: [], unreadable: true };
      }
      return {
        attempts: typeof value?.attempts === 'number' ? value.attempts : 0,
        signatures: Array.isArray(value?.signatures)
          ? value.signatures.filter((entry): entry is string => typeof entry === 'string')
          : [],
      };
    },
    reserveAttempt: async (key, signature) => {
      let reserved = false;
      await store.updateSetting<{ attempts?: number; signatures?: string[] }>(attemptsKey(key), current => {
        const attempts = current?.attempts ?? 0;
        const signatures = current?.signatures ?? [];
        if (attempts >= maxAttempts || (signature !== undefined && signatures.includes(signature))) {
          reserved = false;
          return current ?? { attempts: 0, signatures: [] };
        }
        reserved = true;
        return {
          attempts: attempts + 1,
          signatures: [...signatures, ...(signature ? [signature] : [])].slice(-KEPT_SIGNATURES),
        };
      });
      return { reserved };
    },
    rememberFailure: async (key, signature) => {
      let fresh = false;
      await store.updateSetting<{ attempts?: number; signatures?: string[] }>(attemptsKey(key), current => {
        const signatures = current?.signatures ?? [];
        fresh = !signatures.includes(signature);
        return fresh
          ? { attempts: current?.attempts ?? 0, signatures: [...signatures, signature].slice(-KEPT_SIGNATURES) }
          : (current ?? { attempts: 0, signatures });
      });
      return { fresh };
    },
    forgetFailure: async (key, signature) => {
      await store.updateSetting<{ attempts?: number; signatures?: string[] }>(attemptsKey(key), current => {
        const signatures = [...(current?.signatures ?? [])];
        const at = signatures.lastIndexOf(signature);
        if (at >= 0) signatures.splice(at, 1);
        return { attempts: current?.attempts ?? 0, signatures };
      });
    },
    releaseAttempt: async (key, signature) => {
      await store.updateSetting<{ attempts?: number; signatures?: string[] }>(attemptsKey(key), current => {
        const signatures = [...(current?.signatures ?? [])];
        const at = signature === undefined ? -1 : signatures.lastIndexOf(signature);
        if (at >= 0) signatures.splice(at, 1);
        return { attempts: Math.max(0, (current?.attempts ?? 0) - 1), signatures };
      });
    },
  };
}
