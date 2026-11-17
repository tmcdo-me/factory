import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import type { CustomProviderInfo, CustomProvidersResponse, OkResponse, SaveCustomProviderBody } from '../api/types';

/**
 * Organization-scoped OpenAI-compatible providers. The API key is write-only;
 * the server only ever reports `hasApiKey`.
 */
function useCustomProvidersResponse<T>(select: (body: CustomProvidersResponse) => T) {
  const { client } = useApiConfig();
  return useQuery<CustomProvidersResponse, Error, T>({
    queryKey: queryKeys.customProviders(),
    queryFn: () => client.get<CustomProvidersResponse>('/web/config/custom-providers'),
    select,
  });
}

const providersOf = (body: CustomProvidersResponse): CustomProviderInfo[] => body.providers;
// fork(claude-agent): an older server doesn't say, and let anyone change them.
const canManageOf = (body: CustomProvidersResponse): boolean => body.canManage !== false;

export function useCustomProvidersQuery() {
  return useCustomProvidersResponse(providersOf);
}

/** fork(claude-agent): whether the viewer may add, change or remove the org's providers (an org admin). */
export function useCanManageCustomProviders() {
  return useCustomProvidersResponse(canManageOf);
}

export function useSaveCustomProvider() {
  const { client } = useApiConfig();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SaveCustomProviderBody) =>
      client.post<{ ok: true; provider: CustomProviderInfo }>('/web/config/custom-providers', body),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.customProviders() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.availableModels() }),
      ]),
  });
}

export interface RemoveCustomProviderArgs {
  id: string;
}

export function useRemoveCustomProvider() {
  const { client } = useApiConfig();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: RemoveCustomProviderArgs) =>
      client.del<OkResponse>(`/web/config/custom-providers/${encodeURIComponent(id)}`),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.customProviders() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.availableModels() }),
      ]),
  });
}
