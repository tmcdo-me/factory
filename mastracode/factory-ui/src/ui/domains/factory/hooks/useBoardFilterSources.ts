import { useGithubStatusQuery } from '../../../../hooks/useGithubStatus';

export function useBoardFilterSources() {
  const githubStatus = useGithubStatusQuery();
  const connectedSources = new Set(githubStatus.data?.connected ? ['github'] : []);
  return { connectedSources };
}
