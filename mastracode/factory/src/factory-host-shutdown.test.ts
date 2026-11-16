import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Mastra } from '@mastra/core/mastra';
import { LibSQLFactoryStorage } from '@mastra/libsql';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { MastraFactory } from './factory.js';
import type { FactoryIntegration } from './integrations/base.js';
import { createFactorySecretEncryption } from './secret-encryption.js';

vi.setConfig({ testTimeout: 30_000 });
const secretEncryption = createFactorySecretEncryption({ primary: { id: 'test', key: Buffer.alloc(32, 7) } });

/**
 * The server's SIGTERM/SIGINT handler (`@mastra/deployer`'s `createNodeServer`) drains HTTP and then
 * calls `mastra.shutdown()`. That is all a LaunchAgent restart (`launchctl kickstart -k`) or a deploy
 * reaches, so Factory's own teardown has to run from there: before, nothing called it, and Claude
 * Code processes, the Claude Agent host lease, the dispatcher and channel transports were left to die
 * with the process.
 */
describe('Stopping the Factory server', () => {
  async function bootServer(integrations: FactoryIntegration[]) {
    vi.stubEnv('MASTRA_PLATFORM_ACCESS_TOKEN', '');
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const dir = mkdtempSync(join(tmpdir(), 'factory-host-shutdown-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const storage = new LibSQLFactoryStorage({ id: 'host-shutdown', url: `file:${join(dir, 'factory.db')}` });
    const factory = new MastraFactory({ storage, auth: null, mcp: false, secretEncryption, integrations });
    // What the web entry does: construct the server's Mastra from the prepared args, then finalize.
    const mastra = new Mastra(await factory.prepare());
    await factory.finalize();
    return { factory, mastra };
  }

  it("closes a chat platform's connection when the server shuts down", async () => {
    const events: string[] = [];
    const adapter = {
      name: 'chat',
      initialize: async () => {},
      disconnect: vi.fn(async () => {
        events.push('chat disconnected');
      }),
    };
    const { mastra } = await bootServer([
      {
        id: 'chat-platform',
        routes: () => [],
        diagnostics: () => ({}),
        channels: () => ({ adapters: { chat: { adapter: adapter as never } } }),
      },
    ]);
    const storage = mastra.getStorage()!;
    const closeStorage = storage.close?.bind(storage);
    vi.spyOn(storage, 'close').mockImplementation(async () => {
      events.push('storage closed');
      await closeStorage?.();
    });

    // What the server runs on SIGTERM.
    await mastra.shutdown({ drainTimeout: 0 });

    expect(adapter.disconnect).toHaveBeenCalledOnce();
    // Factory stops while its storage is still open (releasing the Claude Agent host lease and ending
    // runs in flight write to it).
    expect(events).toEqual(['chat disconnected', 'storage closed']);
  });
});
