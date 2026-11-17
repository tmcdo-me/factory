import { DEFAULT_BOARD_ID } from '@mastra/factory/boards/default-board';
import { useIntakeConfigQuery } from '../../../../hooks/useIntakeConfig';
import { useIntakeRoutesQuery } from '../../../../hooks/useIntakeRoutes';
import type { LinkedRepositoryPayload } from '../../workspaces/services/github';
import type { InstalledBoardInfo } from '../../../../api/types';

/**
 * Whether anything files new cards onto a board, so its initial phase can ask for the setup it
 * misses: a connected source, or an intake route that sends cards here.
 *
 * The board shows cards only. The server files every new issue and pull request of a connected
 * source as a card, through the project's intake rules, so no provider's list is read here.
 */
export function useBoardIntakeSetup({
  factoryProjectId,
  repositories,
  definition,
}: {
  factoryProjectId: string;
  /** Every linked repository. */
  repositories: readonly LinkedRepositoryPayload[];
  definition: InstalledBoardInfo;
}) {
  const kind = definition.id;
  const defaultBoard = kind === DEFAULT_BOARD_ID;
  const configQuery = useIntakeConfigQuery();

  const config = configQuery.data;
  const githubEnabled = config?.github.enabled ?? false;
  // GitHub issues come from the linked repositories selected as issue sources.
  const githubSelected = repositories.some(linked =>
    config ? (config.github.sourceIds?.includes(linked.slug) ?? false) : true,
  );
  const sourceConnected = githubEnabled && githubSelected;
  // A connected source files onto the default board, and onto another board only through an
  // intake route that places its new cards there: enabled, run on `work_item.created`, and not
  // one that only joins a pull request to an existing card (the server's `resolveIntakeRoute`).
  const readsIntakeRoutes = !defaultBoard && sourceConnected;
  const intakeRoutesQuery = useIntakeRoutesQuery(readsIntakeRoutes ? factoryProjectId : undefined);
  const intakeRoutesPending = readsIntakeRoutes && intakeRoutesQuery.isPending;
  const routePlacesCardsHere = (intakeRoutesQuery.data?.intakeRoutes ?? []).some(
    route =>
      route.enabled &&
      route.on.includes('work_item.created') &&
      !route.target.joinClosedIssue &&
      route.target.boardKey === kind,
  );
  // Sources are connected and the routes loaded, but none places new cards on this board.
  const unrouted = readsIntakeRoutes && intakeRoutesQuery.isSuccess && !routePlacesCardsHere;
  // Whether anything files onto this board. Routes that failed to load ask for no setup.
  const fed = sourceConnected && (defaultBoard || !intakeRoutesQuery.isSuccess || routePlacesCardsHere);

  // Keep an unresolved board pending while discovering its routed sources.
  const discoveringSources = intakeRoutesPending;

  // Failed routes leave the board unable to tell whether anything files here.
  const failedRead = readsIntakeRoutes && intakeRoutesQuery.isError ? intakeRoutesQuery : undefined;
  const failure = failedRead?.error
    ? { message: failedRead.error.message, retry: () => void failedRead.refetch() }
    : undefined;

  return { fed, unrouted, failure, isPending: configQuery.isPending || discoveringSources };
}
