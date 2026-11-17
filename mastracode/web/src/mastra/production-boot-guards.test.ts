import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as factoryModule from '@mastra/factory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const factoryConfigs = vi.hoisted(() => [] as Array<ConstructorParameters<typeof factoryModule.MastraFactory>[0]>);
vi.mock('@mastra/factory', async importOriginal => {
  const actual = await importOriginal<typeof factoryModule>();
  // Records the config the entry builds. Boot itself is skipped: production
  // mode needs DATABASE_URL, and these tests check what the entry decides to
  // configure before the database is ever touched.
  class RecordedMastraFactory extends actual.MastraFactory {
    constructor(config: ConstructorParameters<typeof actual.MastraFactory>[0]) {
      super(config);
      factoryConfigs.push(config);
    }
    override async prepare() {
      return {} as Awaited<ReturnType<factoryModule.MastraFactory['prepare']>>;
    }
    override async finalize() {}
  }
  return { ...actual, MastraFactory: RecordedMastraFactory };
});

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

/**
 * Outside development and tests the entry refuses to boot when a security
 * requirement is missing, the same way it already does for DATABASE_URL:
 * credential encryption and an isolated sandbox provider each need either
 * their configuration or an explicit opt-out.
 */
describe('production boot guards (src/mastra/index.ts)', () => {
  beforeEach(() => {
    for (const name of [
      'MASTRACODE_AUTH_DISABLED',
      'WORKOS_API_KEY',
      'WORKOS_CLIENT_ID',
      'WORKOS_COOKIE_PASSWORD',
      'MASTRA_SHARED_API_URL',
      'MASTRA_PLATFORM_SECRET_KEY',
      'MASTRA_PLATFORM_ACCESS_TOKEN',
      'MASTRA_CLOUD_ACCESS_TOKEN',
      'MASTRA_ENVIRONMENT_ID',
      'APP_DATABASE_URL',
      'REDIS_URL',
      'GITHUB_APP_ID',
      'GITHUB_APP_PRIVATE_KEY',
      'GITHUB_APP_CLIENT_ID',
      'GITHUB_APP_CLIENT_SECRET',
      'GITHUB_APP_SLUG',
      'GITHUB_APP_WEBHOOK_SECRET',
      'SLACK_APP_SIGNING_SECRET',
      'E2B_API_KEY',
      'SANDBOX_PROVIDER',
      'FACTORY_SANDBOX_PROVIDER',
      'FACTORY_CREDENTIAL_ENCRYPTION',
      'FACTORY_CREDENTIAL_ENCRYPTION_KEY',
      'FACTORY_CREDENTIAL_ENCRYPTION_KEY_ID',
      'FACTORY_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS',
      'FACTORY_DATABASE',
      'FACTORY_DEPLOYMENT',
      'SPRITES_TOKEN',
      'FACTORY_BROWSER',
    ]) {
      vi.stubEnv(name, '');
    }
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_URL', 'postgres://factory:factory@127.0.0.1:1/factory');
    vi.stubEnv('MASTRA_PROJECT_ID', 'test-project');
    factoryConfigs.length = 0;
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function bootedConfig() {
    await import('./index.js');
    expect(factoryConfigs).toHaveLength(1);
    return factoryConfigs[0]!;
  }

  it('refuses to boot without a credential encryption key', { timeout: 60_000 }, async () => {
    vi.stubEnv('E2B_API_KEY', 'e2b-key');

    await expect(import('./index.js')).rejects.toThrow(/FACTORY_CREDENTIAL_ENCRYPTION_KEY is required/);
    expect(factoryConfigs).toHaveLength(0);
  });

  it('refuses to boot when sandboxes would fall back to the host', { timeout: 60_000 }, async () => {
    vi.stubEnv('FACTORY_CREDENTIAL_ENCRYPTION_KEY', ENCRYPTION_KEY);

    await expect(import('./index.js')).rejects.toThrow(/FACTORY_SANDBOX_PROVIDER=local/);
    expect(factoryConfigs).toHaveLength(0);
  });

  it('boots with encryption and an isolated provider configured', { timeout: 60_000 }, async () => {
    vi.stubEnv('FACTORY_CREDENTIAL_ENCRYPTION_KEY', ENCRYPTION_KEY);
    vi.stubEnv('E2B_API_KEY', 'e2b-key');

    const config = await bootedConfig();

    expect(config.secretEncryption).toBeDefined();
    expect(config.sandbox).toMatchObject({ provider: 'e2b' });
  });

  it('boots with plaintext credentials and host sandboxes when both are opted into', { timeout: 60_000 }, async () => {
    vi.stubEnv('FACTORY_CREDENTIAL_ENCRYPTION', 'plaintext');
    vi.stubEnv('FACTORY_SANDBOX_PROVIDER', 'local');

    const config = await bootedConfig();

    expect(config.secretEncryption).toBeUndefined();
    expect(config.sandbox).toMatchObject({ provider: 'local' });
  });

  // A self-hosted server on one machine (`pnpm start` under a LaunchAgent) keeps its data in the
  // local libSQL file, as `pnpm dev` does; production refused to boot without Postgres.
  it(
    'refuses to boot without a database, unless the local libSQL file is opted into',
    { timeout: 60_000 },
    async () => {
      vi.stubEnv('DATABASE_URL', '');
      vi.stubEnv('FACTORY_CREDENTIAL_ENCRYPTION_KEY', ENCRYPTION_KEY);
      vi.stubEnv('FACTORY_SANDBOX_PROVIDER', 'local');

      await expect(import('./index.js')).rejects.toThrow(/FACTORY_DATABASE=libsql/);
      expect(factoryConfigs).toHaveLength(0);

      vi.resetModules();
      vi.stubEnv('FACTORY_DATABASE', 'libsql');
      const config = await bootedConfig();

      // A fresh module graph per import, so the class is compared by name.
      expect(config.storage?.constructor.name).toBe('LibSQLFactoryStorage');
      expect(config.vector).toBeUndefined();
    },
  );

  // A container or remote deployment (fork/deploy/) runs every session on a Sprite: the server host
  // holds the database and nothing an agent runs.
  describe('a container deployment (FACTORY_DEPLOYMENT=container)', () => {
    let dataDir: string;
    beforeEach(() => {
      // The libSQL file goes in a throwaway app data directory, never the machine's own.
      dataDir = mkdtempSync(join(tmpdir(), 'factory-container-boot-'));
      vi.stubEnv('MASTRA_APP_DATA_DIR', dataDir);
      vi.stubEnv('MASTRA_DB_PATH', join(dataDir, 'mastra.db'));
      vi.stubEnv('FACTORY_DEPLOYMENT', 'container');
      vi.stubEnv('FACTORY_CREDENTIAL_ENCRYPTION_KEY', ENCRYPTION_KEY);
      vi.stubEnv('DATABASE_URL', '');
      vi.stubEnv('FACTORY_DATABASE', 'libsql');
    });
    afterEach(() => {
      rmSync(dataDir, { recursive: true, force: true });
    });

    it('refuses to boot on the local sandbox provider', { timeout: 60_000 }, async () => {
      vi.stubEnv('FACTORY_SANDBOX_PROVIDER', 'local');

      await expect(import('./index.js')).rejects.toThrow(
        /FACTORY_DEPLOYMENT=container runs every session on Fly\.io Sprites.*FACTORY_SANDBOX_PROVIDER is "local"/,
      );
      expect(factoryConfigs).toHaveLength(0);
    });

    it('refuses to boot on another provider, or none, even in development', { timeout: 60_000 }, async () => {
      vi.stubEnv('E2B_API_KEY', 'e2b-key');
      await expect(import('./index.js')).rejects.toThrow(/FACTORY_SANDBOX_PROVIDER is unset/);

      vi.resetModules();
      vi.stubEnv('E2B_API_KEY', '');
      vi.stubEnv('NODE_ENV', 'development');
      await expect(import('./index.js')).rejects.toThrow(/FACTORY_SANDBOX_PROVIDER=sprites with SPRITES_TOKEN/);
      expect(factoryConfigs).toHaveLength(0);
    });

    it('refuses the local browser, which runs on the server host', { timeout: 60_000 }, async () => {
      vi.stubEnv('FACTORY_SANDBOX_PROVIDER', 'sprites');
      vi.stubEnv('SPRITES_TOKEN', 'fly-sprites-token');
      vi.stubEnv('FACTORY_BROWSER', 'local');

      await expect(import('./index.js')).rejects.toThrow(/refuses FACTORY_BROWSER=local/);
      expect(factoryConfigs).toHaveLength(0);
    });

    it('refuses a deployment it does not know', { timeout: 60_000 }, async () => {
      vi.stubEnv('FACTORY_DEPLOYMENT', 'kubernetes');
      vi.stubEnv('FACTORY_SANDBOX_PROVIDER', 'sprites');
      vi.stubEnv('SPRITES_TOKEN', 'fly-sprites-token');

      await expect(import('./index.js')).rejects.toThrow(/FACTORY_DEPLOYMENT must be container or unset/);
      expect(factoryConfigs).toHaveLength(0);
    });

    it('boots on Sprites with the local libSQL file', { timeout: 60_000 }, async () => {
      vi.stubEnv('FACTORY_SANDBOX_PROVIDER', 'sprites');
      vi.stubEnv('SPRITES_TOKEN', 'fly-sprites-token');

      const config = await bootedConfig();

      expect(config.sandbox).toMatchObject({ provider: 'sprites' });
      expect(config.storage?.constructor.name).toBe('LibSQLFactoryStorage');
    });
  });

  it('keeps the development fallbacks', { timeout: 60_000 }, async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('DATABASE_URL', '');

    const config = await bootedConfig();

    expect(config.secretEncryption).toBeUndefined();
    expect(config.sandbox).toMatchObject({ provider: 'local' });
  });
});
