import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';

import { IdleAnimationScheduler } from '../../src/avatar/animations/idle-scheduler.js';

class StubAction {
  public enabled = false;
  public clampWhenFinished = false;
  public readonly reset = vi.fn(() => this as unknown as THREE.AnimationAction);
  public readonly play = vi.fn(() => this as unknown as THREE.AnimationAction);
  public readonly stop = vi.fn(() => this as unknown as THREE.AnimationAction);
  public readonly setLoop = vi.fn(() => this as unknown as THREE.AnimationAction);
  public readonly setEffectiveWeight = vi.fn(() => this as unknown as THREE.AnimationAction);
  public readonly setEffectiveTimeScale = vi.fn(() => this as unknown as THREE.AnimationAction);
  public readonly fadeIn = vi.fn(() => this as unknown as THREE.AnimationAction);
  public readonly fadeOut = vi.fn(() => this as unknown as THREE.AnimationAction);

  constructor(public readonly clip: THREE.AnimationClip) {}
}

class StubMixer {
  public readonly actions: StubAction[] = [];
  public readonly clipAction = vi.fn((clip: THREE.AnimationClip) => {
    const action = new StubAction(clip);
    this.actions.push(action);
    return action as unknown as THREE.AnimationAction;
  });
  public readonly addEventListener = vi.fn();
  public readonly removeEventListener = vi.fn();
}

function createMockVrm(): VRM {
  const scene = new THREE.Object3D();
  const bones = new Map<string, THREE.Object3D>();
  for (const name of ['spine', 'chest', 'upperChest', 'neck', 'head']) {
    const bone = new THREE.Object3D();
    bone.name = name;
    bones.set(name, bone);
  }

  const vrm = {
    scene,
    humanoid: {
      getNormalizedBoneNode: (name: string) => bones.get(name) ?? null,
    },
    expressionManager: {
      getExpressionTrackName: (name: string) => `expressions/${name}`,
    },
    meta: { metaVersion: '1' },
  } as unknown as VRM;

  return vrm;
}

function getActionByName(mixer: StubMixer, name: string): StubAction {
  const action = mixer.actions.find((entry) => entry.clip.name === name);
  if (!action) {
    throw new Error(`Action ${name} not registered`);
  }
  return action;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('IdleAnimationScheduler', () => {
  it('creates layered idle clips for breathing, micro head turns, and blinking', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.3);
    const mixer = new StubMixer();
    const scheduler = new IdleAnimationScheduler({
      mixer: mixer as unknown as THREE.AnimationMixer,
      vrm: createMockVrm(),
    });

    expect(scheduler).toBeTruthy();
    expect(mixer.clipAction).toHaveBeenCalled();

    const clipNames = mixer.actions.map((action) => action.clip.name);
    expect(clipNames).toContain('idle_breath');
    expect(clipNames).toContain('idle_micro_head');
    expect(clipNames).toContain('idle_blink');

    const breathing = getActionByName(mixer, 'idle_breath');
    const microHead = getActionByName(mixer, 'idle_micro_head');
    const blink = getActionByName(mixer, 'idle_blink');

    expect(breathing.play).toHaveBeenCalledTimes(1);
    expect(microHead.play).toHaveBeenCalledTimes(1);
    expect(blink.play).not.toHaveBeenCalled();
  });

  it('suppresses idle clips when suspended and resumes afterwards', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const mixer = new StubMixer();
    const scheduler = new IdleAnimationScheduler({
      mixer: mixer as unknown as THREE.AnimationMixer,
      vrm: createMockVrm(),
      options: { blinkInterval: [0.1, 0.1] },
    });

    const breathing = getActionByName(mixer, 'idle_breath');
    const microHead = getActionByName(mixer, 'idle_micro_head');
    const blink = getActionByName(mixer, 'idle_blink');

    breathing.play.mockClear();
    microHead.play.mockClear();
    blink.play.mockClear();

    const release = scheduler.suspend(10);
    expect(breathing.stop).toHaveBeenCalled();
    expect(microHead.stop).toHaveBeenCalled();

    scheduler.update(0.2);
    expect(blink.play).not.toHaveBeenCalled();

    release();
    expect(breathing.play).toHaveBeenCalledTimes(1);
    expect(microHead.play).toHaveBeenCalledTimes(1);

    scheduler.update(0.2);
    expect(blink.play).toHaveBeenCalledTimes(1);
  });

  it('cleans up mixer bindings on dispose', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.2);
    const mixer = new StubMixer();
    const scheduler = new IdleAnimationScheduler({
      mixer: mixer as unknown as THREE.AnimationMixer,
      vrm: createMockVrm(),
    });

    const [[eventName, handler]] = mixer.addEventListener.mock.calls as Array<[string, (event: unknown) => void]>;
    expect(eventName).toBe('finished');

    scheduler.dispose();

    expect(mixer.removeEventListener).toHaveBeenCalledWith('finished', handler);
    for (const action of mixer.actions) {
      expect(action.stop).toHaveBeenCalled();
    }
  });
});
