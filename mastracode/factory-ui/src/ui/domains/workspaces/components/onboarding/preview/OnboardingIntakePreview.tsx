import { Metadata } from '@mastra/playground-ui/components/Metadata';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { GithubIcon } from '@mastra/playground-ui/icons/GithubIcon';
import { IconCircleDashed } from '@mastra/playground-ui/icons/central/IconCircleDashed';
import type { SourceControlRepository } from '../../../services/github';
import { SketchLabel } from './SketchLabel';
import { IconCheckmark2Medium } from '@mastra/playground-ui/icons/central/IconCheckmark2Medium';
import { IconCodeBrackets } from '@mastra/playground-ui/icons/central/IconCodeBrackets';

const EXAMPLE = {
  example: 'Add team invitations',
  id: '#412',
  previousId: '#411',
  previousExample: 'Improve review notes',
  kind: 'Issue',
};

export function OnboardingIntakePreview({
  repository,
}: {
  /** The codebase step's pick, which reads as Connected: the repository is what feeds the board. */
  repository?: SourceControlRepository;
}) {
  const name = 'GitHub';
  const connected = repository !== undefined;
  const Icon = GithubIcon;
  const { example, id, previousId, previousExample, kind } = EXAMPLE;
  return (
    <section aria-label="Work intake preview" className="relative h-full">
      <SketchLabel x={28} y={24} width={148}>
        <div className="flex items-center gap-2">
          <Icon className="size-3.5 shrink-0" />
          <Txt variant="meta">{name}</Txt>
        </div>
      </SketchLabel>
      <SketchLabel x={282} y={24} width={90}>
        <div className="text-right">
          <Txt variant="meta" tone="muted">
            {connected ? 'Connected' : 'Example'}
          </Txt>
        </div>
      </SketchLabel>
      <SketchLabel x={38} y={58} width={128}>
        <Txt variant="meta" tone="muted">
          <Metadata>
            <Metadata.Item>{id}</Metadata.Item>
            <Metadata.Item>{kind}</Metadata.Item>
          </Metadata>
        </Txt>
        <Txt variant="caption" tone="muted" className="mt-2">
          {example}
        </Txt>
      </SketchLabel>
      <SketchLabel x={115} y={133} width={98}>
        <Txt variant="meta" tone="muted">
          Bring into your board
        </Txt>
      </SketchLabel>
      <SketchLabel x={28} y={162} width={104}>
        <div className="flex items-center gap-1.5">
          <IconCircleDashed className="text-muted-foreground size-3" />
          <Txt variant="meta" tone="muted">
            To do
          </Txt>
        </div>
      </SketchLabel>
      <SketchLabel x={148} y={162} width={104}>
        <div className="flex items-center gap-1.5">
          <IconCodeBrackets className="text-muted-foreground size-3" />
          <Txt variant="meta" tone="muted">
            Build
          </Txt>
        </div>
      </SketchLabel>
      <SketchLabel x={268} y={162} width={104}>
        <div className="flex items-center gap-1.5">
          <IconCheckmark2Medium className="text-muted-foreground size-3" />
          <Txt variant="meta" tone="muted">
            Review
          </Txt>
        </div>
      </SketchLabel>
      {[
        { id, title: example },
        { id: previousId, title: previousExample },
      ].map((card, index) => (
        <div key={index} className="onboarding-ticket absolute min-w-0" data-ticket={index + 1}>
          <div className="flex items-center gap-1.5">
            <Icon className="text-muted-foreground size-3 shrink-0" />
            <Txt variant="meta" tone="muted">
              {card.id}
            </Txt>
          </div>
          <Txt variant="caption" tone="muted" className="mt-1.5">
            {card.title}
          </Txt>
        </div>
      ))}
      <SketchLabel x={28} y={302} width={344}>
        <Txt variant="meta" tone="muted">
          Choose what to bring in after setup.
        </Txt>
      </SketchLabel>
    </section>
  );
}
