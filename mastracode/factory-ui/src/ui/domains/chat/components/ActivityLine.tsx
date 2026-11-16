import { useState } from 'react';

import { useChatRuntime } from '../context/useChatRuntime';
import { useChatTranscript } from '../context/useChatTranscript';
import { lineState, runActivity, spokenByStretch } from '../services/run-activity';
import { RunLine } from './RunLine';

/**
 * The agent's state for the whole run: what it is doing while it works, a held prompt while it
 * waits on the user, then done or error for a beat before the line fades out. A run already over
 * when the line mounts, or whose exit has faded, draws nothing until another run starts.
 */
export function ActivityLine({ stretchLive }: { stretchLive: boolean }) {
  const { busy, transcript, initialHistoryReady } = useChatTranscript();
  const runtime = useChatRuntime();
  const activity = runActivity(transcript.entries, transcript.lastEntryBeforeRun);
  const live = busy || activity === 'waiting';
  const run = runtime.runsStarted;
  // fork(claude-agent): the runs already over are counted once the history has loaded (Factory's
  // transcript arrives with them), so opening an idle session never flashes its last run's end.
  const [baseline, setBaseline] = useState<{ settledRun?: number }>();
  if (!baseline && initialHistoryReady) setBaseline({ settledRun: live ? undefined : run });
  if (!baseline) return null;
  const state = lineState(activity, busy);
  if (state === 'writing' || (stretchLive && spokenByStretch(state))) return null;
  if (!live && baseline.settledRun === run) return null;
  return <RunLine state={state} live={live} onSettled={() => setBaseline({ settledRun: run })} />;
}
