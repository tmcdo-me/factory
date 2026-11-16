export { SessionSpritesSandbox, SpritesFactorySandbox, spriteNameFor, spriteProcesses } from './factory-sandbox';
export type { SpritesFactorySandboxOptions } from './factory-sandbox';
export { SpriteStdioProcess, spawnInSprite } from './sprite-process';
export { envOverStdin, redactSpriteError } from './sprite-exec';
export type { SpriteCommandLike, SpriteSpawn } from './sprite-exec';
export { ENV_PREAMBLE_INCOMPLETE, stdinEnv } from './stdin-env';
export type { StdinEnv } from './stdin-env';
export { listOrphanSprites, orphanSpriteNames } from './orphans';
