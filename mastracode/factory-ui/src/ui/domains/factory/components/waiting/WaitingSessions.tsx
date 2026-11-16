// fork(claude-agent): the one place outside a session to see what waits on a person and answer it.
import type { PlanResume } from '@mastra/client-js';
import { ToolApproval } from '@mastra/playground-ui/components/ai/tool-approval';
import { Button } from '@mastra/playground-ui/components/Button';
import { EmptyState } from '@mastra/playground-ui/components/EmptyState';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { IconCircleCheck } from '@mastra/playground-ui/icons/central/IconCircleCheck';
import { Link } from 'react-router';

import { relativeTime } from '../../../../../lib/date/relativeTime';
import { SuspensionCard } from '../../../chat/components/TranscriptPromptCards';
import type { SuspensionPrompt } from '../../../chat/services/transcript';
import { LoadErrorState } from '../../../../ui/LoadErrorState';
import { useAnswerWaitingSession, useWaitingSessions } from '../../hooks/useWaitingSessions';
import type { WaitingAnswer } from '../../hooks/useWaitingSessions';
import { factoryAttentionTargetPath } from '../../services/attention';
import type {
  FactoryInboxItem,
  FactoryProposalItem,
  FactoryWaitingInteraction,
  FactoryWaitingItem,
} from '../../services/waiting';

/** The prompt card a question or plan draws in its session, built from what the inbox says it asks. */
function promptOf(item: FactoryWaitingItem, interaction: FactoryWaitingInteraction): SuspensionPrompt | undefined {
  const { request } = interaction;
  // A question asked in plain text has no tool call; the card only needs an id to answer by.
  const toolCallId = interaction.toolCallId ?? interaction.interactionId ?? item.key;
  const base = { kind: 'suspension' as const, id: `waiting-${item.key}`, toolCallId };
  if (request.kind === 'question') {
    return {
      ...base,
      toolName: 'ask_user',
      args: {},
      suspendPayload: {
        question: request.question,
        ...(request.options ? { options: request.options } : {}),
        selectionMode: request.selection === 'multiple' ? 'multi_select' : 'single_select',
      },
    };
  }
  if (request.kind === 'plan_approval') {
    return {
      ...base,
      toolName: 'submit_plan',
      args: { path: request.planPath },
      suspendPayload: { path: request.planPath, ...(request.plan ? { plan: request.plan } : {}) },
    };
  }
  return undefined;
}

function WaitingAnswerCard({
  item,
  submitting,
  onAnswer,
}: {
  item: FactoryWaitingItem;
  submitting: boolean;
  onAnswer: (answer: WaitingAnswer) => void;
}) {
  const interaction = item.interaction;
  if (!interaction) {
    return (
      <Txt variant="caption" tone="muted" role="note">
        Open the session to answer it.
      </Txt>
    );
  }
  // A yes or no names the call it answers; one that names none is answered in the session.
  if (interaction.request.kind !== 'question' && !interaction.toolCallId) {
    return (
      <Txt variant="caption" tone="muted" role="note">
        Open the session to answer it.
      </Txt>
    );
  }
  if (interaction.request.kind === 'tool_approval') {
    return (
      <ToolApproval
        toolName={interaction.request.toolName}
        args={interaction.request.input}
        disabled={submitting}
        onApprove={() => onAnswer({ kind: 'decision', decision: 'approve' })}
        onDecline={() => onAnswer({ kind: 'decision', decision: 'decline' })}
      />
    );
  }
  const prompt = promptOf(item, interaction);
  if (!prompt) return null;
  return (
    <SuspensionCard
      prompt={prompt}
      isSubmitting={submitting}
      sessionId={item.sessionId}
      onRespond={(_toolCallId, response) => {
        if (interaction.request.kind === 'question') {
          if (typeof response === 'string' || Array.isArray(response)) onAnswer({ kind: 'question', answer: response });
          return;
        }
        if (typeof response !== 'object' || Array.isArray(response)) return;
        const plan: PlanResume = response;
        onAnswer({
          kind: 'decision',
          decision: plan.action === 'approved' ? 'approve' : 'decline',
          ...(plan.feedback ? { reason: plan.feedback } : {}),
        });
      }}
    />
  );
}

