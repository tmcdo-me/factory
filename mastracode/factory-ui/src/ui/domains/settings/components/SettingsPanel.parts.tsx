import type { AgentControllerSessionSettings } from '@mastra/client-js';
import { SegmentedControl, SegmentedControlItem } from '@mastra/playground-ui/components/SegmentedControl';
import { Switch } from '@mastra/playground-ui/components/Switch';
import { ThemeToggle } from '@mastra/playground-ui/components/ThemeToggle';
import { useState } from 'react';

import { loadDoneSound, playDoneSound, saveDoneSound } from '../services/doneSound';
import type { DoneSound } from '../services/doneSound';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';

import { SettingsSubsection } from './SettingsSubsection';
import { SoundPicker } from './SettingsFields';

export function GeneralSettings() {
  const [doneSound, setDoneSound] = useState<DoneSound>(() => loadDoneSound());
  const changeDoneSound = (next: DoneSound) => {
    setDoneSound(next);
    saveDoneSound(next);

    playDoneSound(next);
  };
  return (
    <SettingsSubsection scope="personal" title="General" description="Stored in this browser.">
      <SettingsContainer>
        <SettingsRow label="Theme" description="Color scheme for the interface.">
          <ThemeToggle />
        </SettingsRow>
        <SettingsRow label="Completion sound" description="Played when an agent run finishes.">
          <SoundPicker value={doneSound} onChange={changeDoneSound} />
        </SettingsRow>
      </SettingsContainer>
    </SettingsSubsection>
  );
}

interface BehaviorSettingsProps {
  settings: AgentControllerSessionSettings | null;
  onBehaviorChange: (updates: Partial<AgentControllerSessionSettings>) => Promise<unknown>;
}

export function BehaviorSettings({ settings, onBehaviorChange }: BehaviorSettingsProps) {
  const notificationMode = settings?.notifications ?? 'off';
  return (
    <SettingsSubsection
      scope="factory"
      title="General"
      description="Shared by everyone working in this Factory. Smart editing resets when the server restarts."
    >
      <SettingsContainer>
        <SettingsRow label="Smart editing" description="Use AST-aware edits when available.">
          <Toggle
            ariaLabel="Smart editing"
            checked={!!settings?.smartEditing}
            disabled={!settings}
            onChange={v => onBehaviorChange({ smartEditing: v })}
          />
        </SettingsRow>
        <SettingsRow label="Notifications" description="How completion alerts are delivered.">
          <SegmentedControl
            aria-label="Notifications"
            value={notificationMode}
            disabled={!settings}
            onValueChange={v => onBehaviorChange({ notifications: v })}
          >
            <SegmentedControlItem value="off">Off</SegmentedControlItem>
            <SegmentedControlItem value="bell">Bell</SegmentedControlItem>
            <SegmentedControlItem value="system">System</SegmentedControlItem>
            <SegmentedControlItem value="both">Both</SegmentedControlItem>
          </SegmentedControl>
        </SettingsRow>
      </SettingsContainer>
    </SettingsSubsection>
  );
}

function Toggle({
  checked,
  ariaLabel,
  disabled,
  onChange,
}: {
  checked: boolean;
  ariaLabel: string;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <Switch aria-label={ariaLabel} checked={checked} disabled={disabled} onCheckedChange={value => onChange(value)} />
  );
}
