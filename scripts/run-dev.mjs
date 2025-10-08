#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

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
  const envPath = resolve(repoRoot, '.env');
  if (!existsSync(envPath)) {
    console.warn('[warn] .env not found at repo root. Dev run expects REALTIME_API_KEY and PORCUPINE_ACCESS_KEY.');
  }

  // Verify pnpm is available
  await run('pnpm', ['-v']).catch((e) => {
    console.error('pnpm is required. Run the setup script first.');
    throw e;
  });

  // Build renderer and main
  await run('pnpm', ['--filter', '@aiembodied/renderer', 'build']);
  await run('pnpm', ['--filter', '@aiembodied/main', 'build']);

  // Rebuild native deps for Electron runtime (ensures better-sqlite3/keytar ABI matches Electron)
  await run('pnpm', ['--filter', '@aiembodied/main', 'exec', 'electron-builder', 'install-app-deps']);

  // Launch Electron with compiled main
  await run('pnpm', ['--filter', '@aiembodied/main', 'exec', 'electron', 'dist/main.js']);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});

