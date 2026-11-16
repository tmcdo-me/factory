import { useChatRuntime } from '../../context/useChatRuntime';

const statusItem = 'inline-flex items-center gap-1 text-muted-foreground [&_svg]:text-placeholder';

export function RuntimeActivity() {
  const runtime = useChatRuntime();
  if (runtime.tokensPerSec <= 0) return null;
  return <span className={statusItem}>{runtime.tokensPerSec} tok/s</span>;
}
