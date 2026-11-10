import { beforeEach, describe, expect, it, vi } from 'vitest';

declare module 'electron' {
  interface IpcRenderer {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    on: (channel: string, listener: (...args: unknown[]) => void) => void;
    removeListener: (channel: string, listener: (...args: unknown[]) => void) => void;
  }
}

const exposeInMainWorld = vi.fn();
const invoke = vi.fn();
const on = vi.fn();
const removeListener = vi.fn();

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, on, removeListener },
}));

describe('preload bridge', () => {
  beforeEach(async () => {
    vi.resetModules();
    exposeInMainWorld.mockClear();
    invoke.mockReset();
    on.mockReset();
    removeListener.mockReset();
    await import('../src/preload.js');
  });

  it('registers the aiembodied api with config bridge and ping helper', async () => {
    expect(exposeInMainWorld).toHaveBeenCalledTimes(1);
    const [key, api] = exposeInMainWorld.mock.calls[0];
    expect(key).toBe('aiembodied');
    expect(api.config).toBeDefined();
    expect(api.realtime).toBeDefined();
    expect(api.camera).toBeDefined();
    expect(api.ping()).toBe('pong');

    invoke.mockResolvedValueOnce({ hasRealtimeApiKey: true });
    await expect(api.config.get()).resolves.toEqual({ hasRealtimeApiKey: true });
    expect(invoke).toHaveBeenCalledWith('config:get');

    invoke.mockResolvedValueOnce('secret');
    await expect(api.config.getSecret('realtimeApiKey')).resolves.toBe('secret');
    expect(invoke).toHaveBeenCalledWith('config:get-secret', 'realtimeApiKey');

    invoke.mockResolvedValueOnce({ value: 'token' });
    await expect(api.realtime.mintEphemeralToken({ session: { type: 'realtime' } })).resolves.toEqual({ value: 'token' });
    expect(invoke).toHaveBeenCalledWith('realtime:mint-ephemeral-token', { session: { type: 'realtime' } });
  });

  it('routes config mutations and tests through ipc channels', async () => {
    const [, api] = exposeInMainWorld.mock.calls[0];

    const preferences = { audioInputDeviceId: 'mic', audioOutputDeviceId: 'spk' };
    invoke.mockResolvedValueOnce({ hasRealtimeApiKey: false });
    await api.config.setAudioDevicePreferences(preferences);
    expect(invoke).toHaveBeenCalledWith('config:set-audio-devices', preferences);

    invoke.mockResolvedValueOnce({ hasRealtimeApiKey: true });
    await api.config.setSecret('realtimeApiKey', 'next-key');
    expect(invoke).toHaveBeenCalledWith('config:set-secret', {
      key: 'realtimeApiKey',
      value: 'next-key',
    });

    const response = { ok: true, message: 'verified' };
    invoke.mockResolvedValueOnce(response);
    await expect(api.config.testSecret('realtimeApiKey')).resolves.toEqual(response);
    expect(invoke).toHaveBeenCalledWith('config:test-secret', 'realtimeApiKey');
  });

  it('provides a wake word subscription bridge', async () => {
    const [, api] = exposeInMainWorld.mock.calls[0];
    const listener = vi.fn();
    const unsubscribe = api.wakeWord.onWake(listener);

    expect(on).toHaveBeenCalledWith('wake-word:event', expect.any(Function));
    const handler = on.mock.calls[0][1];

    const payload = { keywordLabel: 'Porcupine', confidence: 0.8, timestamp: 123 };
    handler({}, payload);

    expect(listener).toHaveBeenCalledWith(payload);

    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith('wake-word:event', handler);
    await api.wakeWord.setListeningEnabled(false);
    expect(invoke).toHaveBeenCalledWith('wake-word:set-listening', false);
    await api.wakeWord.setListeningEnabled(true);
    expect(invoke).toHaveBeenCalledWith('wake-word:set-listening', true);
  });

  it('exposes the models and servers helpers through the bridge', async () => {
    const [, api] = exposeInMainWorld.mock.calls[0];
    invoke.mockResolvedValue({});
    await api.models.get();
    expect(invoke).toHaveBeenCalledWith('models:get');
    await api.models.probe({ serverId: 'local-comfy' });
    expect(invoke).toHaveBeenCalledWith('models:probe', { serverId: 'local-comfy' });
    await api.models.saveServer({ type: 'comfy', url: 'http://rack:8188' });
    expect(invoke).toHaveBeenCalledWith('models:save-server', { type: 'comfy', url: 'http://rack:8188' });
    await api.models.removeServer('server-a');
    expect(invoke).toHaveBeenCalledWith('models:remove-server', 'server-a');
    await api.models.setRoute('image', { server: 'server-a', spread: true });
    expect(invoke).toHaveBeenCalledWith('models:set-route', { use: 'image', route: { server: 'server-a', spread: true } });
    await api.models.setKey('openai', 'sk');
    expect(invoke).toHaveBeenCalledWith('models:set-key', { serverId: 'openai', key: 'sk' });
    await api.models.civitaiLookup('4201@900', 900);
    expect(invoke).toHaveBeenCalledWith('models:civitai-lookup', { ref: '4201@900', versionId: 900 });
    await api.models.download('rack', '4201@900', 900);
    expect(invoke).toHaveBeenCalledWith('models:download', { serverId: 'rack', ref: '4201@900', versionId: 900 });
    await api.models.downloads();
    expect(invoke).toHaveBeenCalledWith('models:downloads');
    await api.models.cancelDownload('d1');
    expect(invoke).toHaveBeenCalledWith('models:cancel-download', 'd1');
    await api.models.comfyAddon('rack');
    expect(invoke).toHaveBeenCalledWith('models:comfy-addon', 'rack');
  });

  it('exposes the coding helpers through the bridge', async () => {
    const [, api] = exposeInMainWorld.mock.calls[0];
    invoke.mockResolvedValue({});
    await api.coding.get();
    expect(invoke).toHaveBeenCalledWith('coding:get');
    await api.coding.set({ runner: 'local-coder-runner', workspaces: [] });
    expect(invoke).toHaveBeenCalledWith('coding:set', { runner: 'local-coder-runner', workspaces: [] });
    await api.coding.status();
    expect(invoke).toHaveBeenCalledWith('coding:status');
    await api.coding.pickGguf();
    expect(invoke).toHaveBeenCalledWith('coding:pick-gguf');
    await api.coding.pickFolder();
    expect(invoke).toHaveBeenCalledWith('coding:pick-folder');
    await api.coding.suggestChecks('aiembodied');
    expect(invoke).toHaveBeenCalledWith('coding:suggest-checks', 'aiembodied');
  });

  it('exposes the coding task and approval helpers through the bridge', async () => {
    const [, api] = exposeInMainWorld.mock.calls[0];
    invoke.mockResolvedValue({});
    await api.codingTasks.list();
    expect(invoke).toHaveBeenCalledWith('coding:tasks');
    await api.codingTasks.diff('t1');
    expect(invoke).toHaveBeenCalledWith('coding:diff', 't1');
    await api.codingTasks.start({ workspace_id: 'a', goal: 'g' });
    expect(invoke).toHaveBeenCalledWith('coding:start-task', { workspace_id: 'a', goal: 'g' });
    await api.codingTasks.answer('t1', { value: 'v' });
    expect(invoke).toHaveBeenCalledWith('coding:answer-task', 't1', { value: 'v' });
    await api.codingTasks.followUp('t1', 'more');
    expect(invoke).toHaveBeenCalledWith('coding:follow-up', 't1', 'more');
    await api.codingTasks.apply('t1');
    expect(invoke).toHaveBeenCalledWith('coding:apply-task', 't1');
    await api.approvals.list();
    expect(invoke).toHaveBeenCalledWith('approvals:list');
    await api.approvals.approve('ap1');
    expect(invoke).toHaveBeenCalledWith('approvals:approve', 'ap1');
    await api.approvals.decline('ap1');
    expect(invoke).toHaveBeenCalledWith('approvals:decline', 'ap1');
    await api.localVoice.systemStatus();
    expect(invoke).toHaveBeenCalledWith('local-voice:system-status');
    await api.conversation.announce({ note: 'n', reply: 'r' });
    expect(invoke).toHaveBeenCalledWith('conversation:announce', { note: 'n', reply: 'r' });

    const readyListener = vi.fn();
    const unsubscribeReady = api.localVoice.onSystemReady(readyListener);
    const readyCall = on.mock.calls.find(([channel]) => channel === 'local-voice:system-ready');
    const readyHandler = readyCall?.[1] as (event: unknown, info?: { urgent: boolean }) => void;
    readyHandler({}, { urgent: true });
    readyHandler({});
    expect(readyListener).toHaveBeenNthCalledWith(1, { urgent: true });
    expect(readyListener).toHaveBeenNthCalledWith(2, { urgent: false });
    unsubscribeReady();
  });

  it('exposes camera detection helpers through the bridge', async () => {
    const [, api] = exposeInMainWorld.mock.calls[0];
    const listener = vi.fn();
    const unsubscribe = api.camera?.onDetection(listener);

    const cameraCall = on.mock.calls.find(([channel]) => channel === 'camera:detection');
    expect(cameraCall).toBeDefined();
    const cameraHandler = cameraCall?.[1] as ((event: unknown, payload: unknown) => void) | undefined;
    expect(typeof cameraHandler).toBe('function');

    const payload = { cue: 'greet_face', confidence: 0.8, timestamp: 42 };
    cameraHandler?.({}, payload);
    expect(listener).toHaveBeenCalledWith(payload);

    unsubscribe?.();
    expect(removeListener).toHaveBeenCalledWith('camera:detection', cameraHandler);

    invoke.mockResolvedValueOnce(true);
    await api.camera?.emitDetection(payload);
    expect(invoke).toHaveBeenCalledWith('camera:emit-detection', payload);
  });

  it('exposes avatar model helpers through the bridge', async () => {
    const [, api] = exposeInMainWorld.mock.calls[0];

    invoke.mockResolvedValueOnce([]);
    await expect(api.avatar?.listModels()).resolves.toEqual([]);
    expect(invoke).toHaveBeenCalledWith('avatar-model:list');

    invoke.mockResolvedValueOnce({ id: 'vrm-1' });
    await expect(api.avatar?.getActiveModel()).resolves.toEqual({ id: 'vrm-1' });
    expect(invoke).toHaveBeenCalledWith('avatar-model:get-active');

    invoke.mockResolvedValueOnce({ id: 'vrm-2' });
    await expect(api.avatar?.setActiveModel('vrm-2')).resolves.toEqual({ id: 'vrm-2' });
    expect(invoke).toHaveBeenCalledWith('avatar-model:set-active', 'vrm-2');

    invoke.mockResolvedValueOnce({ model: { id: 'vrm-3' } });
    await expect(api.avatar?.uploadModel({ fileName: 'model.vrm', data: 'AAAA' })).resolves.toEqual({
      model: { id: 'vrm-3' },
    });
    expect(invoke).toHaveBeenCalledWith('avatar-model:upload', { fileName: 'model.vrm', data: 'AAAA' });

    invoke.mockResolvedValueOnce(true);
    await api.avatar?.deleteModel('vrm-3');
    expect(invoke).toHaveBeenCalledWith('avatar-model:delete', 'vrm-3');

    const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
    invoke.mockResolvedValueOnce(buffer);
    const cloned = await api.avatar?.loadModelBinary('vrm-4');
    expect(cloned).toBeInstanceOf(ArrayBuffer);
    expect(cloned).not.toBe(buffer);
    expect(new Uint8Array(cloned as ArrayBuffer)).toEqual(new Uint8Array(buffer));
    expect(invoke).toHaveBeenCalledWith('avatar-model:load', 'vrm-4');

    invoke.mockResolvedValueOnce(true);
    await api.avatar?.triggerBehaviorCue('greet_face');
    expect(invoke).toHaveBeenCalledWith('avatar:trigger-behavior', 'greet_face');

    invoke.mockResolvedValueOnce({ jobId: 'job-1' });
    await expect(api.avatar?.generateAvatar({ prompt: 'A friendly assistant' })).resolves.toEqual({
      jobId: 'job-1',
    });
    expect(invoke).toHaveBeenCalledWith('avatar:generation-start', { prompt: 'A friendly assistant' });
    invoke.mockResolvedValueOnce({ models: [], selectedModelId: null });
    await expect(api.avatar?.listAvatarImageModels()).resolves.toEqual({ models: [], selectedModelId: null });
    expect(invoke).toHaveBeenCalledWith('avatar:image-models');
    invoke.mockResolvedValueOnce(undefined);
    await api.avatar?.setAvatarImageModel('checkpoints:variant.safetensors');
    expect(invoke).toHaveBeenCalledWith('avatar:image-model-select', 'checkpoints:variant.safetensors');

    invoke.mockResolvedValueOnce({ jobId: 'job-1', status: 'queued' });
    await expect(api.avatar?.getAvatarGenerationStatus('job-1')).resolves.toEqual({ jobId: 'job-1', status: 'queued' });
    expect(invoke).toHaveBeenCalledWith('avatar:generation-status', 'job-1');
    invoke.mockResolvedValueOnce(undefined);
    await api.avatar?.confirmAvatarConcept('job-1');
    expect(invoke).toHaveBeenCalledWith('avatar:generation-confirm-concept', 'job-1');
    await api.avatar?.confirmAvatarConcept('job-1', { acceptWarnings: true });
    expect(invoke).toHaveBeenCalledWith('avatar:generation-confirm-concept', 'job-1', { acceptWarnings: true });

    invoke.mockResolvedValueOnce(new Uint8Array([1, 2, 3]));
    const preview = await api.avatar?.loadGeneratedAvatarPreview('job-1');
    expect(new Uint8Array(preview as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
    expect(invoke).toHaveBeenCalledWith('avatar:generation-preview', 'job-1');

    invoke.mockResolvedValueOnce({ vrmId: 'vrm-99' });
    await expect(api.avatar?.acceptGeneratedAvatar('job-1')).resolves.toEqual({ vrmId: 'vrm-99' });
    expect(invoke).toHaveBeenCalledWith('avatar:generation-accept', 'job-1');

    invoke.mockResolvedValueOnce(true);
    await api.avatar?.rejectGeneratedAvatar('job-1');
    expect(invoke).toHaveBeenCalledWith('avatar:generation-reject', 'job-1');

    invoke.mockResolvedValueOnce([]);
    await expect(api.avatar?.listAvatarGenerationJobs()).resolves.toEqual([]);
    expect(invoke).toHaveBeenCalledWith('avatar:generation-list');
    invoke.mockResolvedValueOnce(undefined);
    await api.avatar?.cancelAvatarGeneration('job-1');
    expect(invoke).toHaveBeenCalledWith('avatar:generation-cancel', 'job-1');
    const selection = { geometry: [], rig: [], selectedGeometryId: null, selectedRigId: null };
    invoke.mockResolvedValueOnce(selection);
    await expect(api.avatar?.listAvatarCharacterModels()).resolves.toEqual(selection);
    expect(invoke).toHaveBeenCalledWith('avatar:character-models');
    invoke.mockResolvedValueOnce(undefined);
    await api.avatar?.setAvatarCharacterModel('geometry', 'trellis_2_bf16.safetensors');
    expect(invoke).toHaveBeenCalledWith('avatar:character-model-select', 'geometry', 'trellis_2_bf16.safetensors');
  });

  it('exposes avatar animation helpers through the bridge', async () => {
    const [, api] = exposeInMainWorld.mock.calls[0];

    invoke.mockResolvedValueOnce([]);
    await expect(api.avatar?.listAnimations()).resolves.toEqual([]);
    expect(invoke).toHaveBeenCalledWith('avatar-animation:list');

    invoke.mockResolvedValueOnce({ animation: { id: 'vrma-1' } });
    await expect(api.avatar?.uploadAnimation({ fileName: 'idle.vrma', data: 'AAAA' })).resolves.toEqual({
      animation: { id: 'vrma-1' },
    });
    expect(invoke).toHaveBeenCalledWith('avatar-animation:upload', { fileName: 'idle.vrma', data: 'AAAA' });

    invoke.mockResolvedValueOnce({ animation: { id: 'vrma-2' } });
    await expect(api.avatar?.generateAnimation({ prompt: 'Wave hello' })).resolves.toEqual({ animation: { id: 'vrma-2' } });
    expect(invoke).toHaveBeenCalledWith('avatar-animation:generate', { prompt: 'Wave hello' });

    invoke.mockResolvedValueOnce(true);
    await api.avatar?.deleteAnimation('vrma-2');
    expect(invoke).toHaveBeenCalledWith('avatar-animation:delete', 'vrma-2');

    const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
    invoke.mockResolvedValueOnce(buffer);
    const cloned = await api.avatar?.loadAnimationBinary('vrma-3');
    expect(cloned).toBeInstanceOf(ArrayBuffer);
    expect(cloned).not.toBe(buffer);
    expect(new Uint8Array(cloned as ArrayBuffer)).toEqual(new Uint8Array(buffer));
    expect(invoke).toHaveBeenCalledWith('avatar-animation:load', 'vrma-3');
  });
});


it('exposes only named background operations through the preload bridge', async () => {
  vi.resetModules();
  await import('../src/preload.js');
  const api = exposeInMainWorld.mock.calls.at(-1)![1];
  await api.backgrounds.list();
  expect(invoke).toHaveBeenCalledWith('background:list');
  await api.backgrounds.getActive();
  expect(invoke).toHaveBeenCalledWith('background:get-active');
  await api.backgrounds.setActive('builtin:beach');
  expect(invoke).toHaveBeenCalledWith('background:set-active', 'builtin:beach');
  await api.backgrounds.setActive(null);
  expect(invoke).toHaveBeenCalledWith('background:set-active', null);
  await api.backgrounds.load('builtin:city');
  expect(invoke).toHaveBeenCalledWith('background:load', 'builtin:city');
  await api.backgrounds.generate('A forest clearing');
  expect(invoke).toHaveBeenCalledWith('background:generate', 'A forest clearing');
  await api.backgrounds.delete('generated-id');
  expect(invoke).toHaveBeenCalledWith('background:delete', 'generated-id');
  await api.backgrounds.listRooms();
  expect(invoke).toHaveBeenCalledWith('background:list-rooms');
  await api.backgrounds.loadRoom('room:builtin:reading-room');
  expect(invoke).toHaveBeenCalledWith('background:load-room', 'room:builtin:reading-room');
  await api.backgrounds.generateRoom('a cosy study');
  expect(invoke).toHaveBeenCalledWith('rooms:generate', 'a cosy study');
  await api.backgrounds.cancelRoomGeneration();
  expect(invoke).toHaveBeenCalledWith('rooms:cancel-generate');
  await api.backgrounds.deleteRoom('room:abc');
  expect(invoke).toHaveBeenCalledWith('rooms:delete', 'room:abc');
  await api.backgrounds.getIdleSettings();
  expect(invoke).toHaveBeenCalledWith('rooms:idle-settings:get');
  await api.backgrounds.setIdleSettings({ enabled: false, restlessness: 'calm', onTalk: 'turn' });
  expect(invoke).toHaveBeenCalledWith('rooms:idle-settings:set', { enabled: false, restlessness: 'calm', onTalk: 'turn' });
  await api.backgrounds.pickIdle({ system: 's', user: 'u' });
  expect(invoke).toHaveBeenCalledWith('rooms:idle-pick', { system: 's', user: 'u' });
  await api.backgrounds.getObjectSettings();
  expect(invoke).toHaveBeenCalledWith('rooms:object-settings:get');
  await api.backgrounds.setObjectSettings({ maxPerRoom: 2 });
  expect(invoke).toHaveBeenCalledWith('rooms:object-settings:set', { maxPerRoom: 2 });
  await api.backgrounds.listGeneratedObjects();
  expect(invoke).toHaveBeenCalledWith('rooms:generated:list');
  await api.backgrounds.deleteGeneratedObject('chair-3fa91c2e');
  expect(invoke).toHaveBeenCalledWith('rooms:generated:delete', 'chair-3fa91c2e');
  await api.backgrounds.getMakingRoom();
  expect(invoke).toHaveBeenCalledWith('rooms:making');
  const heard: string[] = [];
  const stop = api.backgrounds.onRoomUpdated((roomId: string) => heard.push(roomId));
  const [channel, handler] = on.mock.calls.at(-1)!;
  expect(channel).toBe('rooms:updated');
  (handler as (event: unknown, roomId: string) => void)({}, 'room:abc');
  expect(heard).toEqual(['room:abc']);
  stop();
  expect(removeListener).toHaveBeenCalledWith('rooms:updated', handler);
});

it('exposes the per-character idle habits through the avatar bridge', async () => {
  vi.resetModules();
  await import('../src/preload.js');
  const api = exposeInMainWorld.mock.calls.at(-1)![1];
  await api.avatar.getIdleHabits();
  expect(invoke).toHaveBeenCalledWith('avatar:idle-habits:get');
  await api.avatar.setIdleHabits('sits by the window');
  expect(invoke).toHaveBeenCalledWith('avatar:idle-habits:set', 'sits by the window');
});

it('exposes app.quit through the bridge', async () => {
  vi.resetModules();
  await import('../src/preload.js');
  const api = exposeInMainWorld.mock.calls.at(-1)![1];
  invoke.mockResolvedValueOnce(undefined);
  await api.app?.quit();
  expect(invoke).toHaveBeenCalledWith('app:quit');
});
