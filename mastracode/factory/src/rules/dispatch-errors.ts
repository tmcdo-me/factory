import type {
  FactoryDispatchFailureCode,
  StoredFactoryDispatchFailureCode,
} from '../storage/domains/work-items/base.js';

interface FactoryDispatchFailureMetadata {
  /** A person may retry the failed decision. */
  canRetry: boolean;
  /** `false` when only a person's retry can succeed: the dispatcher does not try again on its own. */
  autoRetry?: false;
  label: string;
}

const FAILURE_METADATA = {
  session_unavailable: { canRetry: true, label: 'Factory session unavailable' },
  source_control_missing: { canRetry: true, label: 'Source-control connection unavailable' },
  source_repository_missing: { canRetry: true, label: 'Source repository unavailable' },
  source_repository_ambiguous: { canRetry: true, label: 'Choose a repository for this work item' },
  unsupported_provider_item: { canRetry: false, label: 'Unsupported provider work item' },
  notification_delivery_failed: { canRetry: true, label: 'Factory message delivery failed' },
  run_terminal_event_missing: { canRetry: false, label: 'Agent run terminal event was not observed' },
  run_incomplete: { canRetry: true, label: 'Agent run ended before completing the working phase' },
  skill_delivery_ambiguous: { canRetry: false, label: 'Factory skill delivery could not be confirmed' },
  run_overdue: { canRetry: false, label: 'Agent run is overdue' },
  repository_git_missing: { canRetry: false, label: 'Git is unavailable in the workspace' },
  repository_sandbox_unresponsive: { canRetry: true, label: 'Workspace sandbox stopped responding' },
  repository_egress_blocked: { canRetry: false, label: 'Repository network access is blocked' },
  repository_clone_failed: { canRetry: true, label: 'Repository clone failed' },
  repository_pull_failed: { canRetry: true, label: 'Repository update failed' },
  repository_push_failed: { canRetry: true, label: 'Repository push failed' },
  repository_commit_failed: { canRetry: true, label: 'Repository commit failed' },
  repository_cli_missing: { canRetry: false, label: 'GitHub CLI is unavailable in the workspace' },
  repository_pr_failed: { canRetry: true, label: 'Pull request creation failed' },
  run_configuration_invalid: { canRetry: false, label: 'Run configuration rejected by provider' },
  run_credentials_unavailable: { canRetry: true, label: 'Model credentials unavailable for the run' },
  // The run's request carries no user, so every retry fails the same way; a person has to start it.
  run_user_unauthenticated: { canRetry: false, label: 'Run started without an authenticated user' },
  // Automatic work runs as the Factory, on the organization's keys only. Trying again cannot add one,
  // so the dispatcher stops at once; a person retries after adding the key.
  factory_org_key_missing: {
    canRetry: true,
    autoRetry: false,
    label: 'Add an organization model key to run this automatically',
  },
  run_failed: { canRetry: true, label: 'Agent run ended in error' },
  unknown: { canRetry: true, label: 'Factory automation failed' },
  // Retired: no path writes these any more, stored rows still read through here.
  plan_awaiting_approval: { canRetry: false, label: 'Plan waiting for review' },
  run_awaiting_input: { canRetry: false, label: 'Agent is waiting for an answer' },
} satisfies Record<StoredFactoryDispatchFailureCode, FactoryDispatchFailureMetadata>;

export class FactoryDispatchError extends Error {
  constructor(
    readonly code: FactoryDispatchFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'FactoryDispatchError';
  }
}

export function factoryDispatchFailureCode(error: unknown): FactoryDispatchFailureCode {
  return error instanceof FactoryDispatchError ? error.code : 'unknown';
}

export function factoryDispatchFailureMetadata(
  code: StoredFactoryDispatchFailureCode | null,
): FactoryDispatchFailureMetadata {
  return code === null ? FAILURE_METADATA.unknown : FAILURE_METADATA[code];
}

export const MAX_ERROR_LENGTH = 512;

// Provider and source-control key prefixes; run errors carry provider text verbatim.
const KEY_SHAPED_TOKEN =
  /\b(?:sk-[A-Za-z0-9_-]{3,}|gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|xox[abprs]-[A-Za-z0-9-]{10,})/g;

// Mixed-case alphanumeric runs read as keys; lowercase hex SHAs, UUIDs, path segments and
// hyphenated names such as branches stay readable.
function looksLikeSecret(token: string): boolean {
  return /[A-Z]/.test(token) && /[a-z]/.test(token) && /\d/.test(token) && /[A-Za-z0-9]{16,}/.test(token);
}

// Base64 keys can contain `/`. A `/`-joined token is redacted whole unless one of its pieces is a
// plain word, which paths and branches nearly always have (`fix`, `cache`, `Users`, `Documents`);
// those are redacted piece by piece instead.
function redactSecretRun(token: string): string {
  if (looksLikeSecret(token) && !token.split('/').some(piece => /^[A-Za-z][a-z]+$/.test(piece))) return '[redacted]';
  return token.replace(/[A-Za-z0-9_+=-]{24,}/g, piece =>
    looksLikeSecret(piece) || isGroupedKey(piece) ? '[redacted]' : piece,
  );
}

// Keys printed in `-`/`_` groups (`x7Kp9-Qm2Rt-…`) have no long unbroken run, but every group mixes
// upper, lower and digits; branch and identifier words such as `Parked-snapshot-lease2-loss` do not.
function isGroupedKey(token: string): boolean {
  const groups = token.split(/[-_]/);
  return groups.length >= 4 && groups.every(group => /[A-Z]/.test(group) && /[a-z]/.test(group) && /\d/.test(group));
}

export function sanitizeDispatchError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message
      .replace(KEY_SHAPED_TOKEN, '[redacted]')
      .replace(/\b[A-Za-z0-9_+=/-]{24,}/g, redactSecretRun)
      // `Authorization: Bearer <value>` names the scheme first; consume it so the value goes too.
      .replace(/\b(?:bearer|token|api[-_ ]?key|authorization)\s*[:=]?\s*(?:bearer\s+)?[^\s,;]+/gi, '[redacted]')
      .slice(0, MAX_ERROR_LENGTH)
  );
}
