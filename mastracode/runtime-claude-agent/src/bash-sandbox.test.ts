import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bashSandboxInstallScript, ensureBashSandbox } from './bash-sandbox';
import type { RunInSandbox } from './install';

/**
 * The install step run by a real `sh`, with its PATH pinned to a directory of stand-ins for the
 * sandbox's system tools: `sudo` (runs its command), `apt-get` (installs bubblewrap and socat by
 * putting stand-ins of them in that directory, and records how it was called).
 */
describe('ensureBashSandbox', () => {
  let root: string;
  let bin: string;
  let calls: string;
  beforeEach(async () => {
    root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'bash-sandbox-install-'));
    bin = join(root, 'bin');
    calls = join(root, 'calls');
    await mkdir(bin);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const tool = async (name: string, body: string) => {
    await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(bin, name), 0o755);
  };
  const run: RunInSandbox = script =>
    new Promise(resolve => {
      execFile('/bin/sh', ['-c', script], { env: {} }, (error, stdout, stderr) =>
        resolve({ exitCode: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
      );
    });
  const recorded = () => readFile(calls, 'utf8').catch(() => '');
  // `sudo -n env VAR=… apt-get …`: drop `-n`, `env` and the assignment, run the rest.
  const sudo = () =>
    tool(
      'sudo',
      `[ "$1" = -n ] && shift; [ "$#" -eq 0 ] || [ "$1" = true ] && exit 0; [ "$1" = env ] && shift 2; exec "$@"`,
    );
  const aptGet = (installs = true) =>
    tool(
      'apt-get',
      `echo "apt-get $*" >> '${calls}'\n` +
        `case "$*" in *install*) ${installs ? `printf '#!/bin/sh\\n' > '${bin}/bwrap'; printf '#!/bin/sh\\n' > '${bin}/socat'; /bin/chmod +x '${bin}/bwrap' '${bin}/socat'` : 'exit 100'};; esac`,
    );

  it('does nothing when bubblewrap and socat are there', async () => {
    await tool('bwrap', 'exit 0');
    await tool('socat', 'exit 0');
    await sudo();
    await aptGet();
    await ensureBashSandbox(run, { systemPath: bin });
    expect(await recorded()).toBe('');
  });

  it("installs the distribution's packages when they are missing", async () => {
    await sudo();
    await aptGet();
    await ensureBashSandbox(run, { systemPath: bin });
    expect(await recorded()).toBe('apt-get install -y -q --no-install-recommends bubblewrap socat\n');
  });

  it("refreshes the package index when the install can't find them", async () => {
    await sudo();
    // The first install fails (a stale index), the update succeeds, the second install works.
    await tool(
      'apt-get',
      `echo "apt-get $*" >> '${calls}'\n` +
        `case "$*" in *update*) /usr/bin/touch '${root}/updated';; *install*) [ -e '${root}/updated' ] || exit 100; printf '#!/bin/sh\\n' > '${bin}/bwrap'; printf '#!/bin/sh\\n' > '${bin}/socat'; /bin/chmod +x '${bin}/bwrap' '${bin}/socat';; esac`,
    );
    await ensureBashSandbox(run, { systemPath: bin });
    expect((await recorded()).split('\n').filter(Boolean)).toEqual([
      'apt-get install -y -q --no-install-recommends bubblewrap socat',
      'apt-get update -q',
      'apt-get install -y -q --no-install-recommends bubblewrap socat',
    ]);
  });

  it("fails, saying why and how to opt out, when it can't install them", async () => {
    // No sudo: nothing is installed.
    await aptGet();
    await expect(ensureBashSandbox(run, { systemPath: bin })).rejects.toThrow(
      /needs bubblewrap socat, and this sandbox can't install them.*FACTORY_CLAUDE_AGENT_BASH_SANDBOX=0/s,
    );
    expect(await recorded()).toBe('');
    // The packages don't install.
    await sudo();
    await aptGet(false);
    await expect(ensureBashSandbox(run, { systemPath: bin })).rejects.toThrow(/could not be set up/);
  });

  it('takes only a plain PATH', () => {
    expect(() => bashSandboxInstallScript({ systemPath: "/bin'; rm -rf ~; '" })).toThrow(/plain PATH/);
  });
});
