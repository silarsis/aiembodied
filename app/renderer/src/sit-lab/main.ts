/**
 * The sit lab page (dev only, see sit-lab.html): `window.sitLab` is what the Node driver in experiments/sit-lab
 * calls. Nothing runs by itself; every trial is stepped by the lab at a fixed 1/30 s.
 */
import { setAssetUrlResolver } from '../rooms/asset-url.js';
import { destinationFor, type Destination } from './destination.js';
import { LabWorld } from './lab-world.js';
import { describeMethods } from './methods/index.js';
import { captureView, runTrial, type TrialResult } from './trial.js';
import type { LabSpec, TrialSpec, ViewName } from './types.js';

/** Where the driver serves the room asset cache (`aiembodied-asset://<asset>/<file>` becomes `/lab-assets/<asset>/<file>`). */
const ASSET_ROOT = '/lab-assets/';

interface Session {
  world: LabWorld;
  spec: LabSpec;
  dest: Destination;
}

let session: Session | null = null;

function loaded(): Session {
  if (!session) throw new Error('Call sitLab.load(spec) first.');
  return session;
}

const sitLab = {
  /** Loads the room and the avatar (replacing any earlier ones). */
  async load(spec: LabSpec): Promise<{ restHipsHeight: number; seatFacingDeg: number }> {
    session?.world.dispose();
    session = null;
    setAssetUrlResolver((url) => url.replace(/^aiembodied-asset:\/\//, ASSET_ROOT));
    const host = document.getElementById('lab');
    if (!host) throw new Error('The page has no #lab element.');
    const world = await LabWorld.create(spec, host);
    world.placeAt(spec.start);
    const dest = destinationFor(world.planWorld(), spec.seatObjectId);
    session = { world, spec, dest };
    return {
      restHipsHeight: world.rig.restHipsHeight,
      seatFacingDeg: (dest.facing * 180) / Math.PI,
    };
  },
  /** Runs one trial and returns its result, poses and screenshots. */
  runTrial(trial: TrialSpec): Promise<TrialResult> {
    const { world, spec } = loaded();
    return runTrial(world, spec, trial);
  },
  /** Renders the avatar as it is now from a named view and returns a PNG data URL. */
  capture(view: ViewName): string {
    const { world, dest } = loaded();
    return captureView(world, dest, view);
  },
  /** Every method with its parameters, defaults and allowed ranges. */
  methods: describeMethods,
};

export type SitLab = typeof sitLab;
Object.assign(window, { sitLab });
