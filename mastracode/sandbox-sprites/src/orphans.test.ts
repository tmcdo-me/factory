import { describe, expect, it } from 'vitest';

import { spriteNameFor } from './factory-sandbox';
import { orphanSpriteNames } from './orphans';

describe('orphanSpriteNames', () => {
  it("lists this deployment's Sprites that no session owns, matching names as the sandbox derives them", () => {
    const sessions = ['row-1', 'Row_2'];
    const sprites = [
      spriteNameFor('row-1'),
      spriteNameFor('Row_2'), // a hashed name
      'factory-row-gone',
      'other-row-1', // another deployment's prefix
    ];
    expect(orphanSpriteNames(sprites, sessions)).toEqual(['factory-row-gone']);
    expect(orphanSpriteNames(['staging-a', 'staging-b'], ['a'], 'staging')).toEqual(['staging-b']);
  });
});
