import relaxed_neutral from './base-poses/relaxed-neutral.pose.json' with { type: 'json' };
import happiness from './base-poses/happiness.pose.json' with { type: 'json' };
import sadness from './base-poses/sadness.pose.json' with { type: 'json' };
import anger from './base-poses/anger.pose.json' with { type: 'json' };
import fear from './base-poses/fear.pose.json' with { type: 'json' };
import disgust from './base-poses/disgust.pose.json' with { type: 'json' };
import surprise from './base-poses/surprise.pose.json' with { type: 'json' };

/** Approved static stances, including the chest compensation and calibrated forward arm swing. */
export const BASE_POSES = [
  { id: 'builtin:relaxed-neutral', name: 'Relaxed neutral', data: relaxed_neutral },
  { id: 'builtin:happiness', name: 'Happiness', data: happiness },
  { id: 'builtin:sadness', name: 'Sadness', data: sadness },
  { id: 'builtin:anger', name: 'Anger', data: anger },
  { id: 'builtin:fear', name: 'Fear', data: fear },
  { id: 'builtin:disgust', name: 'Disgust', data: disgust },
  { id: 'builtin:surprise', name: 'Surprise', data: surprise },
] as const;

/** Exact hash of the old renderer-generated default; customized poses are preserved. */
export const LEGACY_DEFAULT_POSE_SHA = '55f0c9cf471102b018b605f0be73ace9e4cb48c6bb42be01704f5458719b54ff';
