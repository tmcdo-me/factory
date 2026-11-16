import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';

import type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
import type { SandboxFiles } from '@factory/agent-runtime';

/** Factory's skills reach Claude Code as one local plugin of this name; skills are `factory:<name>`. */
export const FACTORY_SKILLS_PLUGIN = 'factory';

/** A skill as Factory serves it to the session: its SKILL.md and the files beside it. */
export interface ClaudeAgentSkill {
  name: string;
  description: string;
  /** The SKILL.md body, without frontmatter. */
  instructions: string;
  /** Files relative to the skill's folder (`references/…`, `scripts/…`, `assets/…`). */
  files?: { path: string; content: string | Buffer }[];
}

/** The plugin to load and the skills to enable (the SDK's `plugins` and `skills` options). */
export interface ClaudeAgentSkills {
  plugin: SdkPluginConfig;
  names: string[];
}

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Files on the machine Claude Code runs on: this host's, or a sandbox's (`SandboxFiles`). */
export type SkillFiles = Pick<SandboxFiles, 'mkdir' | 'rm' | 'writeFile'>;

/** This host's filesystem. */
export const HOST_FILES: SkillFiles = {
  mkdir: async path => {
    await mkdir(path, { recursive: true });
  },
  rm: path => rm(path, { recursive: true, force: true }),
  writeFile: (path, content) => writeFile(path, content),
};

/**
 * Write the session's skills as a local Claude Code plugin in `dir`, replacing what was there, so
 * a session sees exactly the skills Factory chose for it this time. `files` is the filesystem
 * Claude Code runs on: this host's by default, a sandbox's when it runs inside one.
 *
 * The plugin carries skills only: no hooks, agents, commands or MCP servers, and its MCP discovery is
 * skipped. Skill names must be plain folder names; file paths must stay inside the skill's folder.
 */
export async function writeSkillsPlugin(
  dir: string,
  skills: readonly ClaudeAgentSkill[],
  files: SkillFiles = HOST_FILES,
): Promise<ClaudeAgentSkills> {
  await files.rm(dir);
  await files.mkdir(join(dir, '.claude-plugin'));
  await files.writeFile(
    join(dir, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify({ name: FACTORY_SKILLS_PLUGIN, version: '1.0.0', description: "Factory's skills" }, null, 2)}\n`,
  );
  const names: string[] = [];
  for (const skill of skills) {
    if (!SKILL_NAME.test(skill.name)) throw new Error(`Skill name "${skill.name}" is not a plain folder name`);
    const root = join(dir, 'skills', skill.name);
    await files.mkdir(root);
    await files.writeFile(join(root, 'SKILL.md'), skillMarkdown(skill));
    for (const file of skill.files ?? []) {
      const relative = normalize(file.path);
      if (relative.startsWith('..') || relative.startsWith(sep) || relative === 'SKILL.md' || relative === '.') {
        throw new Error(`Skill "${skill.name}" file "${file.path}" is outside its folder`);
      }
      const target = join(root, relative);
      await files.mkdir(dirname(target));
      await files.writeFile(target, file.content);
    }
    names.push(`${FACTORY_SKILLS_PLUGIN}:${skill.name}`);
  }
  return { plugin: { type: 'local', path: dir, skipMcpDiscovery: true }, names };
}

/** JSON strings are valid YAML double-quoted scalars, so any description survives the frontmatter. */
function skillMarkdown(skill: ClaudeAgentSkill): string {
  return [
    '---',
    `name: ${JSON.stringify(skill.name)}`,
    `description: ${JSON.stringify(skill.description.replace(/\s+/g, ' ').trim())}`,
    '---',
    '',
    skill.instructions.trimStart(),
  ].join('\n');
}

/**
 * The turn that starts one of Factory's skills for a board run, as Mastra Code's `<skill>` kickoff
 * does: Claude opens the skill with its Skill tool, so it reads the skill from its own folder.
 * `resume` continues a skill the conversation already has open instead of restarting it.
 */
export function skillKickoffText(name: string, options: { arguments?: string; resume?: boolean } = {}): string {
  const skill = `${FACTORY_SKILLS_PLUGIN}:${name}`;
  const args = options.arguments?.trim();
  const lines = options.resume
    ? [
        `Resume the active \`${skill}\` skill: it is already open in this conversation, so continue it rather than restarting.`,
        `Open it again with the Skill tool if its instructions are no longer in context.`,
      ]
    : [`Run the \`${skill}\` skill now: open it with the Skill tool and follow its instructions.`];
  return [...lines, ...(args ? [`\nARGUMENTS: ${args}`] : [])].join('\n');
}
