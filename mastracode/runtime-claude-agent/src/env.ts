/**
 * The environment the Claude Code subprocess gets. Built from an allow-list: Factory server secrets
 * (database URLs, encryption keys, GitHub App keys, platform tokens) must never reach the agent.
 *
 * Claude's own credential is whatever the operator configured for the `claude` binary: its saved
 * login (`claude /login`), or `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` in the server's
 * environment, passed through untouched. Factory never reads, stores or logs them.
 *
 * Known gap: Claude Code's own tool processes (Bash, and what they run: a repository's tests)
 * inherit that credential. Claude Code 2.1.325 has a switch for this, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`,
 * but it is not set here: it is the hardening mode for CI on untrusted input, and in this version
 * it forces the permission mode to `default` (Factory sessions run `bypassPermissions` with no
 * permission prompt to answer, so tools would be refused), and it scrubs `GH_TOKEN`/`GITHUB_TOKEN`
 * and every token-, secret- or key-like variable from subprocesses too, which takes away the
 * session's git credentials. It is not part of the Agent SDK's documented options either.
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
  return env;
}
