import type { EventEnvelope } from '@factory/agent-runtime';
import type { WorkspaceSandbox } from '@mastra/core/workspace';
import { peekSessionSandbox, sessionLayout } from '../sandbox/session-sandbox.js';
import type { SessionLayoutRepository } from '../sandbox/session-sandbox.js';

import type { FilesystemFile, FilesystemStorage } from '../storage/domains/filesystem/base.js';
import type { SourceControlStorageHandle } from '../storage/domains/source-control/base.js';
import { peekSessionEnvironment } from './environment-state-processor.js';
import { isMeaningfulToolName } from './first-exec-capture.js';

/** Exit code of `GIT_CHANGED_FILES_SCRIPT` when the checkout is not there: the repository is skipped, not failed. */
const CHECKOUT_MISSING_EXIT_CODE = 3;
const GIT_CHANGED_FILES_SCRIPT = `
set -e
workdir=$1
base_branch=$2
test -d "$workdir" || exit ${CHECKOUT_MISSING_EXIT_CODE}
base=HEAD
if merge_base=$(git -C "$workdir" merge-base HEAD "origin/$base_branch" 2>/dev/null); then
  base=$merge_base
fi
git -C "$workdir" diff --name-only -z --find-renames --diff-filter=ACMRTUXB "$base"
git -C "$workdir" ls-files --others --exclude-standard -z
`;
const ARTIFACTS_LIST_COMMAND = 'cd "$1" && test -d .artifacts && find .artifacts -type f -print0 || true';
/**
 * Regular files directly under the workspace root written since the session
 * was created ($2 is a UTC `touch -t` stamp, `YYYYMMDDhhmm.SS`), such as the
 * agent's notes. Files the template shipped with predate the session and stay
 * out; the checkouts are covered by git. Dotfiles are never listed: a listed
 * path becomes readable through the thread's file route, and the root is where
 * setup leaves `.env`, `.pgpass`, `.netrc` and other credential files.
 * `touch -t` plus `-newer` works on GNU and BSD find alike; `-newermt
 * "@epoch"` is GNU only.
 */
export const ROOT_FILES_LIST_COMMAND = [
  'cd "$1" && ref=$(mktemp) && TZ=UTC touch -t "$2" "$ref"',
  '&& find . -mindepth 1 -maxdepth 1 -type f ! -name \'.*\' -newer "$ref" -print0',
  '; status=$?; rm -f "$ref"; exit $status',
].join(' ');

