// fork(claude-agent): what answer a question takes from outside its session.
import { describe, expect, it } from 'vitest';

import { checkedAnswer } from './parked-interaction.js';

const options = [{ label: 'main' }, { label: 'release' }];

describe('checkedAnswer', () => {
  it('takes one answer in words for a question with no options', () => {
    expect(checkedAnswer({ kind: 'question', question: 'Why?' }, ['  Because  '])).toBe('Because');
    expect(() => checkedAnswer({ kind: 'question', question: 'Why?' }, ['a', 'b'])).toThrow('one answer in words');
    expect(() => checkedAnswer({ kind: 'question', question: 'Why?' }, '  ')).toThrow('Give an answer.');
  });

  it('takes one choice, or an answer of the person own, for a single choice', () => {
    const single = { kind: 'question' as const, question: 'Which?', options, selection: 'single' as const };
    expect(checkedAnswer(single, ['release'])).toBe('release');
    expect(checkedAnswer(single, 'neither, use a hotfix branch')).toBe('neither, use a hotfix branch');
    expect(() => checkedAnswer(single, ['main', 'release'])).toThrow('one choice');
  });

  it('takes distinct choices, with at most one of the person own, for a multiple choice', () => {
    const multiple = { kind: 'question' as const, question: 'Which?', options, selection: 'multiple' as const };
    expect(checkedAnswer(multiple, 'main')).toEqual(['main']);
    expect(checkedAnswer(multiple, ['main', 'a branch of my own'])).toEqual(['main', 'a branch of my own']);
    expect(() => checkedAnswer(multiple, ['main', 'main'])).toThrow('each option once');
    expect(() => checkedAnswer(multiple, ['x', 'y'])).toThrow('at most one answer of your own');
  });

  it('never takes an answer for a yes or no', () => {
    expect(() => checkedAnswer({ kind: 'plan_approval', planPath: 'p.md' }, 'yes')).toThrow('yes or no');
  });
});
