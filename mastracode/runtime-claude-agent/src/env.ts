/**
 * The environment the Claude Code subprocess gets. Built from an allow-list: Factory server secrets
 * (database URLs, encryption keys, GitHub App keys, platform tokens) must never reach the agent.
 *
 * Claude's own credential is whatever the operator configured for the `claude` binary: its saved
 * login (`claude /login`), or `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` in the server's
 * environment, passed through untouched. Factory never reads, stores or logs them.
 *
 * Claude Code's own tool processes (Bash, and what they run: a repository's tests) would otherwise
 * be able to get at that credential: Claude Code 2.1.325 leaves `CLAUDE_CODE_OAUTH_TOKEN` out of a
 * command's environment, but a command can read Claude Code's own (`ps eww` on macOS,
 * `/proc/<pid>/environ` on Linux). Claude Code's Bash sandbox closes that (`bashSandbox`, see
 * `bash-sandbox.ts`). `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is not set here: it is the hardening mode
 * for CI on untrusted input, and in this version it forces the permission mode to `default`
 * (Factory sessions run `bypassPermissions` with no permission prompt to answer, so tools would be
 * refused), and it scrubs `GH_TOKEN`/`GITHUB_TOKEN` and every token-, secret- or key-like variable
 * from subprocesses too, which takes away the session's git credentials. It is not part of the
 * Agent SDK's documented options either.
 */
const PASSTHROUGH = [
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  // Claude's credential, as the operator configured it.
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  // Claude Code's own cloud-provider switches.
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'AWS_REGION',
  'AWS_PROFILE',
  'CLOUD_ML_REGION',
  'ANTHROPIC_VERTEX_PROJECT_ID',
] as const;

/** Paths and settings of this machine: they apply only when Claude Code runs on it. */
const HOST_ONLY = [
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PATH',
  'TMPDIR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'GIT_EXEC_PATH',
  'GIT_TEMPLATE_DIR',
  'CLAUDE_CONFIG_DIR',
] as const;

export interface ClaudeProcessEnvOptions {
  /**
   * A home directory of Claude Code's own. When set, the subprocess gets it as `HOME` and keeps its
   * config, transcripts and login under `<home>/.claude` (`CLAUDE_CONFIG_DIR`), apart from the
   * operator's. A saved login of the operator's does not carry over: use `CLAUDE_CODE_OAUTH_TOKEN`
   * (from `claude setup-token`), or sign in once with this home.
   */
  home?: string;
  /**
   * Claude Code runs on another machine (inside a Sprite): none of this host's paths or settings
   * (`HOME`, `PATH`, `TMPDIR`, certificates, proxies) apply there, so only Claude's credential, its
   * provider switches and the locale pass through. Auto-update is off: the sandbox's binary is the
   * one its install step pinned.
   */
  remote?: boolean;
}

/**
 * git config Claude's shell gets from its environment (`GIT_CONFIG_COUNT`, see
 * {@link withGitConfig}), because Claude Code's Bash sandbox keeps the checkout's `.git/config`
 * read-only: git can't record a branch's upstream there.
 *
 * - `push.default=current`: plain `git push` pushes the current branch to a branch of the same name
 *   on `origin`, upstream or not. (`push.autoSetupRemote` is left off: it makes every such push try
 *   to record the upstream, and print the sandbox's "could not lock config file" error.)
 * - `branch.autoSetupMerge=false`: `git checkout -b <branch> origin/main` would otherwise try to
 *   record `origin/main` as the new branch's upstream and, refused, exit 1.
 *
 * `git push -u` still pushes but prints that error, and `git pull` on a branch with no upstream has
 * no default to fall back on (`git pull origin <branch>` works): the session's instructions say so
 * (`BASH_SANDBOX_INSTRUCTIONS`).
 */
export const CLAUDE_GIT_CONFIG: readonly (readonly [key: string, value: string])[] = [
  ['push.default', 'current'],
  ['branch.autoSetupMerge', 'false'],
];

/**
 * `env` with git config `entries` added as `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` after the
 * entries it already has (`GIT_CONFIG_COUNT`). A key those entries already set keeps its value.
 */
export function withGitConfig(
  env: Record<string, string>,
  entries: readonly (readonly [key: string, value: string])[],
): Record<string, string> {
  const raw = env.GIT_CONFIG_COUNT;
  const count = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : 0;
  // Section and key names are case-insensitive (`push.default` is `Push.Default`).
  const present = new Set<string>();
  for (let i = 0; i < count; i++) {
    const key = env[`GIT_CONFIG_KEY_${i}`];
    if (key) present.add(key.toLowerCase());
  }
  const out = { ...env };
  let next = count;
  for (const [key, value] of entries) {
    if (present.has(key.toLowerCase())) continue;
    out[`GIT_CONFIG_KEY_${next}`] = key;
    out[`GIT_CONFIG_VALUE_${next}`] = value;
    next++;
  }
  if (next > count) out.GIT_CONFIG_COUNT = String(next);
  return out;
}

export function claudeProcessEnv(
  hostEnv: Record<string, string | undefined>,
  sandboxEnv: Record<string, string> = {},
  options: ClaudeProcessEnvOptions = {},
): Record<string, string> {
  const env: Record<string, string> = {
    // git in Claude's shell must never wait on a person. Nobody can answer a terminal prompt, and the
    // host's system git config can name a credential helper that blocks: Homebrew's names
    // `osxkeychain`, which hangs without a keychain session. The checkout's own config supplies
    // credentials (`gh auth git-credential` with the sandbox's GH_TOKEN), so skip the system config
    // and fail fast instead of prompting. Sandbox values below may still override these.
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  for (const name of options.remote ? PASSTHROUGH : [...HOST_ONLY, ...PASSTHROUGH]) {
    const value = hostEnv[name];
    if (value) env[name] = value;
  }
  // Sandbox-scoped values (git credentials for the checkout) win over the host's.
  Object.assign(env, sandboxEnv);
  if (options.home) {
    env.HOME = options.home;
    env.CLAUDE_CONFIG_DIR = `${options.home.replace(/\/+$/, '')}/.claude`;
  }
  if (options.remote) env.DISABLE_AUTOUPDATER = '1';
  // Identifies the embedding app in Claude Code's User-Agent.
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'factory';
  // After the sandbox's own entries, which win for a key both set.
  return withGitConfig(env, CLAUDE_GIT_CONFIG);
}
