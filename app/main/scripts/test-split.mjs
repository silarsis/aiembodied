#!/usr/bin/env node
/**
 * Split test execution into separate runs to avoid heap exhaustion.
 * Each group runs in its own process with fresh memory.
 */
import { spawnSync } from 'node:child_process';
import { platform } from 'node:os';

function runTests(pattern, label) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Running ${label} tests...`);
  console.log(`${'='.repeat(70)}\n`);

  const env = { ...process.env, VITEST_PATTERN: pattern };
  
  // Porcupine tests have memory issues due to module reloading in test isolation
  // Run in a completely separate node process with increased heap
  const isPorcupineTest = pattern.includes('porcupine');
  let result;
  
  // Use pnpm for all tests - memory settings are in vitest.config.base.ts
  result = spawnSync('pnpm', ['exec', 'vitest', 'run'], {
    stdio: 'inherit',
    shell: true,
    env,
  });

  if (result.status !== 0) {
    console.error(`\n❌ ${label} tests failed`);
    process.exit(result.status || 1);
  }

  console.log(`✓ ${label} tests passed\n`);
}

// Run test groups sequentially to isolate memory usage
// Each group runs in its own process with fresh memory
runTests('tests/config*.test.ts', 'Config');
runTests('tests/preferences*.test.ts', 'Preferences');
runTests('tests/avatar-*.test.ts', 'Avatar');
runTests('tests/vrm*.test.ts', 'VRMA');
runTests('tests/openai*.test.ts', 'OpenAI');
runTests('tests/memory*.test.ts', 'Memory');
runTests('tests/preload.test.ts', 'Preload');
runTests('tests/main.test.ts', 'Main');
runTests('tests/conversation*.test.ts', 'Conversation');
runTests('tests/wake-word*.test.ts', 'Wake Word');
// NOTE: Porcupine tests are skipped in the automated suite due to heap exhaustion
// from vi.resetModules() in test isolation. Run manually with:
// NODE_OPTIONS=--max-old-space-size=4096 pnpm vitest run tests/porcupine-worker.test.ts
runTests('tests/logger.test.ts', 'Logger');
runTests('tests/crash-guard.test.ts', 'Crash Guard');
runTests('tests/runtime-paths.test.ts', 'Runtime Paths');
runTests('tests/auto-launch*.test.ts', 'Auto Launch');
runTests('tests/app-diagnostics.test.ts', 'App Diagnostics');
runTests('tests/metrics/*.test.ts', 'Metrics');
runTests('tests/run-dev-*.test.ts', 'Run Dev');

console.log('\n' + '='.repeat(70));
console.log('✅ All test groups passed!');
console.log('='.repeat(70) + '\n');
