import type { SourceControlRepository } from '../../services/github';
import { OnboardingDoneRow } from './OnboardingStepRow';
import type { ChangeSectionProps } from './OnboardingStepRow';

export interface OnboardingWorkDoneRowProps extends ChangeSectionProps {
  repository?: SourceControlRepository;
  codeHostSync?: boolean;
}

/** Work once the user moved past it: the codebase repository when it feeds the board. */
export function OnboardingWorkDoneRow({ repository, codeHostSync, ...change }: OnboardingWorkDoneRowProps) {
  return (
    <OnboardingDoneRow
      section="project-management"
      value={repository && codeHostSync !== false ? 'GitHub' : 'Set up later'}
      {...change}
    />
  );
}
