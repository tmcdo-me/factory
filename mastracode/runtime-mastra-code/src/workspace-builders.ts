// fork(claude-agent): slice 7k. Mastra Code's workspace pieces for Factory's workspace resolver
// (`RuntimeWorkspaceBuilders` in `@factory/agent-runtime`).
import type { RuntimeWorkspaceBuilders } from '@factory/agent-runtime';
import { SandboxFilesystem } from '@mastra/code-sdk/agents/sandbox-filesystem';
import { createMastraCodeWorkspaceTools } from '@mastra/code-sdk/agents/tool-availability';
import { DEFAULT_CONFIG_DIR } from '@mastra/code-sdk/constants';

export const mastraCodeWorkspaceBuilders: RuntimeWorkspaceBuilders = {
  createSandboxFilesystem: options => new SandboxFilesystem(options),
  workspaceTools: plansDir => createMastraCodeWorkspaceTools(false, plansDir),
  configDir: DEFAULT_CONFIG_DIR,
};