/** `touch -t` stamp of a moment, in UTC. */
export function touchStamp(date: Date): string {
  const two = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}` +
    `${two(date.getUTCHours())}${two(date.getUTCMinutes())}.${two(date.getUTCSeconds())}`
  );
}

export interface FilesystemCaptureSession {
  readonly identity: { getId(): string };
  readonly thread: { requireId(): string };
  getWorkspace(): { sandbox?: Pick<WorkspaceSandbox, 'executeCommand'> } | undefined;
}

export interface FilesystemCaptureDependencies {
  filesystem: Pick<FilesystemStorage, 'replaceFiles'>;
  sourceControl: {
    sessions: Pick<SourceControlStorageHandle['sessions'], 'getBySessionId'>;
  };
}

export interface FilesystemObserverDependencies extends FilesystemCaptureDependencies {
  /** fork(claude-agent): slice 7. The session's events are heard on Factory's event hub. */
  events: { listen(sessionId: string, listener: (envelope: EventEnvelope) => void): () => void };
}

export function parseFilesystemCaptureFiles(output: string): FilesystemFile[] {
  const files = new Map<string, FilesystemFile>();
  for (const record of output.split('\0')) {
    if (!record) continue;
    const path = record.replace(/^\.\//, '');
    if (path) files.set(path, { path });
  }

  return [...files.values()].toSorted((a, b) => a.path.localeCompare(b.path));
}

export async function captureSessionFilesystem(
  session: FilesystemCaptureSession,
  { filesystem, sourceControl }: FilesystemCaptureDependencies,
  ids?: { sessionId: string; threadId: string },
): Promise<void> {
  try {
    // Scheduled captures pass ids read at schedule time: a session deleted
    // before the queued capture runs has already cleared its thread.
    const sessionId = ids?.sessionId ?? session.identity.getId();
    const threadId = ids?.threadId ?? session.thread.requireId();
    const sourceSession = await sourceControl.sessions.getBySessionId(sessionId);
    // Chat-only sessions run without a workspace; there is nothing to capture.
    const sandbox = session.getWorkspace()?.sandbox;
    if (!sourceSession || !sandbox?.executeCommand) return;
    // The live workdir comes from the per-process memo (the deterministic
    // truth) ONLY — never the persisted observability column, which a row
    // written under a previous provider can point at a workdir that no
    // longer exists (the stale-workdir incident class). No memo entry means
    // no live sandbox worth capturing in this replica; capture is
    // best-effort telemetry, so skip.
    const entry = peekSessionSandbox(sourceSession.id);
    if (!entry) return;
    // Telemetry must never provision a VM: executeCommand lazily starts the
    // sandbox via ensureRunning, so a chat turn that never touched the
    // workspace would otherwise boot (and clone into) a fresh VM just to
    // capture an empty git status. Only capture when the turn already has a
    // running sandbox.
    if (entry.sandbox.status !== 'running') return;
    // Running-but-unresolved should not happen (the start hook resolves the
    // workdir), but capture is best-effort: skip rather than guess.
    const layout = sessionLayout(entry);
    if (!layout) return;

    // One git pass per checkout, in parallel so three repositories stay well
    // inside the 10 s readers wait for a pending capture. The session's own
    // repository compares against the session base branch; the others sit on
    // their default branch and compare against that. A repository whose
    // checkout is missing (exit 3) is skipped: it has nothing to list and
    // must not block the others. Any other failure is treated as transient
    // and leaves the previous listing in place.
    const multiRepo = layout.repos.length > 1;
    const environment = multiRepo ? peekSessionEnvironment(sourceSession.sessionId) : undefined;
    const ownRepo = entry.ownRepo.toLowerCase();
    // The boot records the state at its end, after every setup command; until
    // then a secondary checkout compares against its own `origin/HEAD`.
    const baseBranchFor = (repo: SessionLayoutRepository): string => {
      if (repo.slug.toLowerCase() === ownRepo) return sourceSession.baseBranch;
      const state = environment?.repositories.find(
        candidate => candidate.slug.toLowerCase() === repo.slug.toLowerCase(),
      );
      return state?.defaultBranch ?? 'HEAD';
    };
    const targets = layout.repos.map(repo => ({ repo, baseBranch: baseBranchFor(repo) }));
    const executeCommand = sandbox.executeCommand.bind(sandbox);
    const results = await Promise.all(
      targets.map(({ repo, baseBranch }) =>
        executeCommand('sh', ['-c', GIT_CHANGED_FILES_SCRIPT, 'mastracode-changed-files', repo.dir, baseBranch], {
          timeout: 30_000,
        }),
      ),
    );
    const files = new Map<string, FilesystemFile>();
    let captured = 0;
    for (const [index, result] of results.entries()) {
      if (result.exitCode === CHECKOUT_MISSING_EXIT_CODE) continue;
      if (result.exitCode !== 0) {
        console.warn('[Factory filesystem capture] Unable to inspect Git changes.', result.stderr);
        return;
      }
      captured += 1;
      const prefix = targets[index]!.repo.prefix;
      for (const file of parseFilesystemCaptureFiles(result.stdout)) {
        files.set(`${prefix}${file.path}`, { path: `${prefix}${file.path}` });
      }
    }
    if (captured === 0) return;

    const artifacts = await executeCommand('sh', ['-c', ARTIFACTS_LIST_COMMAND, 'sh', layout.root], {
      timeout: 30_000,
    });
    if (artifacts.exitCode !== 0) {
      console.warn('[Factory filesystem capture] Unable to list workspace artifacts.', artifacts.stderr);
      return;
    }
    for (const path of artifacts.stdout.split('\0')) {
      const normalizedPath = path.replace(/^\.\//, '');
      if (normalizedPath) {
        files.set(normalizedPath, { path: normalizedPath });
      }
    }

    // With several checkouts the root is a plain directory nothing else lists.
    // A failed listing is logged and the git and artifact results still land.
    if (multiRepo) {
      const since = touchStamp(sourceSession.createdAt);
      const rootFiles = await executeCommand('sh', ['-c', ROOT_FILES_LIST_COMMAND, 'sh', layout.root, since], {
        timeout: 30_000,
      });
      if (rootFiles.exitCode !== 0) {
        console.warn('[Factory filesystem capture] Unable to list workspace root files.', rootFiles.stderr);
      } else {
        for (const path of rootFiles.stdout.split('\0')) {
          const normalizedPath = path.replace(/^\.\//, '');
          if (normalizedPath && !normalizedPath.startsWith('.')) {
            files.set(normalizedPath, { path: normalizedPath });
          }
        }
      }
    }

    // The listing describes the session's workspace, not its memory resource,
    // which the session shares with others: rows are keyed by the session id.
    await filesystem.replaceFiles({
      resourceId: sessionId,
      threadId,
      files: [...files.values()].toSorted((a, b) => a.path.localeCompare(b.path)),
    });
  } catch (error) {
    console.warn('[Factory filesystem capture] Unable to persist files.', error);
  }
}

/**
 * In-flight capture chains keyed by session id. Serves two purposes: readers
 * of the persisted file listing (the /web/workspace routes) await the capture
 * for the turn that just ended instead of racing it, and captures for the same
 * session stay sequential (last write wins). In-process only: the factory
 * server that runs the session controller also serves those routes.
 */
const pendingCaptures = new Map<string, Promise<void>>();

/**
 * Run ends the session's controller has reported that the event hub has not yet told the capture
 * about (it hears a run's end once the end is stored). A reader driven by the controller's own end
 * must not find nothing pending in that gap: each end noted here holds the wait until the capture
 * has decided what to do with it (schedule one, or skip a turn that never touched the workspace).
 */
const endingRuns = new Map<string, Array<(() => void) & { gate: Promise<void> }>>();
const ENDING_RUN_SAFETY_MS = 30_000;

/**
 * fork(claude-agent): slice 7. Called synchronously when the session's controller ends a run, before
 * the end is stored and heard on the hub. Settled by the hub's `run.ended` (or after a safety delay
 * if that never comes).
 */
export function noteSessionRunEnding(sessionId: string): void {
  let settle!: () => void;
  const gate = new Promise<void>(resolve => {
    settle = resolve;
  });
  const done = Object.assign(
    () => {
      clearTimeout(timer);
      settle();
    },
    { gate },
  );
  const timer = setTimeout(() => settleOne(sessionId, done), ENDING_RUN_SAFETY_MS);
  timer.unref?.();
  endingRuns.set(sessionId, [...(endingRuns.get(sessionId) ?? []), done]);
}

function settleOne(sessionId: string, one?: (() => void) & { gate: Promise<void> }): void {
  const list = endingRuns.get(sessionId);
  if (!list) return;
  const index = one ? list.indexOf(one) : 0;
  if (index === -1) return;
  const [done] = list.splice(index, 1);
  if (list.length === 0) endingRuns.delete(sessionId);
  done?.();
}

function settleAllEndings(sessionId: string): void {
  for (const done of endingRuns.get(sessionId) ?? []) done();
  endingRuns.delete(sessionId);
}

/**
 * Resolve once the session's in-flight filesystem capture (if any) has
 * persisted, or after `timeoutMs` so a reader that arrives mid-capture is
 * never blocked by the execs' worst-case 30s timeouts. Never rejects: the
 * capture body is fully try/catch contained.
 */
export async function waitForPendingFilesystemCapture(sessionId: string, timeoutMs = 10_000): Promise<void> {
  if (!pendingCaptures.has(sessionId) && !endingRuns.has(sessionId)) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const deadline = new Promise<void>(resolve => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, timeoutMs);
  });
  try {
    // A run the controller ended that the hub has not yet told the capture about.
    for (const done of [...(endingRuns.get(sessionId) ?? [])]) {
      await Promise.race([done.gate, deadline]);
    }
    let pending = pendingCaptures.get(sessionId);
    // A turn that ends while we wait chains a successor capture; keep waiting
    // until the latest chain settles so the final snapshot is not lost.
    while (pending && !timedOut) {
      await Promise.race([pending, deadline]);
      const next = pendingCaptures.get(sessionId);
      pending = next === pending ? undefined : next;
    }
  } finally {
    clearTimeout(timer);
  }
}

export function observeSessionFilesystem(
  session: FilesystemCaptureSession,
  dependencies: FilesystemObserverDependencies,
): () => void {
  let fallbackChain = Promise.resolve();
  // Capture only runs after a turn that actually touched the workspace: a
  // successful workspace tool call both proves the sandbox is awake and is
  // the only way the listing can have changed. Without this gate every chat
  // turn would run two sandbox execs — and since executeCommand resumes an
  // idle VM, a pure-chat turn would keep waking a sandbox it never used.
  // Same bookkeeping as first-exec capture: tool names resolve at `tool.ended`
  // via the `tool.started` map, and suspended calls survive the run's end so a
  // resumed run's eventual completion still counts for that turn.
  let workspaceTouched = false;
  const toolNames = new Map<string, string>();
  const suspended = new Set<string>();
  // The thread the session was on when it last said anything: the hub tells a run's end once its
  // events are stored, by which time a deleted session has already cleared its thread (#24893).
  let lastThreadId: string | undefined;
  const rememberThread = () => {
    try {
      lastThreadId = session.thread.requireId();
    } catch {
      // Cleared: keep the last one.
    }
  };
  const capture = () => {
    if (!workspaceTouched) return;
    workspaceTouched = false;
    // Chain so captures stay sequential (last write wins). The capture's sandbox execs (git status +
    // artifacts find, 30s timeouts each) never gate anything: readers that need the fresh listing
    // await the pending capture through waitForPendingFilesystemCapture instead. The un-returned chain
    // cannot leak an unhandled rejection: captureSessionFilesystem's entire body runs inside its own
    // try/catch, and disposal of this listener does not cancel an in-flight chain, so a final turn's
    // capture still persists.
    let sessionId: string;
    try {
      sessionId = session.identity.getId();
    } catch {
      // No identity means no route can address this session's listing; keep
      // a per-observer chain so captures still run sequentially.
      fallbackChain = fallbackChain.then(() => captureSessionFilesystem(session, dependencies));
      return;
    }
    rememberThread();
    const threadId = lastThreadId;
    if (!threadId) return;
    const ids = { sessionId, threadId };
    const chain = (pendingCaptures.get(sessionId) ?? Promise.resolve()).then(() =>
      captureSessionFilesystem(session, dependencies, ids),
    );
    pendingCaptures.set(sessionId, chain);
    void chain.finally(() => {
      if (pendingCaptures.get(sessionId) === chain) {
        pendingCaptures.delete(sessionId);
      }
    });
  };
  let sessionId: string | undefined;
  try {
    sessionId = session.identity.getId();
  } catch {
    // Nothing to listen for.
  }
  if (sessionId === undefined) return () => {};
  rememberThread();
  const stopListening = dependencies.events.listen(sessionId, ({ event }) => {
    switch (event.type) {
      case 'tool.started': {
        toolNames.set(event.callId, event.name);
        return;
      }
      case 'interaction.requested': {
        // A call parked for approval has not run, and does not count.
        const { callId, request } = event.interaction;
        if (callId && request.kind !== 'tool_approval') suspended.add(callId);
        return;
      }
      case 'interaction.cancelled': {
        const callId = event.interactionId.slice(event.interactionId.indexOf(':') + 1);
        toolNames.delete(callId);
        suspended.delete(callId);
        return;
      }
      case 'tool.ended': {
        const toolName = toolNames.get(event.callId);
        toolNames.delete(event.callId);
        suspended.delete(event.callId);
        rememberThread();
        if (event.error !== undefined || event.denied) return;
        if (isMeaningfulToolName(toolName)) workspaceTouched = true;
        return;
      }
      case 'run.ended': {
        for (const id of toolNames.keys()) {
          if (!suspended.has(id)) toolNames.delete(id);
        }
        try {
          capture();
        } finally {
          settleOne(sessionId!);
        }
      }
    }
  });
  return () => {
    stopListening();
    settleAllEndings(sessionId!);
  };
}
