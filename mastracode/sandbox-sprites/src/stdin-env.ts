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

/** A name `sh` can export (and not the script's own scratch variable). */
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

/**
 * The script and stdin preamble that give a process `env`. Names are checked here and written into
 * the script; values travel only in the preamble, base64-encoded, so any value (newlines included)
 * survives. Decoding needs `base64` in the Sprite (coreutils). A trailing marker keeps trailing
 * newlines, which command substitution would strip.
 */
export function stdinEnv(env: Record<string, string>): StdinEnv {
  const entries = Object.entries(env);
  for (const [name] of entries) {
    if (!NAME.test(name) || name === SCRATCH) {
      throw new Error(`Environment variable name ${JSON.stringify(name)} can't be exported`);
    }
  }
  const fail = `exit ${ENV_PREAMBLE_INCOMPLETE}`;
  const reads = entries.map(
    ([name]) =>
      `IFS= read -r ${SCRATCH} || ${fail}; ${name}=$(printf '%s' "$${SCRATCH}" | base64 -d && printf x) || ${fail}; ${name}=\${${name}%x}; export ${name}`,
  );
  return {
    script: [...reads, `unset ${SCRATCH}`, 'exec "$0" "$@"'].join('\n'),
    preamble: entries.map(([, value]) => `${Buffer.from(value, 'utf8').toString('base64')}\n`).join(''),
  };
}
