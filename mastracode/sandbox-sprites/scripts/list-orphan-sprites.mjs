#!/usr/bin/env node
// Lists session Sprites with no Factory session (see README, "Orphaned Sprites"). Lists only.
//
//   SPRITES_TOKEN=… FACTORY_SPRITES_PREFIX=factory node scripts/list-orphan-sprites.mjs < session-ids.txt
//
// stdin: the id of every row of Factory's `source_control_sessions` table, one per line.
import { listOrphanSprites } from '../dist/index.js';

const token = process.env.SPRITES_TOKEN?.trim();
if (!token) {
  console.error('SPRITES_TOKEN is required');
  process.exit(2);
}
let input = '';
for await (const chunk of process.stdin) input += chunk;
const sessionIds = input
  .split('\n')
  .map(line => line.trim())
  .filter(Boolean);
const orphans = await listOrphanSprites({
  token,
  prefix: process.env.FACTORY_SPRITES_PREFIX?.trim() || 'factory',
  sessionIds,
});
for (const name of orphans) console.log(name);
console.error(`${orphans.length} orphaned Sprite(s) of ${sessionIds.length} session(s) checked`);
