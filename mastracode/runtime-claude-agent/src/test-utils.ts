// Test helpers; not exported from the package.
import { createRequire } from 'node:module';

import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';

/**
 * Talks to an SDK MCP server the way Claude Code does: over MCP, naming the calling `tool_use` in
 * `_meta`. The MCP SDK is the Agent SDK's own dependency, so it is loaded from there.
 */
export async function mcpClient(server: McpSdkServerConfigWithInstance) {
  const sdkRequire = createRequire(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'));
  const { Client } = sdkRequire('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = sdkRequire('@modelcontextprotocol/sdk/inMemory.js');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverSide);
  const client = new Client({ name: 'claude-code', version: '0' });
  await client.connect(clientSide);
  return {
    listTools: async (): Promise<{ name: string; inputSchema: Record<string, unknown> }[]> =>
      (await client.listTools()).tools,
    call: async (name: string, args: Record<string, unknown>, toolUseId?: string) =>
      (await client.callTool({
        name,
        arguments: args,
        ...(toolUseId ? { _meta: { 'claudecode/toolUseId': toolUseId } } : {}),
      })) as { isError?: boolean; content: { type: string; text: string }[] },
  };
}
