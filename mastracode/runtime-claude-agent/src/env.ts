/**
 * The environment the Claude Code subprocess gets. Built from an allow-list: Factory server secrets
 * (database URLs, encryption keys, GitHub App keys, platform tokens) must never reach the agent.
 *
 * Claude's own credential is whatever the operator configured for the `claude` binary: its saved
 * login (`claude /login`), or `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` in the server's
 * environment, passed through untouched. Factory never reads, stores or logs them.
 */
const PASSTHROUGH = [
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PATH',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'GIT_EXEC_PATH',
  'GIT_TEMPLATE_DIR',
  // Claude's credential, as the operator configured it.
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CONFIG_DIR',
  // Claude Code's own cloud-provider switches.
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'AWS_REGION',
  'AWS_PROFILE',
  'CLOUD_ML_REGION',
  'ANTHROPIC_VERTEX_PROJECT_ID',
] as const;

export function claudeProcessEnv(
  hostEnv: Record<string, string | undefined>,
  sandboxEnv: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSTHROUGH) {
    const value = hostEnv[name];
    if (value) env[name] = value;
  }
  // Sandbox-scoped values (git credentials for the checkout) win over the host's.
  Object.assign(env, sandboxEnv);
  // Identifies the embedding app in Claude Code's User-Agent.
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'factory';
  return env;
}
