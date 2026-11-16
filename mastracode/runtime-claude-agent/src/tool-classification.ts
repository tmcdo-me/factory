import type { ToolCategory, ToolExecutor } from '@factory/agent-runtime';

/** Factory's tools reach Claude through this in-process MCP server name. */
export const FACTORY_MCP_SERVER = 'factory';

const BUILT_IN: Record<string, ToolCategory> = {
  Bash: 'shell',
  BashOutput: 'shell',
  KillShell: 'shell',
  KillBash: 'shell',
  Read: 'file.read',
  Write: 'file.write',
  Edit: 'file.write',
  MultiEdit: 'file.write',
  NotebookEdit: 'file.write',
  Glob: 'search',
  Grep: 'search',
  LS: 'search',
  WebFetch: 'web',
  WebSearch: 'web',
};

/** Claude Code's subagent tool (named `Task`, `Agent` in newer releases). */
export const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);
export const TODO_TOOL = 'TodoWrite';

export function classifyClaudeTool(name: string): { category: ToolCategory; executor: ToolExecutor } {
  if (name.startsWith(`mcp__${FACTORY_MCP_SERVER}__`)) return { category: 'factory', executor: 'factory' };
  return { category: BUILT_IN[name] ?? 'other', executor: 'runtime' };
}

/** The name Factory tools are known by: `mcp__factory__submit_plan` → `submit_plan`. */
export function factoryToolName(name: string): string {
  const prefix = `mcp__${FACTORY_MCP_SERVER}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}
