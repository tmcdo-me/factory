/** Claude's saved login where Claude Code keeps it in a file (Linux), under Claude Code's own HOME. */
export const CLAUDE_CREDENTIALS_FILE = '~/.claude/.credentials.json';

/**
 * The files a session's Claude must not get at: Claude's saved login and `extra` (absolute or
 * `~/` paths: the host's env file that holds `CLAUDE_CODE_OAUTH_TOKEN`, say), each once. The one
 * list both Claude Code's Bash sandbox (`claudeAgentBashSandbox`) and its file tools
 * (`claudeAgentFileToolDeny`) refuse.
 */
export function claudeAgentSecretFiles(extra: readonly string[] = []): string[] {
  return [...new Set([CLAUDE_CREDENTIALS_FILE, ...extra.map(path => path.trim()).filter(Boolean)])];
}

/**
 * Claude Code's file tools, as its permission rules name them: a `Read` rule also covers Grep and
 * Glob, an `Edit` rule also covers Write and NotebookEdit.
 */
const FILE_TOOL_RULES = ['Read', 'Edit'] as const;

/**
 * A path as the content of a Claude Code file rule (a gitignore-style pattern): `//` for an
 * absolute path, `~/` as given. Characters a pattern or the rule list would read as syntax (glob
 * characters, the rule's own parentheses, a backslash) match as `?`, any one character: a deny
 * rule may then cover a sibling with another character there, but never misses the path.
 */
function rulePath(path: string): string | undefined {
  if (!path.startsWith('/') && !path.startsWith('~/')) return undefined;
  const pattern = path.replace(/[*?[\]{}()\\!#]/g, '?');
  return path.startsWith('/') ? `/${pattern}` : pattern;
}

/**
 * Permission deny rules that keep Claude Code's own file tools (Read, Grep, Glob, Edit, Write,
 * NotebookEdit) away from `files` (from {@link claudeAgentSecretFiles}). Those tools run in Claude
 * Code's own process, outside the Bash sandbox, so its `denyRead` doesn't bind them; deny rules
 * do, in every permission mode, `bypassPermissions` included. With `linux` (Claude Code runs on
 * Linux: a Sprite, a Linux host), `/proc` too: `/proc/self/environ` is Claude Code's own
 * environment, which holds the credential. Paths that are neither absolute nor `~/` are skipped.
 */
export function claudeAgentFileToolDeny(files: readonly string[], options: { linux?: boolean } = {}): string[] {
  const patterns = files.flatMap(path => rulePath(path) ?? []);
  if (options.linux) patterns.push('//proc', '//proc/**');
  return [...new Set(patterns)].flatMap(pattern => FILE_TOOL_RULES.map(tool => `${tool}(${pattern})`));
}
