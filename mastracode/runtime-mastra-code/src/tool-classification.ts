import type { ToolCategory, ToolExecutor } from '@factory/agent-runtime';

/**
 * Mastra Code's own tools (workspace, process, LSP, task and skill tools). Names match
 * `MC_TOOLS` in `@mastra/code-sdk/tool-names` plus core built-ins; anything else a Mastra Code
 * session calls is a tool Factory supplied.
 */
const RUNTIME_TOOLS: Record<string, ToolCategory> = {
  view: 'file.read',
  file_stat: 'file.read',
  find_files: 'search',
  search_content: 'search',
  lsp_inspect: 'search',
  write_file: 'file.write',
  string_replace_lsp: 'file.write',
  ast_smart_edit: 'file.write',
  delete_file: 'file.write',
  mkdir: 'file.write',
  execute_command: 'shell',
  get_process_output: 'shell',
  kill_process: 'shell',
  web_search: 'web',
  web_fetch: 'web',
  skill: 'other',
  task_create: 'other',
  task_update: 'other',
  task_list: 'other',
  task_get: 'other',
  notification_inbox: 'other',
};

export interface ToolClass {
  category: ToolCategory;
  executor: ToolExecutor;
}

export function classifyMastraCodeTool(name: string): ToolClass {
  const category = RUNTIME_TOOLS[name];
  if (category) return { category, executor: 'runtime' };
  return { category: 'factory', executor: 'factory' };
}
