// Runs a plan of trials in the sit lab page, one at a time, and writes results/<runId>/.
// Usage: node run.mjs --plan plans/smoke.json --room <room.json> --avatar <avatar.vrm> [--assets <dir>]
//   [--run-id <id>] [--url http://localhost:5199] [--headed] [--only <method name>]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { appendSummaryRow } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const MAX_FAILURES_IN_A_ROW = 3;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument ${key}`);
    const name = key.slice(2);
    if (name === 'headed') args.headed = true;
    else {
      const value = argv[(i += 1)];
      if (value === undefined) throw new Error(`--${name} needs a value`);
      args[name] = value;
    }
  }
  return args;
}

async function reachable(url) {
  try {
    return (await fetch(`${url}/sit-lab.html`)).ok;
  } catch {
    return false;
  }
}

/** Uses the dev server at `url`, or starts one for the renderer and waits for it. */
async function ensureVite(url) {
  if (await reachable(url)) return null;
  const port = new URL(url).port || '5199';
  console.log(`Starting the vite dev server on port ${port}...`);
  const child = spawn(
    'pnpm',
    ['--filter', './app/renderer', 'exec', 'vite', '--port', port, '--strictPort'],
    { cwd: repoRoot, shell: true, stdio: 'ignore' },
  );
  for (let i = 0; i < 90; i += 1) {
    if (await reachable(url)) return child;
    await new Promise((done) => setTimeout(done, 1000));
  }
  stopTree(child);
  throw new Error(`The vite dev server did not come up at ${url} within 90 s.`);
}

/** With `shell: true` the child is the shell; on Windows killing it leaves vite running, so end the whole tree. */
function stopTree(child) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else child.kill();
}

/** Waits for the motion service to finish loading its model (ARDY takes about 100 s); a fake backend is an error. */
async function waitForMotion(motionUrl) {
  let last = 'no answer';
  for (let i = 0; i < 60; i += 1) {
    try {
      const health = await (await fetch(`${motionUrl}/health`)).json();
      if (health.backend === 'fake') {
        throw new Error(`The motion service at ${motionUrl} runs the fake backend.`);
      }
      if (health.status === 'error') {
        throw new Error(`The motion service at ${motionUrl} failed: ${JSON.stringify(health)}`);
      }
      if (health.ready) return;
      last = JSON.stringify(health);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('The motion service')) throw error;
      last = error instanceof Error ? error.message : String(error);
    }
    if (i === 0) console.log(`Waiting for the motion service at ${motionUrl} to be ready...`);
    await new Promise((done) => setTimeout(done, 5000));
  }
  throw new Error(`The motion service at ${motionUrl} was not ready within 5 minutes (${last}).`);
}

/** Start positions are given relative to the seat: where the avatar stands when the trial begins. */
function startFor(plan, name, seat, facingDeg) {
  const spec = plan.starts[name];
  if (!spec) throw new Error(`Plan has no start called ${name}`);
  const bearing = ((facingDeg + spec.bearingDeg) * Math.PI) / 180;
  const x = seat.position[0] + Math.sin(bearing) * spec.distance;
  const z = seat.position[2] + Math.cos(bearing) * spec.distance;
  // Heading 0 faces +Z and 90 faces +X: look at the seat.
  return { x, z, heading: (facingDeg + spec.bearingDeg + 180) % 360 };
}

function save(file, data) {
  writeFileSync(file, JSON.stringify(data));
}

function saveImage(file, dataUrl) {
  writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
}

const args = parseArgs(process.argv.slice(2));
for (const need of ['plan', 'room', 'avatar']) {
  if (!args[need]) throw new Error(`Missing --${need}`);
}
const plan = JSON.parse(readFileSync(resolve(args.plan), 'utf8'));
const roomJson = JSON.parse(readFileSync(resolve(args.room), 'utf8'));
const seat = roomJson.objects.find((object) => object.id === plan.seatObjectId);
if (!seat) {
  const ids = roomJson.objects.map((object) => `${object.id} (${object.name})`).join(', ');
  throw new Error(`The room has no object ${plan.seatObjectId}. Objects: ${ids}`);
}
const runId = args['run-id'] ?? plan.runId;
const runDir = join(here, 'results', runId);
mkdirSync(runDir, { recursive: true });
const url = args.url ?? 'http://localhost:5199';
const assetsDir = args.assets ? resolve(args.assets) : null;

