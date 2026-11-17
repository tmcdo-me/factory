import type { EventEnvelope } from '@factory/agent-runtime';
import { WORKSPACE_TOOLS_PREFIX } from '@mastra/core/workspace';

import type { SourceControlStorageHandle } from '../storage/domains/source-control/base.js';

export interface FirstExecCaptureSession {
  readonly identity: { getId(): string };
}

export interface FirstExecCaptureDependencies {
  /** fork(claude-agent): slice 6. The session's events are heard on Factory's event hub. */
  events: { listen(sessionId: string, listener: (envelope: EventEnvelope) => void): () => void };
  sourceControl: {
    sessions: Pick<SourceControlStorageHandle['sessions'], 'markFirstMeaningfulExec'>;
  };
}

/**
 * Tool names that count as "meaningful exec" independent of the workspace
 * prefix. The workspace tools get remapped from `mastra_workspace_*` to
 * mastracode-friendly names (see `mastracode/sdk/src/tool-names.ts`), and
 * this listener runs on the emitted tool name after remap, so both spellings
 * need to match.
 */
const MEANINGFUL_TOOL_NAMES: ReadonlySet<string> = new Set([
  // Filesystem (post-remap)
  'view',
  'write_file',
  'string_replace_lsp',
  'find_files',
  'delete_file',
  'file_stat',
  'mkdir',
  // Search
  'search_content',
  // Code intelligence
  'ast_smart_edit',
  'lsp_inspect',
  // Sandbox
  'execute_command',
  'get_process_output',
  'kill_process',
]);

export function isMeaningfulToolName(name: string | undefined): boolean {
  if (!name) return false;
  if (name.startsWith(`${WORKSPACE_TOOLS_PREFIX}_`)) return true;
  return MEANINGFUL_TOOL_NAMES.has(name);
}

/**
 * Record when a session's agent completed its first successful meaningful
 * tool call (the TTFME anchor — "time to first meaningful exec").
 *
 * Meaningful = a workspace tool the agent invoked itself (filesystem,
 * search, code intelligence, sandbox exec, process control). We accept any
 * tool whose name starts with the workspace prefix `mastra_workspace_` or
 * matches the post-remap mastracode tool names. Non-workspace tools (memory,
 * notification inbox, subagent, etc.) and skill-loader / preflight /
 * materializer `sandbox.executeCommand()` calls that never flow through the
 * tool layer are intentionally excluded.
 *
 * Failed tool calls (`isError === true`) don't count. Approval-denied and
 * abort-while-parked tool completions (`denied === true`) also don't count:
 * the run-engine emits `tool_end` with `isError: false` for those paths
 * because the tool didn't fail, but it also never ran, so treating them as
 * "meaningful exec" would re-introduce the same contamination this fix is
 * removing on the message side. The listener stays subscribed until a
 * successful qualifying end, then unsubscribes. The storage write is guarded
 * (`first_meaningful_exec_at IS NULL`), so restarts, re-materialized
 * sessions, and sessions without a source-control row are no-ops.
 */
export function observeSessionFirstExec(
  session: FirstExecCaptureSession,
  { sourceControl, events }: FirstExecCaptureDependencies,
): () => void {
  let seen = false;
  // toolCallId -> toolName. Populated on `tool_start`, consumed on `tool_end`.
  // Suspended entries survive `agent_end` so the resumed run can still resolve
  // its tool name when the eventual `tool_end` arrives.
  const toolNames = new Map<string, string>();
  const suspended = new Set<string>();
  const unsubscribe = events.listen(session.identity.getId(), ({ event }) => {
    if (seen) return;
    switch (event.type) {
      case 'tool.started': {
        toolNames.set(event.callId, event.name);
        return;
      }
      case 'interaction.requested': {
        // A suspended tool survives the run's end (a call parked for approval has not run, and does not).
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
      case 'run.ended': {
        // Drop any in-flight starts that will never see a matching `tool.ended`
        // on this run. Genuinely suspended calls stay so their eventual
        // resume-time `tool.ended` can still map back to a tool name. Without
        // this, sessions that repeatedly abort or error before a qualifying
        // completion would accumulate stale entries for the entire lifetime
        // of the subscription.
        for (const id of toolNames.keys()) {
          if (!suspended.has(id)) toolNames.delete(id);
        }
        return;
      }
      case 'tool.ended': {
        const toolName = toolNames.get(event.callId);
        toolNames.delete(event.callId);
        suspended.delete(event.callId);
        if (event.error !== undefined) return;
        if (event.denied) return;
        if (!isMeaningfulToolName(toolName)) return;
        seen = true;
        unsubscribe();
        void sourceControl.sessions
          .markFirstMeaningfulExec({ sessionId: session.identity.getId() })
          .catch(error => console.warn('[Factory first-exec capture] Unable to persist first exec time.', error));
        break;
      }
    }
  });
  return unsubscribe;
}
