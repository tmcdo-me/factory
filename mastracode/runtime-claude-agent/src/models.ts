/** Models offered for Claude Agent sessions. Claude Code accepts these ids (and aliases) as `model`. */
export const CLAUDE_AGENT_MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { id: 'claude-fable-5-2', label: 'Fable 5.2' },
] as const;

export const CLAUDE_AGENT_DEFAULT_MODEL = 'claude-opus-5-5';
