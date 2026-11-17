/**
 * The intake writes setup makes once the Factory project exists and its repository is linked, with
 * the Work step's switch on. With the switch off, setup calls none of this.
 */
import { fetchIntakeConfig, saveIntakeSelection, selectIntakeSource } from '../../factory/services/intake';
import type { SourceControlRepository } from './github';

/** Select the codebase step's repository as an issue source. */
export async function applyCodeHostIntake(
  baseUrl: string,
  { repository }: { factoryProjectId: string; repository: SourceControlRepository },
): Promise<void> {
  const config = await fetchIntakeConfig(baseUrl);
  const current = config.github;
  const selection = selectIntakeSource(current, repository.fullName);
  if (selection !== current) await saveIntakeSelection(baseUrl, 'github', selection);
}
