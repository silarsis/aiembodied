/**
 * Method 10: a planning method (whole-body targets or best of N) followed by a correction (rigid translate, hips-only
 * IK or the app's own pipeline). The parts' parameters are given as `plan.<name>` and `fix.<name>`.
 */
import { bestOfN } from './best-of-n.js';
import { hipsOnlyIK } from './hips-ik.js';
import { rigidTranslate } from './translate.js';
import { wholeBodyTargets } from './targets.js';
import { stringParam, type Corrector, type Method, type ParamSpec } from './types.js';
import type { Params } from '../types.js';

const PLANNERS: readonly Method[] = [wholeBodyTargets, bestOfN];
const FIXERS: readonly Method[] = [rigidTranslate, hipsOnlyIK];

const prefixed = (prefix: string, methods: readonly Method[]): ParamSpec[] => {
  const seen = new Set<string>();
  const specs: ParamSpec[] = [];
  for (const spec of methods.flatMap((method) => method.params)) {
    if (seen.has(spec.name)) continue;
    seen.add(spec.name);
    specs.push({ ...spec, name: `${prefix}.${spec.name}` });
  }
  return specs;
};

/** The values a part reads out of the combined parameters. */
function partParams(params: Params, prefix: string, method: Method): Params {
  return Object.fromEntries(
    method.params.map((spec) => [spec.name, params[`${prefix}.${spec.name}`] ?? spec.default]),
  );
}

function find(methods: readonly Method[], id: string): Method | null {
  return methods.find((method) => method.id === id) ?? null;
}

export const combo: Method = {
  id: 'combo',
  label: 'Planning plus correction',
  params: [
    {
      name: 'planning',
      doc: 'How the motion is asked for: the plain plan (none), whole-body targets or best of N.',
      default: 'wholeBodyTargets',
      options: ['none', ...PLANNERS.map((method) => method.id)],
    },
    {
      name: 'correction',
      doc: 'What is done to the motion afterwards: nothing, a rigid translate, hips-only IK or the app pipeline (baseline).',
      default: 'rigidTranslate',
      options: ['none', 'baseline', ...FIXERS.map((method) => method.id)],
    },
    ...prefixed('plan', PLANNERS),
    ...prefixed('fix', FIXERS),
  ],
  async plan(ctx, params) {
    const planner = find(PLANNERS, stringParam(params, 'planning'));
    if (!planner?.plan) return { motion: await ctx.generate(ctx.baseRequest, ctx.seed) };
    return planner.plan(ctx, partParams(params, 'plan', planner));
  },
  correct(ctx, motion, params): Corrector {
    const choice = stringParam(params, 'correction');
    if (choice === 'baseline') return { appPipeline: true, frame: () => undefined };
    const fixer = find(FIXERS, choice);
    if (!fixer?.correct) return { appPipeline: false, frame: () => undefined };
    return fixer.correct(ctx, motion, partParams(params, 'fix', fixer));
  },
};
