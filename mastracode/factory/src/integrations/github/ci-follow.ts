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
  return {
    maxAttempts: ciAutoFixMaxAttempts(env),
    mode: async project => {
      const value = await store.getSetting<unknown>(modeKey(project)).catch(() => undefined);
      return CI_FOLLOW_MODES.includes(value as CiFollowMode) ? (value as CiFollowMode) : DEFAULT_CI_FOLLOW_MODE;
    },
    setMode: (project, mode) => store.setSetting(modeKey(project), mode),
    attempts: async key => {
      const value = (await store.getSetting<{ attempts?: unknown; signatures?: unknown }>(attemptsKey(key)).catch(
        () => undefined,
      )) ?? { attempts: 0, signatures: [] };
      return {
        attempts: typeof value.attempts === 'number' ? value.attempts : 0,
        signatures: Array.isArray(value.signatures) ? value.signatures.filter(s => typeof s === 'string') : [],
      };
    },
    recordAttempt: async (key, signature) => {
      const value = (await store.getSetting<{ attempts?: number; signatures?: string[] }>(attemptsKey(key))) ?? {};
      const signatures = [...(value.signatures ?? []), ...(signature ? [signature] : [])].slice(-KEPT_SIGNATURES);
      await store.setSetting(attemptsKey(key), { attempts: (value.attempts ?? 0) + 1, signatures });
    },
  };
}