const motionUrl = plan.motionUrl ?? 'http://127.0.0.1:8190';
await waitForMotion(motionUrl);
const viteChild = await ensureVite(url);
const browser = await chromium.launch(
  process.platform === 'win32'
    ? { channel: 'msedge', headless: !args.headed }
    : {
        headless: !args.headed,
        args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
      },
);
let failedInARow = 0;
let ok = 0;
let skipped = 0;
let failed = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
  page.on('pageerror', (error) => console.log('[page error]', error.message));
  const cors = { 'access-control-allow-origin': '*' };
  await page.route('**/lab-files/avatar.vrm', (route) =>
    route.fulfill({ path: resolve(args.avatar), headers: cors }),
  );
  await page.route('**/lab-assets/**', (route) => {
    const relative = decodeURIComponent(new URL(route.request().url()).pathname).replace(
      /^\/lab-assets\//,
      '',
    );
    const file = assetsDir ? join(assetsDir, relative) : null;
    if (file && existsSync(file)) return route.fulfill({ path: file, headers: cors });
    return route.fulfill({ status: 404, body: `no asset ${relative}` });
  });
  await page.goto(`${url}/sit-lab.html`);
  const spec = {
    roomJson,
    avatarUrl: '/lab-files/avatar.vrm',
    motionUrl,
    seatObjectId: plan.seatObjectId,
    start: { x: seat.position[0], z: seat.position[2] + 2, heading: 180 },
  };
  const info = await page.evaluate((s) => window.sitLab.load(s), spec);
  console.log(
    `Loaded: avatar hips ${info.restHipsHeight.toFixed(3)} m, seat faces ${info.seatFacingDeg.toFixed(1)} deg`,
  );

  const methods = plan.methods.filter((m) => !args.only || m.name === args.only);
  for (const method of methods) {
    mkdirSync(join(runDir, method.name), { recursive: true });
    for (const startName of plan.startNames) {
      for (const seed of plan.seeds) {
        const trialId = `${method.name}/${startName}-s${seed}`;
        const base = join(runDir, method.name, `${startName}-s${seed}`);
        if (existsSync(`${base}.json`)) {
          skipped += 1;
          continue;
        }
        const trial = {
          method: method.method,
          params: method.params ?? {},
          seed,
          start: startFor(plan, startName, seat, info.seatFacingDeg),
          ...(method.prompt ? { prompt: method.prompt } : {}),
        };
        try {
          const result = await page.evaluate((t) => window.sitLab.runTrial(t), trial);
          const { poses, captures, ...rest } = result;
          save(`${base}.poses.json`, poses);
          for (const [view, data] of Object.entries(captures.final)) {
            saveImage(`${base}-final-${view}.png`, data);
          }
          captures.sit.forEach((data, i) => saveImage(`${base}-sit-${i}.png`, data));
          const record = { trialId, methodName: method.name, startName, ...rest };
          writeFileSync(`${base}.json`, JSON.stringify(record, null, 1));
          appendSummaryRow(runDir, record);
          ok += 1;
          failedInARow = 0;
          console.log(
            `${trialId}: ${rest.metrics.pass ? 'pass' : `fail ${rest.metrics.failures.join(',')}`}`,
          );
        } catch (error) {
          failed += 1;
          failedInARow += 1;
          const message = error instanceof Error ? error.message : String(error);
          writeFileSync(`${base}.error.txt`, message);
          console.log(`${trialId}: ERROR ${message.split('\n')[0]}`);
          if (failedInARow >= MAX_FAILURES_IN_A_ROW) {
            throw new Error(
              `Stopping after ${MAX_FAILURES_IN_A_ROW} failed trials in a row. Last: ${message}`,
            );
          }
        }
      }
    }
  }
} finally {
  console.log(`Done: ${ok} run, ${skipped} already done, ${failed} failed. Results in ${runDir}`);
  await browser.close();
  if (viteChild) stopTree(viteChild);
}
