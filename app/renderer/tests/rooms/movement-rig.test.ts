import { describe, expect, it, vi } from 'vitest';
import { SceneActionExecutor, type SceneActivity, type SceneBridge } from '../../src/rooms/scene-executor.js';
import { MAX_TRACKED_STREAMS, MovementRigs } from '../../src/rooms/movement-rig.js';

describe('MovementRigs', () => {
  it('maps streams to avatars and forgets them when they end', () => {
    const rigs = new MovementRigs();
    rigs.registerStream('a', 'sage');
    rigs.registerStream('b', 'rex');
    expect(rigs.avatarForStream('a')).toBe('sage');
    expect(rigs.avatarForStream('b')).toBe('rex');
    expect(rigs.streamIds()).toEqual(['a', 'b']);
    rigs.endStream('a');
    expect(rigs.avatarForStream('a')).toBeUndefined();
    expect(rigs.avatarForStream('nope')).toBeUndefined();
  });

  it('caps the number of tracked streams, dropping the oldest', () => {
    const rigs = new MovementRigs();
    for (let i = 0; i < MAX_TRACKED_STREAMS + 5; i += 1) rigs.registerStream(`s${i}`, 'sage');
    expect(rigs.streamIds()).toHaveLength(MAX_TRACKED_STREAMS);
    expect(rigs.avatarForStream('s0')).toBeUndefined();
    expect(rigs.avatarForStream(`s${MAX_TRACKED_STREAMS + 4}`)).toBe('sage');
  });

  it('gives each avatar its own repeat filter', () => {
    const rigs = new MovementRigs();
    expect(rigs.filterFor('sage')).toBe(rigs.filterFor('sage'));
    expect(rigs.filterFor('sage').shouldStart('waves')).toBe(true);
    expect(rigs.filterFor('sage').shouldStart('waves')).toBe(false);
    expect(rigs.filterFor('rex').shouldStart('waves')).toBe(true);
  });

  it('drops an avatar with its streams and filter', () => {
    const rigs = new MovementRigs();
    rigs.registerStream('a', 'sage');
    rigs.registerStream('b', 'rex');
    rigs.filterFor('sage').shouldStart('waves');
    rigs.drop('sage');
    expect(rigs.avatarForStream('a')).toBeUndefined();
    expect(rigs.avatarForStream('b')).toBe('rex');
    expect(rigs.filterFor('sage').shouldStart('waves')).toBe(true);
  });

  it('keeps Echo\'s injected executor and makes one per other avatar on first use', () => {
    const echo = new SceneActionExecutor();
    const rigs = new MovementRigs(echo);
    expect(rigs.get('echo').executor).toBe(echo);
    expect(rigs.get('echo').avatarId).toBe('echo');
    const sage = rigs.get('sage');
    expect(sage.executor).not.toBe(echo);
    expect(rigs.get('sage')).toBe(sage);
    expect(rigs.avatarIds()).toEqual(['echo', 'sage']);
  });

  it('gives each other avatar its own bridge, now and for executors made later', () => {
    const rigs = new MovementRigs();
    const sage = rigs.get('sage').executor;
    const setBridge = vi.spyOn(sage, 'setBridge');
    const bridgeFor = (id: string): SceneBridge => ({ streamMotion: vi.fn(), playChunk: vi.fn(), avatarRest: () => undefined, ...({ id } as object) });
    rigs.setBridgeFactory(bridgeFor);
    expect(setBridge).toHaveBeenCalledWith(expect.objectContaining({ id: 'sage' }));
    const rex = rigs.get('rex').executor;
    const rexBridge = vi.spyOn(rex, 'setBridge');
    rigs.setBridgeFactory(bridgeFor);
    expect(rexBridge).toHaveBeenCalledWith(expect.objectContaining({ id: 'rex' }));
    // Echo's bridge is App's own and is left alone.
    const echoBridge = vi.spyOn(rigs.get('echo').executor, 'setBridge');
    rigs.setBridgeFactory(null);
    expect(echoBridge).not.toHaveBeenCalled();
    expect(setBridge).toHaveBeenLastCalledWith(null);
  });

  it('offers a chunk to Echo first, then the others, and reports whether one took it', () => {
    const rigs = new MovementRigs();
    const order: string[] = [];
    const stub = (id: string, takes: boolean) =>
      vi.spyOn(rigs.get(id).executor, 'handleChunk').mockImplementation(() => {
        order.push(id);
        return takes;
      });
    stub('echo', false);
    stub('sage', true);
    stub('rex', true);
    const chunk = { streamId: 's1', index: 0, data: '' } as never;
    expect(rigs.handleChunk(chunk)).toBe(true);
    expect(order).toEqual(['echo', 'sage']);
    order.length = 0;
    vi.mocked(rigs.get('sage').executor.handleChunk).mockReturnValue(false);
    vi.mocked(rigs.get('rex').executor.handleChunk).mockReturnValue(false);
    expect(rigs.handleChunk(chunk)).toBe(false);
  });

  it('interrupts and resets every executor', () => {
    const rigs = new MovementRigs();
    const spies = ['echo', 'sage', 'rex'].map((id) => ({
      interrupt: vi.spyOn(rigs.get(id).executor, 'interrupt'),
      reset: vi.spyOn(rigs.get(id).executor, 'reset'),
    }));
    rigs.interruptAll();
    rigs.resetAll();
    for (const spy of spies) {
      expect(spy.interrupt).toHaveBeenCalledTimes(1);
      expect(spy.reset).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps a scene-tag filter per avatar', () => {
    const rigs = new MovementRigs();
    expect(rigs.sceneFilterFor('sage').shouldStart('{"go":"sofa"}')).toBe(true);
    expect(rigs.sceneFilterFor('sage').shouldStart('{"go":"sofa"}')).toBe(false);
    expect(rigs.sceneFilterFor('rex').shouldStart('{"go":"sofa"}')).toBe(true);
    expect(rigs.sceneFilterFor('sage')).not.toBe(rigs.filterFor('sage'));
  });

  it('reports the activity of other avatars\' executors only, and drop removes the executor', () => {
    const rigs = new MovementRigs();
    const seen: Array<[string, SceneActivity]> = [];
    rigs.onOtherActivity((id, activity) => seen.push([id, activity]));
    const sage = rigs.get('sage').executor;
    (sage as unknown as { emit(activity: SceneActivity): void }).emit({ type: 'skipped', label: 'go sofa', reason: 'no room' });
    (rigs.get('echo').executor as unknown as { emit(activity: SceneActivity): void }).emit({ type: 'skipped', label: 'x', reason: 'y' });
    expect(seen).toEqual([['sage', { type: 'skipped', label: 'go sofa', reason: 'no room' }]]);
    rigs.drop('sage');
    expect(rigs.avatarIds()).toEqual(['echo']);
    expect(rigs.get('sage').executor).not.toBe(sage);
    rigs.drop('echo');
    expect(rigs.get('echo')).toBeTruthy();
  });
});
