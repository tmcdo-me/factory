import type { LinkedRepositoryPayload } from '../workspaces/services/github';

export function repositoryMatchesCardSource(repository: LinkedRepositoryPayload, source: string) {
  const provider = repository.provider ?? 'github';
  if (source === 'github-issue' || source === 'github-pr') return provider === 'github';
  return true;
}

function matchesProviderRepositoryId(
  repository: LinkedRepositoryPayload,
  source: string,
  metadata: Record<string, unknown> | undefined,
) {
  if (!repositoryMatchesCardSource(repository, source)) return false;
  const id = metadata?.githubRepositoryId;
  return id != null && repository.externalId === String(id);
}

function findUniqueRepositoryByProviderId(
  repositories: LinkedRepositoryPayload[],
  source: string,
  metadata: Record<string, unknown> | undefined,
) {
  const matches = repositories.filter(repository => matchesProviderRepositoryId(repository, source, metadata));
  const [match] = matches;
  return matches.length === 1 ? match : undefined;
}

export function cardRepositorySlug(
  source: string,
  metadata: Record<string, unknown> | undefined,
  repositories: LinkedRepositoryPayload[],
) {
  // The provider id survives repository renames, so it outranks a possibly stale slug.
  const repository = findUniqueRepositoryByProviderId(repositories, source, metadata);
  if (repository) return repository.slug;
  if (typeof metadata?.repository === 'string') return metadata.repository;
  return undefined;
}

/** The linked repository a card's source lives in, else the board's primary repository. */
export function cardProjectRepositoryId<Fallback extends string | undefined>(
  repositories: LinkedRepositoryPayload[],
  card: {
    source: string;
    metadata?: Record<string, unknown>;
    workItem?: { metadata: Record<string, unknown> | null };
  },
  fallback: Fallback,
): string | Fallback {
  const metadata = { ...card.metadata, ...card.workItem?.metadata };
  return findUniqueRepositoryByProviderId(repositories, card.source, metadata)?.projectRepositoryId ?? fallback;
}
