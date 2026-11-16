// fork(claude-agent): where a person sees every card session waiting on them and answers it, without opening it.
import { PageLayout } from '@mastra/playground-ui/components/PageLayout';
import { Txt } from '@mastra/playground-ui/components/Txt';

import { useSidebarHeaderSlots } from '../domains/chat/components/useSidebarHeaderSlots';
import { WaitingSessions } from '../domains/factory/components/waiting/WaitingSessions';
import { useActiveFactory } from '../domains/workspaces/components/FactoryLayout';

export function WaitingPage() {
  const factory = useActiveFactory();
  const slots = useSidebarHeaderSlots();
  return (
    <PageLayout variant="fit" {...slots}>
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-col gap-4 overflow-y-auto p-4">
        <header className="flex flex-col gap-1">
          <Txt as="h1" variant="title" tone="ink">
            Waiting on you
          </Txt>
          <Txt variant="caption" tone="muted">
            Runs that asked a question or submitted a plan. Answer here, or open the session.
          </Txt>
        </header>
        <WaitingSessions key={factory.id} factoryId={factory.id} />
      </div>
    </PageLayout>
  );
}
