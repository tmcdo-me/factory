import { Button } from '@mastra/playground-ui/components/Button';
import { Txt } from '@mastra/playground-ui/components/Txt';
import type { SourceControlRepository } from '../services/github';
import { OnboardingCodeHostRow } from './onboarding/OnboardingCodeHostRow';
import { OnboardingInset } from './onboarding/OnboardingInset';
import { OnboardingStepCard } from './onboarding/OnboardingStepCard';

export interface ProjectManagementFactoryStepProps {
  onContinue: () => void;
  /** The codebase step's repository, listed as an issue source once it has been picked. */
  repository?: SourceControlRepository;
  /** Whether that repository feeds the board; only an explicit `false` turns it off. */
  codeHostSync?: boolean;
  onCodeHostSyncChange?: (enabled: boolean) => void;
}

export function ProjectManagementFactoryStep({
  onContinue,
  repository,
  codeHostSync,
  onCodeHostSyncChange,
}: ProjectManagementFactoryStepProps) {
  const codeHostOn = repository !== undefined && codeHostSync !== false;
  return (
    <OnboardingStepCard
      section="project-management"
      headerEnd={
        <Txt variant="meta" tone="muted">
          Where new issues come from
        </Txt>
      }
      note={codeHostOn ? 'You’ll choose which issues to bring in after setup' : undefined}
      primary={
        <Button variant={codeHostOn ? 'primary' : 'ghost'} onClick={onContinue}>
          {codeHostOn ? 'Continue' : 'Skip for now'}
        </Button>
      }
    >
      {repository && (
        <OnboardingInset>
          <OnboardingCodeHostRow repository={repository} enabled={codeHostOn} onEnabledChange={onCodeHostSyncChange} />
        </OnboardingInset>
      )}
    </OnboardingStepCard>
  );
}
