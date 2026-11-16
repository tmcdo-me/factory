import { isPlanReadablePath, usePlanFile } from '../../../../hooks/use-fs';
import { useRespondSessionPromptMutation } from '../../../../hooks/useSessionCommandMutations';
import { useThreadWorkspacePath } from '../../workspace-viewer/hooks/useThreadWorkspacePath';
import { parsePlanMarkdown, resolveInlinePlan } from '../components/submit-plan-source';
import { useChatSessionContext } from '../context/useChatSessionContext';
import { useChatTranscript } from '../context/useChatTranscript';
import type { PlanResume } from '../services/factorySessionCommands';
import type { TimelineEntry } from '../services/transcript';

function pendingSubmitPlan(entries: TimelineEntry[]) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === 'suspension' && entry.toolName === 'submit_plan') return entry;
  }
  return undefined;
}

export function usePendingPlanFeedback() {
  const { sessionId, baseUrl } = useChatSessionContext();
  const { transcript, resolvePrompt } = useChatTranscript();
  const prompt = pendingSubmitPlan(transcript.entries);
  const inline = resolveInlinePlan(prompt?.suspendPayload, undefined);
  const workspace = useThreadWorkspacePath();
  const fetchable = inline.plan === undefined && isPlanReadablePath(inline.path);
  const file = usePlanFile(workspace.workspacePath, inline.path, prompt?.toolCallId, {
    enabled: Boolean(prompt) && fetchable,
  });
  const fetched = fetchable && file.data?.content !== undefined ? parsePlanMarkdown(file.data.content) : undefined;
  const loading =
    Boolean(prompt) &&
    fetchable &&
    !fetched &&
    !file.isError &&
    (workspace.isPending || (Boolean(workspace.workspacePath) && file.isPending));
  const respondMutation = useRespondSessionPromptMutation({ sessionId, baseUrl });

  const submitFeedback = async (feedback: string) => {
    if (!prompt || !feedback.trim()) return;
    const title = inline.title ?? fetched?.title;
    const plan = inline.plan ?? fetched?.plan;
    const resumeData: PlanResume = {
      action: 'rejected',
      feedback: feedback.trim(),
      ...(inline.path ? { path: inline.path } : {}),
      ...(title ? { title } : {}),
      ...(plan ? { plan } : {}),
    };
    await respondMutation.mutateAsync({ toolCallId: prompt.toolCallId, resumeData });
    resolvePrompt(prompt.id);
  };

  return {
    pending: Boolean(prompt),
    loading,
    isSubmitting: respondMutation.isPending,
    submitFeedback,
  };
}
