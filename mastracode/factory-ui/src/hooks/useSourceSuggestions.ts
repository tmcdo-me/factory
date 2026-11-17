import { sourceSuggestions } from '../ui/domains/settings/components/sourceSuggestions';
import type { SourceOption } from '../ui/domains/settings/components/sourceSuggestions';
import { useFactoryQuery } from './useFactories';

/** The values `source.repository` takes for a Factory project's items: its linked repositories. */
export function useSourceSuggestions(factoryProjectId: string): SourceOption[] {
  const factory = useFactoryQuery(factoryProjectId);
  return sourceSuggestions({ repositories: factory.data?.repositories });
}
