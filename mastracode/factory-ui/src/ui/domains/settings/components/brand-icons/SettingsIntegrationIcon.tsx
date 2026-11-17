import { GithubIcon } from '@mastra/playground-ui/icons/GithubIcon';
import { SlackIcon } from '@mastra/playground-ui/icons/SlackIcon';
import { cn } from '@mastra/playground-ui/utils/cn';

type SettingsIntegrationProvider = 'github' | 'slack';

export function SettingsIntegrationIcon({
  provider,
  className,
}: {
  provider: SettingsIntegrationProvider;
  className?: string;
}) {
  const iconClassName = cn('size-4 shrink-0', className);
  if (provider === 'slack') {
    return <SlackIcon aria-hidden="true" focusable="false" className={iconClassName} />;
  }
  return <GithubIcon aria-hidden="true" focusable="false" className={iconClassName} />;
}
