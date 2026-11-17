// fork(claude-agent): the sidebar's way to the sessions waiting on a person, with how many wait.
import { Badge } from '@mastra/playground-ui/components/Badge';
import { Sidebar } from '@mastra/playground-ui/components/Sidebar';
import { IconArrowInbox } from '@mastra/playground-ui/icons/central/IconArrowInbox';
import { NavLink, useLocation } from 'react-router';

import { useOverlays } from '../../../../lib/overlays';
import { useWaitingSessions } from '../../hooks/useWaitingSessions';

export function SidebarWaitingLink({ factoryId }: { factoryId: string }) {
  const overlays = useOverlays();
  const { pathname } = useLocation();
  const count = useWaitingSessions(factoryId).data?.length ?? 0;
  const to = `/factories/${factoryId}/waiting`;

  return (
    <Sidebar.NavLink
      link={{ name: 'Waiting', url: to }}
      isActive={pathname === to}
      render={
        <NavLink
          to={to}
          aria-label={count > 0 ? `Waiting, ${count}` : 'Waiting'}
          onClick={() => overlays.close('sidebar')}
        >
          <IconArrowInbox />
          <Sidebar.NavLabel className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate">Waiting</span>
            {count > 0 ? (
              <Badge variant="orange" size="sm">
                {count}
              </Badge>
            ) : null}
          </Sidebar.NavLabel>
        </NavLink>
      }
    />
  );
}
