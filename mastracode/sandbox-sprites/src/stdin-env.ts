/**
 * Environment for a process in a Sprite, delivered over its stdin rather than in the exec request.
 *
 * The Sprites exec API takes environment variables as query parameters of the exec URL, and URLs
 * end up in access logs and in the SDK's own error messages. A session's commands get credentials
 * (`GH_TOKEN`, project secrets, `CLAUDE_CODE_OAUTH_TOKEN`), so none of their environment goes there:
 * the exec runs a small `sh` script that reads one base64-encoded value per line from stdin,
 * decodes it, exports it under a name fixed in the script, and then `exec`s the real command, which
 * inherits the rest of stdin untouched. Values reach only the process's environment: never the exec
 * URL, its argv, or the Sprite's disk.
 */

/** A name `sh` can export (and not one of the script's own `__factory_*` variables). */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SCRATCH = '__factory_env_value';

/** Exit status of the script when stdin ended (or a value didn't decode) before every value arrived. */
export const ENV_PREAMBLE_INCOMPLETE = 97;

export interface StdinEnv {
  /** The `sh -c` script: reads and decodes the values, then `exec "$0" "$@"`. */
  script: string;
  /** What to write to the process's stdin before anything else: one base64 value per line. */
  preamble: string;
}

/** Where the preamble's tools are looked up, in order: the system's own, never PATH. */
const SYSTEM_DIRS = ['/usr/bin', '/bin'];

/**
 * The script and stdin preamble that give a process `env`. Names are checked here and written into
 * the script; values travel only in the preamble, base64-encoded, so any value (newlines included)
 * survives. A trailing marker keeps trailing newlines, which command substitution would strip.
 *
 * Only the system's own `base64` (`/usr/bin`, else `/bin`) decodes the values, and PATH is pinned to
 * those directories while the preamble runs, so a `base64` planted on PATH never reads them. The
 * command gets the PATH the exec had, or the one `env` gives.
 */
export function stdinEnv(env: Record<string, string>): StdinEnv {
  const entries = Object.entries(env);
  for (const [name] of entries) {
    if (!NAME.test(name) || name.startsWith('__factory_')) {
      throw new Error(`Environment variable name ${JSON.stringify(name)} can't be exported`);
    }
  }
  const fail = `exit ${ENV_PREAMBLE_INCOMPLETE}`;
  const hasPath = entries.some(([name]) => name === 'PATH');
  const reads = entries.map(([name]) => {
    // A new PATH is decoded aside and applied last, so the pinned one holds until then.
    const to = name === 'PATH' ? '__factory_env_path' : name;
    const decode = `${to}=$(printf '%s' "$${SCRATCH}" | "$__factory_b64" -d && printf x) || ${fail}; ${to}=\${${to}%x}`;
    return `IFS= read -r ${SCRATCH} || ${fail}; ${decode}${name === 'PATH' ? '' : `; export ${name}`}`;
  });
  const findBase64 = `${SYSTEM_DIRS.map((dir, index) => `${index ? 'elif' : 'if'} [ -x ${dir}/base64 ]; then __factory_b64=${dir}/base64;`).join(' ')} else echo "factory: no base64 in ${SYSTEM_DIRS.join(' or ')}" >&2; ${fail}; fi`;
  return {
    script: [
      '__factory_path=${PATH:-/usr/local/bin:/usr/bin:/bin}',
      `PATH=${SYSTEM_DIRS.join(':')}`,
      findBase64,
      ...reads,
      `PATH=$${hasPath ? '__factory_env_path' : '__factory_path'}`,
      'export PATH',
      `unset ${SCRATCH} __factory_path __factory_b64${hasPath ? ' __factory_env_path' : ''}`,
      'exec "$0" "$@"',
    ].join('\n'),
    preamble: entries.map(([, value]) => `${Buffer.from(value, 'utf8').toString('base64')}\n`).join(''),
  };
}
