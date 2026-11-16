/**
 * Environment for a process in a Sprite, delivered over its stdin rather than in the exec request.
 *
 * The Sprites exec API takes environment variables as query parameters of the exec URL, and URLs
 * end up in access logs. A session's process gets credentials (`CLAUDE_CODE_OAUTH_TOKEN`,
 * `GH_TOKEN`), so none of its environment goes there: the exec runs a small `sh` script that reads
 * one value per line from stdin, exports it under a name fixed in the script, and then `exec`s the
 * real command, which inherits the rest of stdin untouched. Values reach only the process's
 * environment: never the exec URL, its argv, or the Sprite's disk.
 */

/** A name `sh` can export. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Exit status of the script when stdin ended before every value arrived. */
export const ENV_PREAMBLE_INCOMPLETE = 97;

export interface StdinEnv {
  /** The `sh -c` script: reads the values, then `exec "$0" "$@"`. */
  script: string;
  /** What to write to the process's stdin before anything else: one value per line. */
  preamble: string;
}

/**
 * The script and stdin preamble that give a process `env`. Names are checked here and written into
 * the script; values travel only in the preamble. A value with a line break can't be sent this way
 * and is refused (by name, never by value).
 */
export function stdinEnv(env: Record<string, string>): StdinEnv {
  const entries = Object.entries(env);
  for (const [name, value] of entries) {
    if (!NAME.test(name)) throw new Error(`Environment variable name ${JSON.stringify(name)} can't be exported`);
    if (/[\n\r\0]/.test(value)) throw new Error(`Environment variable ${name} has a line break and can't be sent`);
  }
  const reads = entries.map(([name]) => `IFS= read -r ${name} || exit ${ENV_PREAMBLE_INCOMPLETE}; export ${name}`);
  return {
    script: [...reads, 'exec "$0" "$@"'].join('\n'),
    preamble: entries.map(([, value]) => `${value}\n`).join(''),
  };
}
