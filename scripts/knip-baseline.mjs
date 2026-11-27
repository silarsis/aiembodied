// Runs knip and compares the findings with the committed knip-baseline.json.
// New findings fail; findings that were fixed are reported so the baseline can shrink.
//   node scripts/knip-baseline.mjs            check against the baseline
//   node scripts/knip-baseline.mjs --update   rewrite the baseline from the current findings
//
// Two runs are recorded:
//   all         the default run: tests count as users of an export.
//   productionOnly  `knip --production`: tests do not count, so this also lists
//                   exports and files that only tests use (rules 1 and 9).
// Findings are keyed by kind, file and name, with no line numbers, so editing a file
// does not make old findings look new. Moving or renaming a file does: run --update then.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = join(root, 'knip-baseline.json');
const update = process.argv.includes('--update');

// Issue lists in knip's JSON report that hold named findings, and the kind we record them as.
const NAMED_KINDS = [
  'dependencies',
  'devDependencies',
  'optionalPeerDependencies',
  'unlisted',
  'unresolved',
  'binaries',
  'exports',
  'types',
  'enumMembers',
  'namespaceMembers',
  'duplicates',
  'catalog',
  'catalogReferences',
  'subpaths',
];

function runKnip(extraArgs) {
  const result = spawnSync(
    'pnpm',
    ['exec', 'knip', '--no-exit-code', '--no-progress', '--reporter', 'json', ...extraArgs],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      shell: process.platform === 'win32',
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`knip failed (${result.status}): ${result.error ?? result.stderr}`);
  }
  const report = JSON.parse(result.stdout);
  const keys = new Set();
  for (const issue of report.issues) {
    for (const file of issue.files) keys.add(`files|${file.name}|`);
    for (const kind of NAMED_KINDS) {
      for (const item of issue[kind] ?? []) {
        // Duplicate exports are reported as an array of names.
        const name = item.name ?? (item.names ? item.names.join('/') : String(item));
        keys.add(`${kind}|${issue.file}|${name}`);
      }
    }
  }
  return keys;
}

function summarise(keys) {
  const counts = {};
  for (const key of keys) {
    const kind = key.split('|')[0];
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return Object.entries(counts)
    .sort()
    .map(([kind, n]) => `${kind}: ${n}`)
    .join(', ');
}

const productionOnly = (keys) =>
  new Set([...keys].filter((key) => ['files', 'exports', 'types'].includes(key.split('|')[0])));

const current = {
  all: runKnip([]),
  productionOnly: productionOnly(runKnip(['--production'])),
};

if (update) {
  const out = {
    _comment:
      'Known knip findings (kind|file|name). Only new findings fail CI. Regenerate with `pnpm knip:update`; shrink it by fixing findings.',
    all: [...current.all].sort(),
    productionOnly: [...current.productionOnly].sort(),
  };
  writeFileSync(baselinePath, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`knip baseline written. all (${current.all.size}): ${summarise(current.all)}`);
  console.log(
    `productionOnly (${current.productionOnly.size}): ${summarise(current.productionOnly)}`,
  );
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
let failed = false;
for (const run of ['all', 'productionOnly']) {
  const known = new Set(baseline[run]);
  const added = [...current[run]].filter((key) => !known.has(key)).sort();
  const fixed = [...known].filter((key) => !current[run].has(key));
  if (fixed.length > 0) {
    console.log(
      `knip (${run}): ${fixed.length} baselined findings are gone; run pnpm knip:update to shrink the baseline.`,
    );
  }
  if (added.length > 0) {
    failed = true;
    console.error(`knip (${run}): ${added.length} new finding(s):`);
    for (const key of added) {
      const [kind, file, name] = key.split('|');
      console.error(`  ${kind}  ${file}${name ? `  ${name}` : ''}`);
    }
  }
}
if (failed) {
  console.error(
    '\nRemove the unused code or dependency. If knip is wrong (a file loaded by path, a moved file),' +
      ' fix knip.json or run `pnpm knip:update` and say why in the PR.',
  );
  process.exit(1);
}
console.log('knip: no new findings.');
