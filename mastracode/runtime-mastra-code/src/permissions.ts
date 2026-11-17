import type { PermissionPolicy, PermissionRules } from '@mastra/core/agent-controller';

/** The part of a Mastra Code session that holds its tool permission rules. */
export interface MastraCodePermissionsSession {
  readonly identity: { getId(): string };
  readonly permissions: {
    getRules(): PermissionRules;
    setForTool(args: { toolName: string; policy: PermissionPolicy }): Promise<void>;
  };
}

/**
 * Let these tools run without asking in a Mastra Code session. Tools the host adds fall in Mastra
 * Code's `mcp` category, whose default policy is `ask`, so each needs a per-session `allow`. A
 * person's own choices win: a per-tool policy is never overwritten, and an explicit `mcp` category
 * policy leaves everything alone.
 */
export async function allowToolsWithoutAsking(
  session: MastraCodePermissionsSession,
  toolNames: readonly string[],
): Promise<void> {
  if (session.permissions.getRules().categories.mcp !== undefined) return;
  for (const toolName of toolNames) {
    if (session.permissions.getRules().tools[toolName] !== undefined) continue;
    await session.permissions.setForTool({ toolName, policy: 'allow' });
  }
}
