// Keeps big files from growing (rule 4: fix structure, don't pile on). Source files over LIMIT lines
// are recorded in file-size-ratchet.json with their current size. A recorded file may not grow, and
// no other file may pass LIMIT.
//   node scripts/file-size-ratchet.mjs            check
//   node scripts/file-size-ratchet.mjs --update   lower recorded sizes, drop files that fell under
//                                                 LIMIT, and record newly large files only on --init
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ratchetPath = join(root, 'file-size-ratchet.json');
const LIMIT = 1500;
const init = process.argv.includes('--init');
const update = process.argv.includes('--update') || init;

function lineCount(path) {
  const text = readFileSync(join(root, path), 'utf8');
  return text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

const tracked = execFileSync('git', ['ls-files', '--', 'app', 'scripts'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\n')
  .filter((path) => /\.(ts|tsx|mjs)$/.test(path));
const sizes = new Map(tracked.map((path) => [path, lineCount(path)]));

const recorded = init ? {} : JSON.parse(readFileSync(ratchetPath, 'utf8')).maxLines;
const problems = [];
const next = {};

for (const [path, size] of sizes) {
  const max = recorded[path];
  if (max === undefined) {
    if (size > LIMIT) {
      if (init) next[path] = size;
      else
        problems.push(
          `${path} has ${size} lines; new files may not pass ${LIMIT}. Split it by feature.`,
        );
    }
  } else if (size > max) {
    problems.push(
      `${path} grew to ${size} lines (recorded maximum ${max}). Move code out instead of adding to it.`,
    );
  } else if (size > LIMIT) {
    next[path] = size;
  }
}
// The two files the layering work is about stay listed even if they shrink below the limit.
for (const path of ['app/main/src/main.ts', 'app/renderer/src/App.tsx']) {
  if (sizes.has(path)) next[path] = Math.min(sizes.get(path), recorded[path] ?? Infinity);
}

if (update) {
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
  const out = {
    _comment: `Maximum line counts for source files over ${LIMIT} lines. Lower them with \`pnpm size-ratchet --update\` when a file shrinks; never raise them.`,
    maxLines: sorted,
  };
  writeFileSync(ratchetPath, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`file-size-ratchet.json written (${Object.keys(sorted).length} files).`);
  process.exit(0);
}

const shrunk = Object.entries(recorded).filter(([path, max]) => (sizes.get(path) ?? 0) < max);
if (shrunk.length > 0) {
  console.log(
    `${shrunk.length} recorded file(s) shrank; run pnpm size-ratchet --update to lock that in.`,
  );
}
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('size-ratchet: ok.');
