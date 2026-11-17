/**
 * Claude Code's built-in tools a Factory session gets, as an allow-list (the SDK's `tools` option):
 * anything Claude Code adds in a later release stays off until it is reviewed here.
 *
 * A session works inside its own checkout, like a Mastra Code session with its workspace tools.
 * What reaches the operator's Claude account or acts outside the session stays off: schedules and
 * wake-ups, notifications, cloud and remote triggers, messages to other sessions, worktrees.
 */
export const CLAUDE_AGENT_BUILTIN_TOOLS = [
  // Coding in the checkout: shell, files, search.
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  // Jupyter notebooks are files in the checkout too; editing one is an ordinary file write.
  'NotebookEdit',
  // Stops a background shell or subagent this session started; it reaches nothing else.
  'TaskStop',
  // Subagents run inside this session with this same tool set (Claude Code reports it as `Task`).
  'Agent',
  // The session's task list, shown in Factory's transcript. Claude Code offers it only to models
  // that use it (not the Claude 5 family by default), so it is often absent.
  'TodoWrite',
  // Public web lookups, as Mastra Code's web tools do.
  'WebSearch',
  'WebFetch',
  // Loads the schema of a tool this session already has when Claude Code defers it; it adds none.
  'ToolSearch',
] as const;

/** Invokes the session's skills; only on when Factory gives the session skills. */
export const SKILL_TOOL = 'Skill';

/**
 * Tools refused even if a subagent definition or a later Claude Code release would bring them in.
 * The allow-list already leaves them out; this also blocks the harness's own direct calls.
 */
export const CLAUDE_AGENT_DISALLOWED_TOOLS = [
  // Claude Code's own question and plan-approval prompts have no human on the other end; Factory's
  // `ask_user` and `submit_plan` ask through Factory instead.
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  // Schedules and wake-ups start turns nobody sent, outside Factory's runs.
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'Monitor',
  // Remote and cloud work, notifications and messages run on the operator's Claude account.
  'RemoteTrigger',
  'PushNotification',
  'SendMessage',
  'Workflow',
  'DesignSync',
  'ReportFindings',
  // Factory owns the session's checkout; Claude Code must not move it into worktrees of its own.
  'EnterWorktree',
  'ExitWorktree',
  // A person merges a pull request; Factory never does (its CI follow-up sends fixes, never merges).
  // A deny rule holds under `bypassPermissions` too. Defense in depth only: `gh api` and a push to the
  // default branch stay open, so the real control is the repository's branch protection or rulesets.
  // (A `gh api` pattern would block the API calls Claude needs for its own work.)
  'Bash(gh pr merge:*)',
] as const;
