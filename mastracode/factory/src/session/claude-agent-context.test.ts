// fork(claude-agent)
import { RequestContext } from '@mastra/core/request-context';
import { describe, expect, it } from 'vitest';

import { createTriageWorkRegistry } from '../boards/test-utils.js';
import { FactoryPhaseStateProcessor } from '../rules/processor.js';
import { createFactoryStorageForTests } from '../storage/test-utils.js';
import type { ClaudeAgentContextBlock } from './claude-agent-context.js';
import { providerContext } from './claude-agent-context.js';
import { claudeAgentRequestContext } from './claude-agent-workspace.js';
import { FactoryWorkItemStateProcessor } from './work-item-state-processor.js';

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';

async function boundSession() {
  const storage = (await createFactoryStorageForTests()).workItems;
  const prepared = await storage.prepareRunStart({
    orgId: 'org-1',
    userId: 'user-1',
    factoryProjectId: PROJECT_ID,
    workItem: {
      input: {
        externalSource: { integrationId: 'github', type: 'issue', externalId: 'github-issue:1' },
        title: 'Improve the settings UI',
        stages: ['planning'],
        sessions: {},
        metadata: {},
      },
    },
    role: 'plan',
    session: { sessionId: 's1', branch: 'factory/issue-1', threadId: 's1' },
    resourceId: 's1',
    kickoffKey: 'kickoff-1',
    kickoffMessage: null,
  });
  const boards = createTriageWorkRegistry();
  const phase = new FactoryPhaseStateProcessor({ configVersion: 'rules-v1', boards, storage });
  const workItem = new FactoryWorkItemStateProcessor({ storage, boards });
  const host = new RequestContext();
  host.set('user', { workosId: 'user-1', organizationId: 'org-1' });
  // The session's controller context, as its Factory tools see it once they found its card.
  const contextFor = claudeAgentRequestContext('s1');
  const controller = contextFor(host).get('controller') as { setState(update: object): Promise<void> };
  await controller.setState({ factoryProjectId: PROJECT_ID, factoryOrgId: 'org-1' });
  return { storage, prepared, phase, workItem, requestContext: contextFor(host) };
}

const told = (blocks: ClaudeAgentContextBlock[], previous = new Map<string, ClaudeAgentContextBlock>()) => {
  const next = new Map(previous);
  for (const block of blocks) next.set(block.id, block);
  return next;
};

describe('providerContext', () => {
  it("tells a Claude Agent session its card and phase as Mastra Code's state signals would, once", async () => {
    const { phase, workItem, requestContext } = await boundSession();
    const context = providerContext([phase.context, workItem.context]);

    const first = await context(requestContext, new Map());
    expect(first.map(block => [block.id, block.kind, block.tag])).toEqual([
      ['factory-phase', 'state', 'factory-phase'],
      ['factory-work-item', 'state', 'factory-work-item'],
    ]);
    expect(first[0]!.text).toContain('Factory work phase: Planning (planning)');
    expect(first[0]!.text).toContain('Use factory_transition_work_item with expectedRevision 1');
    expect(first[0]!.attributes).toMatchObject({ stage: 'planning', role: 'plan', revision: 1 });

    // Nothing changed: the next turn carries no context.
    expect(await context(requestContext, told(first))).toEqual([]);
  });

  it('tells the session what changed when the card moves on', async () => {
    const { storage, prepared, phase, requestContext } = await boundSession();
    const context = providerContext([phase.context]);
    const first = await context(requestContext, new Map());
    await storage.update({
      orgId: 'org-1',
      id: prepared.item.id,
      userId: 'user-1',
      patch: { metadata: { note: 'x' } },
    });

    const [update] = await context(requestContext, told(first));
    expect(update?.text).toMatch(/^Factory phase update:\n/);
    expect(update?.text).toContain('Revision: 2');
  });

  it('skips a context that fails, keeping the rest of the turn', async () => {
    const { workItem, requestContext } = await boundSession();
    const broken = { id: 'broken', provide: async () => Promise.reject(new Error('boom')) };
    const blocks = await providerContext([broken, workItem.context])(requestContext, new Map());
    expect(blocks.map(block => block.id)).toEqual(['factory-work-item']);
  });
});
