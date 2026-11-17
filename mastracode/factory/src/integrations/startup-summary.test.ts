import { describe, expect, it } from 'vitest';
import type { FactoryIntegration } from './base.js';
import { describeIntegrations } from './startup-summary.js';

function integration(id: string, connected?: boolean | Error): FactoryIntegration {
  return {
    id,
    routes: () => [],
    diagnostics: () => ({}),
    ...(connected !== undefined && {
      async hasActiveConnections() {
        if (connected instanceof Error) throw connected;
        return connected;
      },
    }),
  };
}

describe('describeIntegrations', () => {
  it('separates connected providers from ones that are only available', async () => {
    await expect(
      describeIntegrations([integration('github', true), integration('tracker', false), integration('pager', false)]),
    ).resolves.toBe('Intake: GitHub connected · tracker, pager available');
  });

  it('says none are connected on a fresh project', async () => {
    await expect(describeIntegrations([integration('github', false), integration('tracker', false)])).resolves.toBe(
      'Intake: none connected · GitHub, tracker available',
    );
  });

  it('reports a failed check as unknown instead of failing', async () => {
    await expect(
      describeIntegrations([integration('github', true), integration('tracker', new Error('timeout'))]),
    ).resolves.toBe('Intake: GitHub connected · tracker status unknown');
  });

  it('does not claim none are connected when a check failed', async () => {
    await expect(
      describeIntegrations([integration('github', new Error('timeout')), integration('tracker', false)]),
    ).resolves.toBe('Intake: tracker available · GitHub status unknown');
  });

  it('prints nothing when no integration can report connections', async () => {
    await expect(describeIntegrations([integration('custom')])).resolves.toBeUndefined();
  });
});
