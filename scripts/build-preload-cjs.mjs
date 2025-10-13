#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

function run(cmd, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: false, ...options });
    child.on('exit', (code) => {
      if (code === 0) return resolvePromise();
      reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

async function main() {
  const repoRoot = resolve(process.cwd());
  const mainDir = resolve(repoRoot, 'app/main');
  const tsconfig = join(mainDir, 'tsconfig.preload.cjs.json');
  if (!existsSync(tsconfig)) {
    throw new Error('Missing tsconfig.preload.cjs.json');
  }

  console.log('[info] Compiling preload (CommonJS)...');
  await run('pnpm', ['--filter', '@aiembodied/main', 'exec', 'tsc', '-p', 'tsconfig.preload.cjs.json'], { cwd: mainDir });

  const builtCjs = join(mainDir, 'dist-cjs', 'preload.js');
  if (!existsSync(builtCjs)) {
    throw new Error(`CJS preload build missing at ${builtCjs}`);
  }

  const distDir = join(mainDir, 'dist');
  if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });

  const target = join(distDir, 'preload.cjs');
  copyFileSync(builtCjs, target);
  console.log('[info] Wrote CommonJS preload at:', target);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});

