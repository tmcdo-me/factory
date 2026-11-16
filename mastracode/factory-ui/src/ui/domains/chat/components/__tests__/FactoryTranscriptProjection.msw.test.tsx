// fork(claude-agent): projected Factory transcripts render through the existing chat renderers.
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '../../../../../../e2e/ui/render';
import { projectTranscript } from '../../services/factory-transcript-projection';
import { transcriptOf } from '../../services/__tests__/fixtures/factory-transcript';
import { TranscriptEntries } from '../Transcript';

describe('a Factory transcript drawn by the chat renderers', () => {
  it('shows the conversation, the tool call, and an approval card', async () => {
    const { entries } = projectTranscript(
      transcriptOf(
        { type: 'message.started', messageId: 'u1', role: 'user' },
        { type: 'message.delta', messageId: 'u1', part: 'text', delta: 'Ship the card' },
        { type: 'message.ended', messageId: 'u1' },
        { type: 'run.started', runId: 'r1' },
        { type: 'message.started', messageId: 'a1', role: 'assistant', runId: 'r1' },
        { type: 'message.delta', messageId: 'a1', part: 'text', delta: 'Moving it to review.' },
        {
          type: 'tool.started',
          callId: 'c1',
          name: 'factory_transition_work_item',
          category: 'factory',
          executor: 'factory',
          runId: 'r1',
          input: { stage: 'review' },
        },
        {
          type: 'interaction.requested',
          interaction: {
            id: 'i1',
            sessionId: 's1',
            callId: 'c1',
            request: { kind: 'tool_approval', toolName: 'factory_transition_work_item', input: { stage: 'review' } },
            requestedAt: 't',
          },
        },
      ),
    );

    renderWithProviders(<TranscriptEntries entries={entries} onApprove={() => {}} onRespond={() => {}} />);

    expect(await screen.findByText('Ship the card')).toBeTruthy();
    expect(await screen.findByText('Moving it to review.', undefined, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByRole('button', { name: /approve/i })).toBeTruthy();
  });

  it('shows an ask_user question from a pending question interaction', async () => {
    const { entries } = projectTranscript(
      transcriptOf(
        { type: 'message.started', messageId: 'a1', role: 'assistant' },
        {
          type: 'tool.started',
          callId: 'q1',
          name: 'ask_user',
          category: 'factory',
          executor: 'factory',
          input: { question: 'Which database?' },
        },
        {
          type: 'interaction.requested',
          interaction: {
            id: 'i1',
            sessionId: 's1',
            callId: 'q1',
            request: {
              kind: 'question',
              question: 'Which database?',
              options: [{ label: 'Postgres' }, { label: 'SQLite' }],
            },
            requestedAt: 't',
          },
        },
      ),
    );

    renderWithProviders(<TranscriptEntries entries={entries} onApprove={() => {}} onRespond={() => {}} />);

    expect((await screen.findAllByText('Which database?')).length).toBeGreaterThan(0);
    expect(screen.getByText('Postgres')).toBeTruthy();
  });
});