function WaitingRow({
  factoryId,
  item,
  submitting,
  onAnswer,
}: {
  factoryId: string;
  item: FactoryWaitingItem;
  submitting: boolean;
  onAnswer: (answer: WaitingAnswer) => void;
}) {
  return (
    <li className="border-border flex min-w-0 flex-col gap-2 border-b pb-4 last:border-b-0">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <Txt as="h3" variant="subheading" tone="ink" className="min-w-0 truncate">
          {item.title}
        </Txt>
        <Txt variant="caption" tone="muted">
          {item.detail}
        </Txt>
        <Txt variant="caption" tone="muted">
          {item.role} session
        </Txt>
        <Txt variant="caption" tone="muted">
          {relativeTime(item.occurredAt)}
        </Txt>
        <Link
          className="text-accent1 ml-auto text-sm underline-offset-2 hover:underline"
          to={factoryAttentionTargetPath(factoryId, item.target)}
        >
          Open session
        </Link>
      </div>
      <WaitingAnswerCard item={item} submitting={submitting} onAnswer={onAnswer} />
    </li>
  );
}

/** A proposal the board's rules left for a person: approve releases it, dismiss drops it. */
function ProposalRow({
  factoryId,
  item,
  submitting,
  onAnswer,
}: {
  factoryId: string;
  item: FactoryProposalItem;
  submitting: boolean;
  onAnswer: (answer: WaitingAnswer) => void;
}) {
  return (
    <li className="border-border flex min-w-0 flex-col gap-2 border-b pb-4 last:border-b-0">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <Txt as="h3" variant="subheading" tone="ink" className="min-w-0 truncate">
          {item.title}
        </Txt>
        <Txt variant="caption" tone="muted">
          {item.detail}
        </Txt>
        <Txt variant="caption" tone="muted">
          {relativeTime(item.occurredAt)}
        </Txt>
        <Link
          className="text-accent1 ml-auto text-sm underline-offset-2 hover:underline"
          to={factoryAttentionTargetPath(factoryId, item.target)}
        >
          Open
        </Link>
      </div>
      {/* Who may approve is the server's rule (a move held for consent takes an org admin); it says why when it refuses. */}
      <div className="flex gap-2" role="group" aria-label={`Proposal: ${item.detail}`}>
        <Button
          size="sm"
          variant="primary"
          disabled={submitting}
          onClick={() => onAnswer({ kind: 'decision', decision: 'approve' })}
        >
          Approve
        </Button>
        <Button size="sm" disabled={submitting} onClick={() => onAnswer({ kind: 'decision', decision: 'decline' })}>
          Dismiss
        </Button>
      </div>
    </li>
  );
}

function InboxRow(props: {
  factoryId: string;
  item: FactoryInboxItem;
  submitting: boolean;
  onAnswer: (answer: WaitingAnswer) => void;
}) {
  const { item, ...rest } = props;
  return item.kind === 'automation-proposed' ? (
    <ProposalRow item={item} {...rest} />
  ) : (
    <WaitingRow item={item} {...rest} />
  );
}

/** Everything waiting on a person: card sessions, each with its question or plan to answer in place, and proposals. */
export function WaitingSessions({ factoryId }: { factoryId: string }) {
  const waiting = useWaitingSessions(factoryId);
  const answer = useAnswerWaitingSession(factoryId);

  if (waiting.isPending) {
    return (
      <Txt variant="caption" tone="muted" aria-label="Loading waiting sessions">
        Loading…
      </Txt>
    );
  }
  if (waiting.isError) {
    return (
      <LoadErrorState
        title="Couldn’t load what is waiting"
        error={waiting.error}
        onRetry={() => void waiting.refetch()}
        retrying={waiting.isFetching}
      />
    );
  }
  if (waiting.data.length === 0) {
    return (
      <EmptyState
        className="min-h-0 flex-1"
        as="h3"
        iconSlot={<IconCircleCheck aria-hidden />}
        titleSlot="Nothing is waiting on you"
        descriptionSlot="When a run asks a question, submits a plan, or a move waits for approval, it shows here."
      />
    );
  }
  return (
    <ul aria-label="Waiting sessions" className="flex min-w-0 flex-col gap-4">
      {waiting.data.map(item => (
        <InboxRow
          key={item.key}
          factoryId={factoryId}
          item={item}
          submitting={answer.isPending && answer.variables?.item.key === item.key}
          onAnswer={reply => answer.mutate({ item, answer: reply })}
        />
      ))}
    </ul>
  );
}
