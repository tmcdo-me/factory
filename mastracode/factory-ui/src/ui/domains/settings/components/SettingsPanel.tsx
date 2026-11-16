import type { AgentControllerSessionSettings } from '@mastra/client-js';
import { useParams } from 'react-router';
import { toast } from '@mastra/playground-ui/components/Toaster';

import { useChatSessionContext } from '../../chat/context/useChatSessionContext';
import { useSettingsSection } from '../hooks/useSettingsSection';
import { useAgentControllerSettings } from '../../../../hooks/useAgentControllerSettings';
import {
  SettingsUpdateVerificationError,
  useUpdateAgentControllerSettingsMutation,
} from '../../../../hooks/useUpdateAgentControllerSettingsMutation';
import { AGENT_CONTROLLER_ID } from '../../chat/services/constants';
import { DebugSection } from './DebugSection';
import { ConnectionsSection } from './ConnectionsSection';
import { AccountSettingsSection } from './AccountSettingsSection';
import { ConnectToolsSection } from './ConnectToolsSection';
import { FactoryManagementSection } from './FactoryManagementSection';
import { IntakeRoutesSection } from './IntakeRoutesSection';
import { IntakeSection } from './IntakeSection';
import { RepositoriesSection } from './RepositoriesSection';
import { BehaviorSettings, GeneralSettings } from './SettingsPanel.parts';
import { ModelsSettings } from './models/ModelsSettings';

function getSettingsUpdateErrorMessage(error: unknown): string {
  if (error instanceof SettingsUpdateVerificationError) return error.message;
  if (error instanceof Error) return `Failed to update settings: ${error.message}`;
  return 'Failed to update settings';
}

export function SettingsPanel() {
  const section = useSettingsSection();
  const { factoryId } = useParams<{ factoryId: string }>();
  const { sessionId: chatSessionId, resourceEnabled, baseUrl } = useChatSessionContext();
  const hookArgs = {
    agentControllerId: AGENT_CONTROLLER_ID,
    sessionId: chatSessionId,
    baseUrl,
    enabled: resourceEnabled,
  };

  const settingsQuery = useAgentControllerSettings(hookArgs);
  const updateSettingsMutation = useUpdateAgentControllerSettingsMutation(hookArgs);
  const settings = settingsQuery.data ?? null;

  const onBehaviorChange = (updates: Partial<AgentControllerSessionSettings>) => {
    if (!settings) return Promise.resolve();

    return updateSettingsMutation
      .mutateAsync(updates)
      .catch(error => toast.error(getSettingsUpdateErrorMessage(error)));
  };

  return (
    <>
      {section === 'account' && <AccountSettingsSection />}
      {section === 'preferences' && <GeneralSettings />}
      {section === 'factory' && <FactoryManagementSection />}
      {section === 'connections' && <ConnectionsSection />}
      {section === 'repositories' && <RepositoriesSection />}
      {section === 'intake' && (
        <div className="flex flex-col gap-8">
          <IntakeSection />
          <IntakeRoutesSection factoryId={factoryId} />
        </div>
      )}
      {section === 'models' && factoryId && <ModelsSettings factoryId={factoryId} />}
      {section === 'tools' && <ConnectToolsSection />}
      {section === 'debug' && <DebugSection />}
      {section === 'behavior' && <BehaviorSettings settings={settings} onBehaviorChange={onBehaviorChange} />}
    </>
  );
}
