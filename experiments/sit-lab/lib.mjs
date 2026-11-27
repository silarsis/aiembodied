// Shared by run.mjs and judge.mjs: the layout of a run folder and its summary.csv.
import { existsSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

export const COLUMNS = [
  'trialId',
  'method',
  'start',
  'seed',
  'pass',
  'failures',
  'furnitureEnd',
  'furnitureDescent',
  'selfPen',
  'seatGap',
  'pelvisToSit',
  'footFloor',
  'feetInFront',
  'shapeMeanDeg',
  'shapeMaxDeg',
  'translationUsed',
  'hingeBreaks',
  'hingeMaxDeg',
  'jerkPeak',
  'settleTimeS',
  'footSlide',
  'modelCalls',
  'modelMs',
  'computeMs',
  'visionScore',
];

const round = (value, digits = 4) =>
  typeof value === 'number' ? String(Math.round(value * 10 ** digits) / 10 ** digits) : '';

export function rowFor(trial) {
  const m = trial.metrics;
  return [
    trial.trialId,
    trial.methodName,
    trial.startName,
    trial.seed,
    m.pass,
    m.failures.join(';'),
    round(m.furnitureMaxPenetrationEnd),
    round(m.furnitureMaxPenetrationDescent),
    round(m.selfPenetrationMax),
    round(m.seatGap),
    round(m.pelvisToSitPoint),
    round(m.footFloorError),
    m.feetInFrontOfSeat,
    round(m.shapeChangeMeanDeg, 2),
    round(m.shapeChangeMaxDeg, 2),
    round(m.translationUsed),
    m.hingeBreaks.count,
    round(m.hingeBreaks.maxDeg, 2),
    round(m.jerkPeak, 1),
    m.settleTimeS === null ? '' : round(m.settleTimeS, 3),
    round(m.footSlideDescent),
    trial.modelCalls,
    Math.round(trial.modelMs),
    Math.round(m.computeMs),
    trial.visionScore ?? '',
  ].join(',');
}

export function appendSummaryRow(runDir, trial) {
  const file = join(runDir, 'summary.csv');
  if (!existsSync(file)) writeFileSync(file, `${COLUMNS.join(',')}\n`);
  appendFileSync(file, `${rowFor(trial)}\n`);
}

/** The trial result files of a run (not the pose files), in a stable order. */
export function trialFiles(runDir) {
  const files = [];
  for (const method of readdirSync(runDir, { withFileTypes: true })) {
    if (!method.isDirectory()) continue;
    for (const name of readdirSync(join(runDir, method.name))) {
      if (name.endsWith('.json') && !name.endsWith('.poses.json')) {
        files.push(join(runDir, method.name, name));
      }
    }
  }
  return files.sort();
}

export function rewriteSummary(runDir) {
  const rows = trialFiles(runDir).map((file) => rowFor(JSON.parse(readFileSync(file, 'utf8'))));
  writeFileSync(join(runDir, 'summary.csv'), `${[COLUMNS.join(','), ...rows].join('\n')}\n`);
}
