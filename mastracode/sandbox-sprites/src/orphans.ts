import { SpritesClient } from '@fly/sprites';

import { spriteNameFor } from './factory-sandbox';

/**
 * The session Sprites (`<prefix>-…`) that belong to no session Factory still has: what a crash
 * between a session's deletion and its Sprite's, or a lost replica, leaves behind. Names are
 * matched by deriving each session's Sprite name, exactly as `SpritesFactorySandbox` does.
 *
 * Prefixes must not overlap: a listing for `factory` also matches `factory-staging-…`.
 */
export function orphanSpriteNames(
  spriteNames: Iterable<string>,
  sessionIds: Iterable<string>,
  prefix = 'factory',
): string[] {
  const owned = new Set([...sessionIds].map(id => spriteNameFor(id, prefix)));
  return [...spriteNames].filter(name => name.startsWith(`${prefix}-`) && !owned.has(name)).sort();
}

/** {@link orphanSpriteNames} for the Sprites the token's organization has now. Lists only. */
export async function listOrphanSprites(options: {
  token: string;
  baseURL?: string;
  prefix?: string;
  sessionIds: Iterable<string>;
}): Promise<string[]> {
  const prefix = options.prefix ?? 'factory';
  const client = new SpritesClient(options.token, options.baseURL ? { baseURL: options.baseURL } : undefined);
  const sprites = await client.listAllSprites(`${prefix}-`);
  return orphanSpriteNames(
    sprites.map(sprite => sprite.name),
    options.sessionIds,
    prefix,
  );
}
