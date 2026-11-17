import { GithubIcon } from '@mastra/playground-ui/icons/GithubIcon';
import { SlackIcon } from '@mastra/playground-ui/icons/SlackIcon';
import { useState } from 'react';

import type { FactoryModelScope } from '../../../../workspaces/services/github';
import { FactoryDefaultModel } from '../defaults/FactoryDefaultModel';
import { PersonalDefaultModel } from '../defaults/PersonalDefaultModel';
import { ProviderList } from '../providers/ProviderList';
import { DefaultsCard } from './DefaultsCard';
import { LaneCard, LaneSource } from './LaneCard';
import { MODEL_ROUTES, defaultsInUse } from './model-routes';
import { RoutingMapLayout, createConnectorAnchors } from './RoutingMapLayout';
import { IconWindow } from '@mastra/playground-ui/icons/central/IconWindow';

export function ModelRoutingMap({ factoryId, modelScope }: { factoryId: string; modelScope: FactoryModelScope }) {
  const routes = MODEL_ROUTES[modelScope];
  const [anchors] = useState(createConnectorAnchors);

  return (
    <RoutingMapLayout
      anchors={anchors}
      routes={routes}
      lanes={
        <>
          <LaneCard lane="chats" destination={routes.chats} anchorRef={anchors.chats}>
            <LaneSource label="Web app">
              <IconWindow />
            </LaneSource>
            <LaneSource label="Slack">
              <SlackIcon />
            </LaneSource>
          </LaneCard>
          <LaneCard lane="runs" destination={routes.runs} anchorRef={anchors.runs}>
            <LaneSource label="GitHub">
              <GithubIcon />
            </LaneSource>
          </LaneCard>
        </>
      }
      defaults={
        <>
          <DefaultsCard
            defaults="personal"
            inUse={defaultsInUse(modelScope, 'personal')}
            anchorRef={anchors.personal}
            model={<PersonalDefaultModel />}
            providers={<ProviderList credentialScope="user" />}
          />
          <DefaultsCard
            defaults="factory"
            inUse={defaultsInUse(modelScope, 'factory')}
            anchorRef={anchors.factory}
            model={<FactoryDefaultModel factoryId={factoryId} />}
            providers={<ProviderList credentialScope="org" />}
          />
        </>
      }
    />
  );
}
