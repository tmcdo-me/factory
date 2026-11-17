import type { FilterBarField, FilterBarOption } from '@mastra/playground-ui/components/FilterBar';

import type { Limit } from '../services/rules';
import { limitedProviders } from '../services/rules';
import type { LinkedRepositoryPayload } from '../../workspaces/services/github';

/** A value `source.repository` can take, and the provider whose items carry it. */
export type SourceOption = FilterBarOption & { provider: string };

/** The values `source.repository` takes for the project's items: its linked GitHub repositories. */
export function sourceSuggestions({ repositories = [] }: { repositories?: LinkedRepositoryPayload[] }): SourceOption[] {
  const candidates: SourceOption[] = repositories.map(repository => ({
    value: repository.slug,
    provider: repository.provider ?? 'github',
  }));
  // Case doesn't matter to the rule, so one slug linked twice is one value.
  const seen = new Set<string>();
  return candidates.filter(candidate => {
    const key = `${candidate.provider}\0${candidate.value.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const hasProvider = (option: FilterBarOption): option is SourceOption =>
  'provider' in option && typeof option.provider === 'string';

/**
 * A field with its suggestions cut to the providers the conditions beside it allow, each value once:
 * the rule compares values regardless of provider or case.
 */
export function narrowSuggestions(field: FilterBarField, limits: readonly Limit[]): FilterBarField {
  if (!Array.isArray(field.suggestions)) return field;
  const providers = limitedProviders(limits);
  const seen = new Set<string>();
  return {
    ...field,
    suggestions: field.suggestions.filter(option => {
      if (providers && hasProvider(option) && !providers.has(option.provider)) return false;
      const key = option.value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
}
