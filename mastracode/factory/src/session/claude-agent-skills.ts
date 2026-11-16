// fork(claude-agent): Factory's skills for a Claude Agent session, chosen as for Mastra Code.
import path from 'node:path';

import type { ClaudeAgentSkill } from '@factory/runtime-claude-agent';
import type { WorkspaceSkills } from '@mastra/core/workspace';

import { FACTORY_SKILLS_MOUNT } from '../workspace.js';

function isFactorySkill(skillPath: string): boolean {
  const normalized = path.normalize(skillPath);
  return normalized.startsWith(`${FACTORY_SKILLS_MOUNT}${path.sep}`);
}

/**
 * The Factory skills a session's workspace serves, with their files. The workspace already chose
 * them as it does for a Mastra Code session: review skills only for review sessions, the project's
 * edited SKILL.md files, the app's own skills over bundled ones. Repository skills (`.claude/skills`
 * in the checkout and the like) are left out: only Factory's skills reach Claude Agent.
 */
export async function factorySkillsOf(skills: WorkspaceSkills | undefined): Promise<ClaudeAgentSkill[]> {
  if (!skills) return [];
  const out: ClaudeAgentSkill[] = [];
  for (const meta of await skills.list()) {
    if (!isFactorySkill(meta.path)) continue;
    // By path: a repository skill may share the name (the Factory mount hides those, but be exact).
    const skill = await skills.get(meta.path);
    if (!skill) continue;
    const files: NonNullable<ClaudeAgentSkill['files']> = [];
    for (const [dir, list] of [
      ['references', skill.references],
      ['scripts', skill.scripts],
    ] as const) {
      for (const file of list) {
        const filePath = `${dir}/${file}`;
        const content =
          dir === 'references'
            ? await skills.getReference(meta.path, filePath)
            : await skills.getScript(meta.path, filePath);
        if (content !== null) files.push({ path: filePath, content });
      }
    }
    for (const file of skill.assets) {
      const content = await skills.getAsset(meta.path, `assets/${file}`);
      if (content !== null) files.push({ path: `assets/${file}`, content });
    }
    out.push({ name: skill.name, description: skill.description, instructions: skill.instructions, files });
  }
  return out;
}
