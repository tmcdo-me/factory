// fork(claude-agent)
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ToolFactory } from '../ToolFactory';

const question = { question: 'Which fruit do you like?', options: [{ label: 'apple' }, { label: 'pear' }] };

describe('ToolFactory ask_user', () => {
  it('shows a question the person stopped as stopped: not answered, not an error', () => {
    render(
      <ToolFactory
        toolName="ask_user"
        toolCallId="q1"
        input={question}
        output="Stopped"
        status="done"
        stopped
        fallback={() => null}
      />,
    );
    const output = screen.getByRole('status');
    expect(output).toHaveTextContent('Stopped');
    expect(output).toHaveTextContent('Stopped before you answered.');
    expect(screen.queryByText('Answered')).not.toBeInTheDocument();
    expect(screen.queryByText('Error')).not.toBeInTheDocument();
  });

  it('still shows a real answer as answered', () => {
    render(
      <ToolFactory
        toolName="ask_user"
        toolCallId="q2"
        input={question}
        output="apple"
        status="done"
        fallback={() => null}
      />,
    );
    expect(screen.getByText('Answered')).toBeInTheDocument();
    expect(screen.getByText('apple')).toBeInTheDocument();
  });
});
