// fork(claude-agent): how full the model's context is, for every runtime.
import { Popover, PopoverContent, PopoverTrigger } from '@mastra/playground-ui/components/Popover';
import { formatCompactTokens, TokenBudget, TokenBudgetDetail } from '@mastra/playground-ui/components/TokenBudget';
import { Txt } from '@mastra/playground-ui/components/Txt';

import { useChatRuntime } from '../../context/useChatRuntime';

/** Past this share of the window the meter turns to a warning. */
const NEARLY_FULL = 0.9;
/**
 * Its own hue, so it never reads as one of the memory budgets beside it. The detail row sets its
 * tone's color on its own root, hence the child selector.
 */
const CONTEXT_HUE = 'text-chart-cyan';
const CONTEXT_DETAIL_HUE = '[&>div]:text-chart-cyan';

const LABEL = 'Context window';
const DESCRIPTION = "The prompt of the model's latest call";

/**
 * Tokens in the model's context against its context window. The numbers come from the latest model
 * call (see `ContextUsage`), so they move when the agent compacts or a new session starts. Without a
 * known window (Mastra's catalog carries none; a custom provider's model has one only when set in
 * Settings or reported by the provider) it shows the tokens
 * alone rather than an invented limit.
 */
export function ContextWindowStatus() {
  const { context } = useChatRuntime();
  if (!context) return null;
  const { tokens, window } = context;
  const used = formatCompactTokens(tokens);

  if (!window) {
    return (
      <Popover>
        <PopoverTrigger
          variant="ghost"
          size="sm"
          aria-label={`${LABEL}: ${used}k tokens, limit unknown`}
          className="tabular-nums"
        >
          <span className="text-muted-foreground">
            {used}
            <span className="text-placeholder">k</span>
          </span>
        </PopoverTrigger>
        <PopoverContent align="start" className="flex flex-col gap-1.5" side="top">
          <Txt as="span" variant="meta" tone="ink">
            Context: {used}k tokens
          </Txt>
          <Txt variant="meta" tone="faint">
            {DESCRIPTION}. This model&apos;s context window isn&apos;t known, so there is no limit to show. For a custom
            provider&apos;s model, set it in Settings with the provider&apos;s models.
          </Txt>
        </PopoverContent>
      </Popover>
    );
  }

  const nearlyFull = tokens >= window * NEARLY_FULL;
  const tone = nearlyFull ? 'warning' : 'messages';
  const hue = nearlyFull ? undefined : CONTEXT_HUE;
  const detailHue = nearlyFull ? undefined : CONTEXT_DETAIL_HUE;
  return (
    <Popover>
      <PopoverTrigger variant="ghost" size="sm" aria-label={`${LABEL}: ${used} of ${formatCompactTokens(window)}k`}>
        <TokenBudget label={LABEL} threshold={window} tokens={tokens} tone={tone} className={hue} />
      </PopoverTrigger>
      <PopoverContent align="start" className="flex flex-col gap-3.5" side="top">
        <div className={detailHue}>
          <TokenBudgetDetail description={DESCRIPTION} label="Context" threshold={window} tokens={tokens} tone={tone} />
        </div>
      </PopoverContent>
    </Popover>
  );
}
