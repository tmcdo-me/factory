/**
 * The live checks' probe of Claude Code's Bash sandbox (`session.live.test.ts` on this host,
 * `sprites.live.test.ts` in a Sprite): a shell script Claude runs with its Bash tool. It prints one
 * `name=verdict` line per check, counts and verdicts only, never a value it found: whether Claude's
 * credential is anywhere a command can get at it (its environment, other processes' environments,
 * files, the macOS keychain), and whether ordinary work still goes (the network, git with the
 * session's credential helper, `gh`, writes in the checkout and the package caches, a package
 * install, a commit and a push).
 */
export interface BashSandboxProbeOptions {
  /** A file holding a (fake) secret, standing in for the host's env file: it must be unreadable. */
  secretFile?: string;
  /** A macOS keychain item's service name, standing in for Claude Code's saved login. */
  keychainService?: string;
}

const PLAIN = /^[A-Za-z0-9._/@+-]+$/;

export function bashSandboxProbeScript(options: BashSandboxProbeOptions = {}): string {
  for (const value of [options.secretFile, options.keychainService]) {
    if (value !== undefined && !PLAIN.test(value)) throw new Error(`Not a plain value: ${JSON.stringify(value)}`);
  }
  return `#!/bin/sh
p() { printf '%s=%s\\n' "$1" "$2"; }
set_or_not() { if [ -n "$2" ]; then p "env.$1" present; else p "env.$1" absent; fi; }
set_or_not CLAUDE_CODE_OAUTH_TOKEN "$CLAUDE_CODE_OAUTH_TOKEN"
set_or_not ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY"
set_or_not GH_TOKEN "$GH_TOKEN"

# Other processes' environments: Claude Code's own holds the credential. (TOKE[N] keeps grep's own
# command line from matching.)
p ps.token_in_env "$(ps eww -ax 2>/dev/null | grep -c 'CLAUDE_CODE_OAUTH_TOKE[N]=[A-Za-z0-9]')"
if [ -d /proc/self ]; then
  n=0
  for f in /proc/[0-9]*/environ; do
    if tr '\\0' '\\n' <"$f" 2>/dev/null | grep -q '^CLAUDE_CODE_OAUTH_TOKE[N]=.'; then n=$((n + 1)); fi
  done
  p proc.token_in_environ "$n"
fi

# Files: Claude's home and config dir, and the host's env file.
cfg="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
p files.token_like "$(grep -rIl 'sk-ant-[a-z]' "$HOME" "$cfg" 2>/dev/null | sort -u | wc -l | tr -d ' ')"
${options.secretFile ? `if cat '${options.secretFile}' >/dev/null 2>&1; then p files.secret readable; else p files.secret denied; fi` : ''}
${
  options.keychainService
    ? `if command -v security >/dev/null 2>&1; then
  security find-generic-password -s '${options.keychainService}' -w >/dev/null 2>&1 &
  pid=$!; i=0
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 10 ]; do sleep 0.5; i=$((i + 1)); done
  kill "$pid" 2>/dev/null
  if wait "$pid"; then p keychain.item readable; else p keychain.item denied; fi
fi`
    : ''
}

# Network: an ordinary host, GitHub over git, the session's credential helper, gh.
p net.npm_registry "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://registry.npmjs.org/is-number 2>/dev/null)"
if git ls-remote https://github.com/octocat/Hello-World HEAD >/dev/null 2>&1; then p git.public ok; else p git.public fail; fi
if command -v gh >/dev/null 2>&1; then
  out=$(GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c 'credential.helper=!gh auth git-credential' ls-remote https://github.com/octocat/factory-probe-no-such-repo 2>&1)
  case "$out" in
    *"Invalid username"* | *"Authentication failed"*) p git.credential_helper sent ;;
    *"could not read Username"*) p git.credential_helper none ;;
    *) p git.credential_helper other ;;
  esac
  out=$(gh api /zen 2>&1)
  case "$out" in
    *"HTTP 401"* | *"Bad credentials"*) p gh.api reached ;;
    *x509* | *"tls:"* | *certificate*) p gh.api tls-failed ;;
    *) p gh.api other ;;
  esac
else
  p gh.api not-installed
fi

# Writes: the checkout, the temp dir, the package caches; Claude's config and the checkout's
# .claude/ settings and git hooks must stay closed.
w() { if (mkdir -p "$(dirname "$2")" && : >"$2" && rm -f "$2") 2>/dev/null; then p "write.$1" ok; else p "write.$1" denied; fi; }
w checkout ./.factory-probe
w tmpdir "\${TMPDIR:-/tmp}/factory-probe"
w home_cache "$HOME/.cache/factory-probe/x"
w home_npm "$HOME/.npm/factory-probe"
w home "$HOME/.factory-probe"
w claude_config "$cfg/factory-probe"
w checkout_claude_settings ./.claude/settings.json
w git_hooks ./.git/hooks/factory-probe
if command -v npm >/dev/null 2>&1; then
  if npm install --no-save --no-audit --no-fund --loglevel=error is-number >/dev/null 2>&1 && [ -d node_modules/is-number ]; then p npm.install ok; else p npm.install failed; fi
  rm -rf node_modules package-lock.json
else
  p npm.install not-installed
fi
: >.factory-probe-file
if git add .factory-probe-file >/dev/null 2>&1 && git -c user.email=probe@example.com -c user.name=probe commit -qm probe >/dev/null 2>&1; then p git.commit ok; else p git.commit failed; fi
git init -q --bare .factory-probe-remote.git >/dev/null 2>&1
if git push -q ./.factory-probe-remote.git HEAD:refs/heads/probe >/dev/null 2>&1; then p git.push ok; else p git.push failed; fi
if git push -q -u ./.factory-probe-remote.git HEAD:refs/heads/probe-upstream >/dev/null 2>&1; then p git.push_upstream ok; else p git.push_upstream failed; fi
if git config factory.probe yes >/dev/null 2>&1; then p git.config_write ok; else p git.config_write denied; fi
if command -v sudo >/dev/null 2>&1; then if sudo -n true >/dev/null 2>&1; then p sudo.root ok; else p sudo.root denied; fi; fi
p probe done
`;
}

/** The probe's `name=verdict` lines, by name. */
export function parseBashSandboxProbe(output: string): Record<string, string> {
  return Object.fromEntries(
    output
      .split('\n')
      .map(line => /^([a-z_]+\.[A-Za-z_]+|probe)=(.*)$/.exec(line.trim()))
      .filter((match): match is RegExpExecArray => match !== null)
      .map(match => [match[1]!, match[2]!]),
  );
}
