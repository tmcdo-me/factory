import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { skillKickoffText, writeSkillsPlugin } from './skills';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'claude-skills-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const plan = {
  name: 'factory-plan',
  description: 'Produce a plan: phased, verifiable\nand submitted',
  instructions: '\n# Factory Plan\n\nSubmit it with `submit_plan`.\n',
};

describe('writeSkillsPlugin', () => {
  it('writes the skills as a local plugin of skills only, enabled by their plugin-qualified names', async () => {
    const dir = join(root, 'plugin');
    const skills = await writeSkillsPlugin(dir, [
      plan,
      {
        name: 'factory-review',
        description: 'Review',
        instructions: 'Read `references/categories/a.md`.',
        files: [{ path: 'references/categories/a.md', content: 'Category A' }],
      },
    ]);

    expect(skills).toEqual({
      plugin: { type: 'local', path: dir, skipMcpDiscovery: true },
      names: ['factory:factory-plan', 'factory:factory-review'],
    });
    expect(JSON.parse(await readFile(join(dir, '.claude-plugin', 'plugin.json'), 'utf8'))).toMatchObject({
      name: 'factory',
    });
    expect((await readdir(dir)).sort()).toEqual(['.claude-plugin', 'skills']);
    expect(await readFile(join(dir, 'skills', 'factory-plan', 'SKILL.md'), 'utf8')).toBe(
      '---\nname: "factory-plan"\ndescription: "Produce a plan: phased, verifiable and submitted"\n---\n\n# Factory Plan\n\nSubmit it with `submit_plan`.\n',
    );
    expect(await readFile(join(dir, 'skills', 'factory-review', 'references', 'categories', 'a.md'), 'utf8')).toBe(
      'Category A',
    );
  });

  it('replaces what an earlier session start wrote, so a skill the session lost is gone', async () => {
    const dir = join(root, 'plugin');
    await writeSkillsPlugin(dir, [plan, { name: 'factory-review', description: 'Review', instructions: 'x' }]);
    await writeSkillsPlugin(dir, [plan]);
    expect(await readdir(join(dir, 'skills'))).toEqual(['factory-plan']);
  });

  it('refuses names and files that would land outside the plugin', async () => {
    await expect(
      writeSkillsPlugin(join(root, 'a'), [{ name: '../escape', description: 'd', instructions: 'x' }]),
    ).rejects.toThrow(/plain folder name/);
    await expect(
      writeSkillsPlugin(join(root, 'b'), [{ ...plan, files: [{ path: '../../outside.md', content: 'x' }] }]),
    ).rejects.toThrow(/outside its folder/);
  });
});

describe('skillKickoffText', () => {
  it("starts the plugin's skill with its arguments, or continues one already open", () => {
    expect(skillKickoffText('factory-plan', { arguments: ' card 42 ' })).toBe(
      'Run the `factory:factory-plan` skill now: open it with the Skill tool and follow its instructions.\n\nARGUMENTS: card 42',
    );
    const resumed = skillKickoffText('factory-plan', { resume: true });
    expect(resumed).toContain('Resume the active `factory:factory-plan` skill');
    expect(resumed).not.toContain('ARGUMENTS');
  });
});
