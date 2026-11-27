import { bestOfN } from './best-of-n.js';
import { combo } from './combo.js';
import { hipsOnlyIK } from './hips-ik.js';
import { poseOptimise } from './optimise.js';
import { closedLoop, landThenSettle, wholeBodyTargets } from './targets.js';
import { rigidTranslate, translateYaw } from './translate.js';
import type { Method } from './types.js';

/** Exactly the app's current sit: its plan, then its seat fit, contact solver and joint limits on every frame. */
const baseline: Method = {
  id: 'baseline',
  label: 'Baseline (the app)',
  params: [],
  correct: () => ({ appPipeline: true, frame: () => undefined }),
};

const METHODS: readonly Method[] = [
  baseline,
  rigidTranslate,
  translateYaw,
  closedLoop,
  wholeBodyTargets,
  hipsOnlyIK,
  poseOptimise,
  bestOfN,
  landThenSettle,
  combo,
];

export function findMethod(id: string): Method {
  const method = METHODS.find((candidate) => candidate.id === id);
  if (!method) {
    throw new Error(`Unknown method ${id}. Known: ${METHODS.map((m) => m.id).join(', ')}`);
  }
  return method;
}

/** Every method with its parameters, their defaults and allowed ranges. */
export function describeMethods(): Array<Pick<Method, 'id' | 'label' | 'params'>> {
  return METHODS.map(({ id, label, params }) => ({ id, label, params }));
}
