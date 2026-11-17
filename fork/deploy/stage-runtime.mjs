// Run by fork/deploy/Dockerfile after the build: puts what the server loads at run time into a new tree,
// as hard links (no extra space), so the image carries that and not the build's tools and dev
// dependencies. Fork-only.
//
//   node fork/deploy/stage-runtime.mjs <repository root> <out dir> [--skip <prefix>]... [--optional <name>]...
//
// The server is mastracode/web's bundle (.mastra/output) plus the packages it imports, which Node finds
// through node_modules as in the checkout: the monorepo's built packages through the host's `link:`
// dependencies, theirs through pnpm's layout. Starting from what the bundle imports (the `dependencies`
// `mastra build` wrote into .mastra/output/package.json) and varlock, the server's launcher, this walks
// every package's `dependencies`, `optionalDependencies` and `peerDependencies` the way Node resolves
// them (from the package's real directory, up through each `node_modules`), and stages each package
// found, with the symlinks on the way to it. Never `devDependencies`: a build-time tool the bundle still
// imports is one of its roots. What is not installed (another platform's optional binary, an optional
// peer) is skipped. A regular dependency, or a bundle import, that is not installed FAILS the staging
// (exit 1), unless it is named with `--optional` (an import the bundle makes only on demand, in a
// try). `--skip` leaves out packages whose name starts with the prefix, for what this deployment never
// loads (the Dockerfile says which and why).
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

let [rootArg, outArg, ...rest] = process.argv.slice(2);
const skipped = [];
const optional = new Set();
for (let i = 0; i < rest.length; i += 2) {
  if (rest[i] === '--skip' && rest[i + 1]) skipped.push(rest[i + 1]);
  else if (rest[i] === '--optional' && rest[i + 1]) optional.add(rest[i + 1]);
  else rootArg = undefined;
}
if (!rootArg || !outArg) {
  console.error('usage: stage-runtime.mjs <repository root> <out dir> [--skip <prefix>]... [--optional <name>]...');
  process.exit(2);
}
const root = realpathSync(rootArg);
const out = resolve(outArg);
const web = join(root, 'mastracode/web');
const output = join(web, '.mastra/output');

const target = path => join(out, relative(root, path));
const ensureDir = dir => mkdirSync(target(dir), { recursive: true });

let files = 0;
/** Stage `path` (file, symlink or directory, recursively); `skip(path)` leaves an entry out. */
function stage(path, skip = () => false) {
  if (skip(path)) return;
  const stat = lstatSync(path);
  const to = target(path);
  if (stat.isSymbolicLink()) {
    if (existsSync(to) || isLink(to)) return;
    mkdirSync(dirname(to), { recursive: true });
    symlinkSync(readlinkSync(path), to);
  } else if (stat.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(path)) stage(join(path, entry), skip);
  } else if (stat.isFile()) {
    if (existsSync(to)) return;
    mkdirSync(dirname(to), { recursive: true });
    linkSync(path, to);
    files += 1;
  }
}
function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Every symlink on the way from `root` to `path`, staged, so the staged path resolves the same. */
function stageLinksTo(path) {
  let current = root;
  for (const part of relative(root, path).split(sep)) {
    current = join(current, part);
    if (isLink(current)) stage(current);
    else if (lstatSync(current).isDirectory()) ensureDir(current);
  }
}

/** Where Node finds package `name` from directory `from`: the nearest `node_modules/<name>`. */
function find(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dir === dirname(dir) || !dir.startsWith(root)) return undefined;
  }
}

const seen = new Set();
const missing = [];
const optionalMissing = [];
/** Stage package `name` as resolved from `from`, and what it depends on. */
const left = new Set();
function visit(name, from, kind) {
  if (skipped.some(prefix => name.startsWith(prefix))) {
    left.add(name);
    return;
  }
  const found = find(name, from);
  if (!found) {
    if (kind !== 'dependency') return;
    const entry = `${name} (from ${relative(root, from) || '.'})`;
    if (optional.has(name)) optionalMissing.push(entry);
    else missing.push(entry);
    return;
  }
  stageLinksTo(found);
  const real = realpathSync(found);
  if (seen.has(real)) return;
  seen.add(real);
  // A package inside node_modules is staged whole (nested node_modules are its bundled dependencies);
  // a workspace project without its own node_modules (its links are staged as they are resolved) and
  // without build caches.
  const isWorkspaceProject = !real.split(sep).includes('node_modules');
  stage(real, path =>
    isWorkspaceProject ? path === join(real, 'node_modules') || path.endsWith(`${sep}.turbo`) : false,
  );
  const manifest = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8'));
  for (const dep of Object.keys(manifest.dependencies ?? {})) visit(dep, real, 'dependency');
  for (const dep of Object.keys(manifest.optionalDependencies ?? {})) visit(dep, real, 'optional');
  for (const dep of Object.keys(manifest.peerDependencies ?? {})) visit(dep, real, 'peer');
}

// The host project: its manifest and env schema (varlock reads it), and the bundle with the UI.
stage(join(web, 'package.json'));
stage(join(web, '.env.schema'));
stage(output);

const bundle = JSON.parse(readFileSync(join(output, 'package.json'), 'utf8'));
const roots = Object.keys(bundle.dependencies ?? {});
for (const name of roots) visit(name, output, 'dependency');
visit('varlock', web, 'dependency');

console.log(
  `stage-runtime: ${seen.size} packages, ${files} files from ${roots.length} bundle imports and varlock into ${out}`,
);
if (left.size) console.log(`stage-runtime: skipped as asked: ${[...left].sort().join(', ')}`);
if (optionalMissing.length) {
  console.log('stage-runtime: not installed, optional as asked:');
  for (const entry of optionalMissing) console.log(`  ${entry}`);
}
if (missing.length) {
  console.error('stage-runtime: FAILED: dependencies that are not installed (the server would not load them):');
  for (const entry of missing) console.error(`  ${entry}`);
  process.exit(1);
}
