/**
 * BDD coverage for whether anything files new cards onto a board. The board shows cards only: the
 * server files new issues and pull requests of the selected GitHub repositories, so no provider's
 * list is read.
 */
import { waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, onTestFinished } from 'vitest';

import { builtinBoardCatalog } from '../../../../../../e2e/ui/board-catalog';
import { server } from '../../../../../../e2e/ui/msw-server';
import { renderHookWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import type { LinkedRepositoryPayload } from '../../../workspaces/services/github';
import type { InstalledBoardInfo } from '../../../../../api/types';
import { useBoardIntakeSetup } from '../useBoardIntakeSetup';

const repository: LinkedRepositoryPayload = { projectRepositoryId: 'repo-1', slug: 'acme/app' };
const workBoard = builtinBoardCatalog.boards.find(board => board.id === 'work')!;

const renderSetup = (factoryProjectId: string, definition: InstalledBoardInfo = workBoard) =>
  renderHookWithProviders(() => useBoardIntakeSetup({ factoryProjectId, repositories: [repository], definition }));

/** Records every request for a provider's list of issues or pull requests. */
function recordProviderLists() {
  const asked: string[] = [];
  const record = ({ request }: { request: Request }) => {
    const { pathname } = new URL(request.url);
    if (/^\/web\/github\/projects\/[^/]+\/(issues|prs)$/.test(pathname)) asked.push(pathname);
  };
  server.events.on('request:start', record);
  onTestFinished(() => {
    server.events.removeListener('request:start', record);
  });
  return asked;
}

function stubGithubIntake(selection: { enabled: boolean; sourceIds: string[] | null }) {
  server.use(
    http.get(`${TEST_BASE_URL}/web/intake/config`, () => HttpResponse.json({ config: { github: selection } })),
  );
}

describe('useBoardIntakeSetup', () => {
  it('counts the board as fed by a selected GitHub repository and asks GitHub for no list', async () => {
    stubGithubIntake({ enabled: true, sourceIds: ['acme/app'] });
    const asked = recordProviderLists();

    const { result, client } = renderSetup('factory-1');

    await waitFor(() => expect(result.current.isPending).toBe(false));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(result.current.fed).toBe(true);
    expect(asked).toEqual([]);
  });

  it('asks for setup while GitHub intake is off or the repository is not selected', async () => {
    stubGithubIntake({ enabled: false, sourceIds: ['acme/app'] });
    const off = renderSetup('factory-1');
    await waitFor(() => expect(off.result.current.isPending).toBe(false));
    expect(off.result.current.fed).toBe(false);
    off.unmount();

    stubGithubIntake({ enabled: true, sourceIds: ['acme/other'] });
    const unselected = renderSetup('factory-1');
    await waitFor(() => expect(unselected.result.current.isPending).toBe(false));
    expect(unselected.result.current.fed).toBe(false);
  });
});
