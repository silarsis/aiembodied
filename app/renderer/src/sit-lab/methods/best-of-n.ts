/**
 * Method 8: ask the model several times (different seeds, two wordings of the sit prompt), score each result's
 * end pose against the seat, and keep the best. Nothing is corrected afterwards.
 */
import type { StreamRequestPlan } from '../../rooms/scene-actions.js';
import { hingeExcessDeg } from '../metrics.js';
import {
  numberParam,
  type Method,
  type MethodContext,
  type MotionClip,
  type Planned,
} from './types.js';

const WORDINGS = [
  'a person turns around and sits down on a chair',
  'a person turns around and sits down in an armchair',
];

/** The plan's request with the sit prompt replaced: the second phase of a walk-then-sit, else the prompt itself. */
export function withSitPrompt(request: StreamRequestPlan, prompt: string): StreamRequestPlan {
  const [first, ...rest] = request.phases ?? [];
  return first ? { ...request, phases: [{ ...first, prompt }, ...rest] } : { ...request, prompt };
}

/** Lower is better. All terms are metres except the hinge excess, which counts a degree as a centimetre. */
function score(ctx: MethodContext, motion: MotionClip): number {
  const end = motion.poses[motion.poses.length - 1];
  if (!end) throw new Error('The motion has no frames.');
  return ctx.timed(() => {
    ctx.rig.writePose(end);
    ctx.rig.placeRoot([0, 0, 0]);
    const m = ctx.measure();
    const feetShort = Math.max(0, ctx.dest.frontEdge - Math.min(...m.ankleAlong));
    return (
      10 * m.furniturePen +
      10 * m.selfPen +
      5 * Math.abs(m.seatGap) +
      3 * m.pelvisToSit +
      5 * Math.max(Math.abs(m.sole[0]), Math.abs(m.sole[1])) +
      5 * feetShort +
      hingeExcessDeg(end) / 100
    );
  });
}

export const bestOfN: Method = {
  id: 'bestOfN',
  label: 'Best of N',
  params: [
    {
      name: 'n',
      doc: 'Seeds to try; each is run with both wordings, so the model is called 2n times.',
      default: 3,
      min: 1,
      max: 8,
    },
  ],
  async plan(ctx, params): Promise<Planned> {
    let best: { motion: MotionClip; score: number } | null = null;
    for (let k = 0; k < numberParam(params, 'n'); k += 1) {
      for (const wording of WORDINGS) {
        const motion = await ctx.generate(withSitPrompt(ctx.baseRequest, wording), ctx.seed + k);
        const scored = score(ctx, motion);
        if (!best || scored < best.score) best = { motion, score: scored };
      }
    }
    if (!best) throw new Error('bestOfN made no model call.');
    return { motion: best.motion };
  },
};
