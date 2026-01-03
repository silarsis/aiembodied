#!/usr/bin/env node
/**
 * Run tests using Electron as the Node.js runtime.
 * This ensures native modules built for Electron work correctly in tests.
 * 
 * Key insight: We must spawn Electron's executable directly (not via node),
 * so that process.execPath inside vitest points to Electron.
 * This way, when vitest's forks pool spawns child processes, they also use Electron.
 */
import { spawnSync, execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const mainRoot = resolve(__dirname, '..');

// Find the actual Electron executable
// On Windows, electron/cli.js is a wrapper that uses the electron in dist/
function findElectronExe() {
    // Try the packaged electron location
    const electronDist = resolve(mainRoot, 'node_modules/electron/dist/electron.exe');
    if (existsSync(electronDist)) {
        return electronDist;
    }

    // Fallback: read electron/path.txt which contains the path to the executable
    const pathTxt = resolve(mainRoot, 'node_modules/electron/path.txt');
    if (existsSync(pathTxt)) {
        const relativePath = readFileSync(pathTxt, 'utf8').trim();
        const fullPath = resolve(mainRoot, 'node_modules/electron', relativePath);
        if (existsSync(fullPath)) {
            return fullPath;
        }
    }

    return null;
}

const electronExe = findElectronExe();
if (!electronExe) {
    console.error('Electron executable not found.');
    console.error('Run "pnpm install" in app/main first.');
    process.exit(1);
}

// Find vitest's CLI entry point
// Look for vitest bin in the workspace node_modules
const vitestBin = resolve(repoRoot, 'node_modules/vitest/vitest.mjs');
const vitestBinAlt = resolve(repoRoot, 'node_modules/.bin/vitest');

let vitestEntry = null;
if (existsSync(vitestBin)) {
    vitestEntry = vitestBin;
} else {
    // Try to find it via pnpm
    try {
        const result = execSync('pnpm exec which vitest', {
            cwd: mainRoot,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe']
        }).trim();
        // The result is a Unix-style path, convert to Windows
        vitestEntry = result.replace(/^\/([a-z])\//, '$1:/').replace(/\//g, '\\');
    } catch {
        console.error('Could not find vitest.');
        process.exit(1);
    }
}

// Get the pattern from environment variable (set by test-split.mjs)
// Note: The pattern is NOT passed as a CLI argument because vitest.config.ts
// already reads VITEST_PATTERN and sets it as the `include` option.
// Passing it as CLI arg would cause conflicts with glob patterns.
const pattern = process.env.VITEST_PATTERN;

// Build vitest arguments - just 'run', no pattern (handled by config)
const vitestArgs = ['run'];

console.log('[test-electron] Electron executable:', electronExe);
console.log('[test-electron] Vitest entry:', vitestEntry);
console.log('[test-electron] Pattern:', pattern || '(all tests)');
console.log('[test-electron] Running with ELECTRON_RUN_AS_NODE=1');

// Run vitest directly using Electron as the executable
// ELECTRON_RUN_AS_NODE=1 makes Electron behave like Node but with Electron's ABI
// Since we're running Electron directly, process.execPath will be Electron's path,
// which means child processes spawned by vitest will also use Electron
const result = spawnSync(electronExe, [vitestEntry, ...vitestArgs], {
    stdio: 'inherit',
    env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
    },
    cwd: mainRoot,
});

process.exit(result.status ?? 1);

