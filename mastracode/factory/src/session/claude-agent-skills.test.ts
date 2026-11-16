// fork(claude-agent)
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { LocalSkillSource, Workspace } from '@mastra/core/workspace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FACTORY_SKILLS_MOUNT, FactorySkillSource } from '../workspace.js';
import { factorySkillsOf } from './claude-agent-skills.js';

let checkout: string;
beforeEach(async () => {
  checkout = await mkdtemp(path.join(tmpdir(), 'claude-skills-checkout-'));
  // A repository skill of the checkout's own: Mastra Code lists it, Claude Agent must not.
  await mkdir(path.join(checkout, '.claude', 'skills', 'repo-deploy'), { recursive: true });
  await writeFile(
    path.join(checkout, '.claude', 'skills', 'repo-deploy', 'SKILL.md'),
    '---\nname: repo-deploy\ndescription: Deploy this repo\n---\nRun the deploy.\n',
  );
});
afterEach(async () => {
  await rm(checkout, { recursive: true, force: true });
});

/** A session workspace with Factory's skill layers, as `createWorkspaceFactory` builds it. */
function sessionSkills(isReviewSession: boolean) {
  const repoSkills = path.join(checkout, '.claude', 'skills');
  const source = new FactorySkillSource(
    new LocalSkillSource({ basePath: '/' }),
    [repoSkills],
    undefined,
    async () => isReviewSession,
  );
  return new Workspace({ skillSource: source, skills: [FACTORY_SKILLS_MOUNT, repoSkills] }).skills;
}

describe('factorySkillsOf', () => {
  it("gives a session Factory's skills only, with review skills held back outside review sessions", async () => {
    const workspaceSkills = sessionSkills(false);
    expect((await workspaceSkills!.list()).map(skill => skill.name)).toContain('repo-deploy');

    const names = (await factorySkillsOf(workspaceSkills)).map(skill => skill.name).sort();
    expect(names).toEqual(['configure-factory-rules', 'factory-build', 'factory-plan', 'factory-triage']);
  });

  it('adds the review skills, with their reference files, to a review session', async () => {
    const skills = await factorySkillsOf(sessionSkills(true));
    expect(skills.map(skill => skill.name)).toEqual(
      expect.arrayContaining(['factory-review', 'factory-rereview', 'factory-self-review', 'factory-plan']),
    );
    expect(skills.map(skill => skill.name)).not.toContain('repo-deploy');
    const review = skills.find(skill => skill.name === 'factory-review')!;
    expect(review.description).toBeTruthy();
    expect(review.instructions).toContain('factory_record_review_verdict');
    expect(review.files?.map(file => file.path)).toContain('references/archaeology.md');
    expect(review.files?.every(file => file.path.startsWith('references/') && String(file.content).length > 0)).toBe(
      true,
    );
  });

  it('is empty for a workspace without skills', async () => {
    expect(await factorySkillsOf(undefined)).toEqual([]);
  });
});
