import { EventEmitter } from 'node:events';
import type { IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const dotenvConfigMock = vi.fn();

vi.mock('dotenv', () => ({
  default: { config: dotenvConfigMock },
}));

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const initializeLoggerMock = vi.fn(() => ({ logger: mockLogger }));
vi.mock('../src/logging/logger.js', () => ({ initializeLogger: initializeLoggerMock }));

const diagnosticsTrackWindowMock = vi.fn();
const diagnosticsDisposeMock = vi.fn();
const createAppDiagnosticsMock = vi.fn(() => ({
  trackWindow: diagnosticsTrackWindowMock,
  dispose: diagnosticsDisposeMock,
}));

vi.mock('../src/logging/app-diagnostics.js', () => ({
  createAppDiagnostics: createAppDiagnosticsMock,
}));

const loadMock = vi.fn();
const getConfigMock = vi.fn();
const getRendererConfigMock = vi.fn();
const getSecretMock = vi.fn();
const setSecretMock = vi.fn();
const testSecretMock = vi.fn();
const setAudioDevicePreferencesMock = vi.fn();
const loadPreferencesMock = vi.fn();
const savePreferencesMock = vi.fn();

const ConfigManagerMock = vi.fn(() => ({
  load: loadMock,
  getConfig: getConfigMock,
  getRendererConfig: getRendererConfigMock,
  getSecret: getSecretMock,
  setSecret: setSecretMock,
  testSecret: testSecretMock,
  setAudioDevicePreferences: setAudioDevicePreferencesMock,
}));

class ConfigValidationErrorMock extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

vi.mock('../src/config/config-manager.js', () => ({
  ConfigManager: ConfigManagerMock,
  ConfigValidationError: ConfigValidationErrorMock,
}));

vi.mock('../src/config/keytar-secret-store.js', () => ({
  KeytarSecretStore: vi.fn(),
}));

vi.mock('../src/config/secret-store.js', () => ({
  InMemorySecretStore: vi.fn(),
}));

const FilePreferencesStoreMock = vi.fn(() => ({
  load: loadPreferencesMock,
  save: savePreferencesMock,
}));

vi.mock('../src/config/preferences-store.js', () => ({
  FilePreferencesStore: FilePreferencesStoreMock,
}));

const createSessionMock = vi.fn();
const appendMessageMock = vi.fn();
const listSessionsMock = vi.fn();
const listMessagesMock = vi.fn();
const getSessionWithMessagesMock = vi.fn();
const deleteSessionMock = vi.fn();
const deleteMessagesMock = vi.fn();
const setValueMock = vi.fn();
const getValueMock = vi.fn();
const deleteValueMock = vi.fn();
const exportDataMock = vi.fn();
const importDataMock = vi.fn();
const memoryStoreDisposeMock = vi.fn();

const MemoryStoreMock = vi.fn(() => ({
  createSession: createSessionMock,
  appendMessage: appendMessageMock,
  listSessions: listSessionsMock,
  listMessages: listMessagesMock,
  getSessionWithMessages: getSessionWithMessagesMock,
  deleteSession: deleteSessionMock,
  deleteMessages: deleteMessagesMock,
  setValue: setValueMock,
  getValue: getValueMock,
  deleteValue: deleteValueMock,
  exportData: exportDataMock,
  importData: importDataMock,
  dispose: memoryStoreDisposeMock,
}));

vi.mock('../src/memory/index.js', () => ({
  MemoryStore: MemoryStoreMock,
}));

class AvatarFaceServiceDouble {
  listFaces = vi.fn().mockResolvedValue([]);
  getActiveFace = vi.fn().mockResolvedValue(null);
  setActiveFace = vi.fn().mockResolvedValue(null);
  uploadFace = vi.fn().mockResolvedValue({ faceId: 'face-123' });
  deleteFace = vi.fn().mockResolvedValue(undefined);
  constructor(public readonly options: unknown) {}
}

const avatarFaceServiceInstances: AvatarFaceServiceDouble[] = [];
const createAvatarFaceServiceInstance = (options: unknown) => {
  const instance = new AvatarFaceServiceDouble(options);
  avatarFaceServiceInstances.push(instance);
  return instance;
};
const AvatarFaceServiceMock = vi.fn(createAvatarFaceServiceInstance);

vi.mock('../src/avatar/avatar-face-service.js', () => ({
  AvatarFaceService: AvatarFaceServiceMock,
}));

const resolvePreloadScriptPathMock = vi.fn();
const resolveRendererEntryPointMock = vi.fn();

class RuntimeResourceNotFoundErrorDouble extends Error {
  constructor(message: string, public readonly attempted: string[]) {
    super(message);
    this.name = 'RuntimeResourceNotFoundError';
  }
}

vi.mock('../src/runtime-paths.js', () => ({
  resolvePreloadScriptPath: resolvePreloadScriptPathMock,
  resolveRendererEntryPoint: resolveRendererEntryPointMock,
  RuntimeResourceNotFoundError: RuntimeResourceNotFoundErrorDouble,
}));

class WakeWordServiceDouble extends EventEmitter {
  start = vi.fn();
  dispose = vi.fn().mockResolvedValue(undefined);
  constructor(public readonly options: unknown) {
    super();
  }
}

const wakeWordServiceInstances: WakeWordServiceDouble[] = [];
const createWakeWordServiceInstance = (options: unknown) => {
  const instance = new WakeWordServiceDouble(options);
  wakeWordServiceInstances.push(instance);
  return instance;
};
const WakeWordServiceMock = vi.fn(createWakeWordServiceInstance);

vi.mock('../src/wake-word/wake-word-service.js', () => ({
  WakeWordService: WakeWordServiceMock,
}));

class CrashGuardDouble {
  watch = vi.fn();
  notifyAppQuitting = vi.fn();
  constructor(public readonly options: unknown) {}
}

const crashGuardInstances: CrashGuardDouble[] = [];
const createCrashGuardInstance = (options: unknown) => {
  const instance = new CrashGuardDouble(options);
  crashGuardInstances.push(instance);
  return instance;
};
const CrashGuardMock = vi.fn(createCrashGuardInstance);

vi.mock('../src/crash-guard.js', () => ({
  CrashGuard: CrashGuardMock,
}));

interface MockBrowserWindow extends EventEmitter {
  loadFile: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  isMinimized: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  webContents: EventEmitter & { send: ReturnType<typeof vi.fn> };
}

const createdWindows: MockBrowserWindow[] = [];
let getAllWindowsResult: MockBrowserWindow[] = createdWindows;

const BrowserWindowMock = vi.fn(() => {
  const windowEmitter = new EventEmitter() as MockBrowserWindow;
  const webContents = new EventEmitter() as MockBrowserWindow['webContents'];
  webContents.send = vi.fn();
  windowEmitter.webContents = webContents;
  windowEmitter.loadFile = vi.fn(() => Promise.resolve());
  windowEmitter.isDestroyed = vi.fn(() => false);
  windowEmitter.isMinimized = vi.fn(() => false);
  windowEmitter.restore = vi.fn();
  windowEmitter.focus = vi.fn();
  windowEmitter.destroy = vi.fn();
  createdWindows.push(windowEmitter);
  return windowEmitter;
});

BrowserWindowMock.getAllWindows = vi.fn(() => getAllWindowsResult);

const dialogMock = { showErrorBox: vi.fn() };
const ipcMainMock = {
  handle: vi.fn(),
};

const appEmitter = Object.assign(new EventEmitter(), {
  whenReady: vi.fn<[], Promise<void>>(),
  requestSingleInstanceLock: vi.fn(() => true),
  quit: vi.fn(),
  getPath: vi.fn(() => '/tmp/aiembodied-test'),
  isPackaged: false,
});

const trayDestroyMock = vi.fn();
const TrayMock = vi.fn(() => ({ destroy: trayDestroyMock }));

const nativeImageMock = {
  createFromDataURL: vi.fn(() => ({ isEmpty: () => false })),
  createEmpty: vi.fn(() => ({ isEmpty: () => true })),
};

const menuBuildFromTemplateMock = vi.fn(() => ({}));

vi.mock('electron', () => ({
  app: appEmitter,
  BrowserWindow: BrowserWindowMock,
  dialog: dialogMock,
  ipcMain: ipcMainMock,
  Tray: TrayMock,
  Menu: { buildFromTemplate: menuBuildFromTemplateMock },
  nativeImage: nativeImageMock,
}));

const autoLaunchSyncMock = vi.fn<[], Promise<boolean>>();
const autoLaunchIsEnabledMock = vi.fn<[], Promise<boolean>>();

const AutoLaunchManagerMock = vi.fn(() => ({
  sync: autoLaunchSyncMock,
  isEnabled: autoLaunchIsEnabledMock,
}));

const createDevTrayDestroyMock = vi.fn();
const createDevTrayMock = vi.fn(() =>
  Promise.resolve({ destroy: createDevTrayDestroyMock } as unknown as ReturnType<typeof TrayMock>),
);

vi.mock('../src/lifecycle/auto-launch.js', () => ({
  AutoLaunchManager: AutoLaunchManagerMock,
}));

vi.mock('../src/lifecycle/dev-tray.js', () => ({
  createDevTray: createDevTrayMock,
}));

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

async function waitForExpect(assertion: () => void, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  throw lastError ?? new Error('waitForExpect timed out');
}

describe('main process bootstrap', () => {
  let whenReadyDeferred: Deferred<void>;

  beforeEach(() => {
    vi.resetModules();
    process.env.NODE_ENV = 'test';

    dotenvConfigMock.mockClear();
    initializeLoggerMock.mockClear();
    createAppDiagnosticsMock.mockClear();
    diagnosticsTrackWindowMock.mockReset();
    diagnosticsDisposeMock.mockReset();
    createAppDiagnosticsMock.mockImplementation(() => ({
      trackWindow: diagnosticsTrackWindowMock,
      dispose: diagnosticsDisposeMock,
    }));

    loadMock.mockReset();
    getConfigMock.mockReset();
    getRendererConfigMock.mockReset();
    getSecretMock.mockReset();
    setSecretMock.mockReset();
    testSecretMock.mockReset();
    setAudioDevicePreferencesMock.mockReset();
    loadPreferencesMock.mockReset();
    savePreferencesMock.mockReset();
    FilePreferencesStoreMock.mockReset();
    ConfigManagerMock.mockClear();

    WakeWordServiceMock.mockReset();
    WakeWordServiceMock.mockImplementation(createWakeWordServiceInstance);
    wakeWordServiceInstances.length = 0;

    AvatarFaceServiceMock.mockReset();
    AvatarFaceServiceMock.mockImplementation(createAvatarFaceServiceInstance);
    avatarFaceServiceInstances.length = 0;

    CrashGuardMock.mockReset();
    CrashGuardMock.mockImplementation(createCrashGuardInstance);
    crashGuardInstances.length = 0;

    resolvePreloadScriptPathMock.mockReset();
    resolveRendererEntryPointMock.mockReset();
    resolvePreloadScriptPathMock.mockReturnValue({
      path: '/tmp/aiembodied-test/preload.js',
      attempted: ['/tmp/aiembodied-test/preload.js'],
      usedIndex: 0,
    });
    resolveRendererEntryPointMock.mockReturnValue({
      path: '/tmp/aiembodied-test/renderer/index.html',
      attempted: ['/tmp/aiembodied-test/renderer/index.html'],
      usedIndex: 0,
    });

    createdWindows.length = 0;
    getAllWindowsResult = createdWindows;
    BrowserWindowMock.mockClear();
    (BrowserWindowMock.getAllWindows as ReturnType<typeof vi.fn>).mockClear();

    dialogMock.showErrorBox.mockReset();
    ipcMainMock.handle.mockReset();

    appEmitter.removeAllListeners();
    appEmitter.whenReady.mockReset();
    appEmitter.requestSingleInstanceLock.mockReset();
    appEmitter.quit.mockReset();
    appEmitter.getPath.mockReset();
    appEmitter.getPath.mockImplementation((name: string) =>
      name === 'exe' ? '/tmp/aiembodied-test/app.exe' : '/tmp/aiembodied-test',
    );
    appEmitter.isPackaged = false;

    whenReadyDeferred = createDeferred<void>();
    appEmitter.whenReady.mockImplementation(() => whenReadyDeferred.promise);
    appEmitter.requestSingleInstanceLock.mockReturnValue(true);

    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
    mockLogger.debug.mockReset();

    MemoryStoreMock.mockClear();
    createSessionMock.mockReset();
    appendMessageMock.mockReset();
    listSessionsMock.mockReset();
    listMessagesMock.mockReset();
    getSessionWithMessagesMock.mockReset();
    deleteSessionMock.mockReset();
    deleteMessagesMock.mockReset();
    setValueMock.mockReset();
    getValueMock.mockReset();
    deleteValueMock.mockReset();
    exportDataMock.mockReset();
    importDataMock.mockReset();
    memoryStoreDisposeMock.mockReset();
    listSessionsMock.mockReturnValue([]);
    listMessagesMock.mockReturnValue([]);
    getSessionWithMessagesMock.mockReturnValue(null);
    getValueMock.mockReturnValue(null);

    AutoLaunchManagerMock.mockClear();
    autoLaunchSyncMock.mockReset();
    autoLaunchIsEnabledMock.mockReset();
    autoLaunchSyncMock.mockResolvedValue(false);
    autoLaunchIsEnabledMock.mockResolvedValue(false);

    createDevTrayMock.mockClear();
    createDevTrayDestroyMock.mockReset();
    createDevTrayMock.mockImplementation(() =>
      Promise.resolve({ destroy: createDevTrayDestroyMock } as unknown as ReturnType<typeof TrayMock>),
    );

    TrayMock.mockClear();
    trayDestroyMock.mockReset();
    nativeImageMock.createFromDataURL.mockClear();
    nativeImageMock.createEmpty.mockClear();
    menuBuildFromTemplateMock.mockClear();
  });

  it('quits when another instance already holds the lock', async () => {
    appEmitter.requestSingleInstanceLock.mockReturnValue(false);

    const config = {
      realtimeApiKey: 'rt-key',
      featureFlags: {},
      wakeWord: {
        accessKey: 'access',
        keywordPath: 'keyword.ppn',
        keywordLabel: 'Porcupine',
        sensitivity: 0.6,
        minConfidence: 0.4,
        cooldownMs: 750,
      },
      metrics: {
        enabled: false,
        host: '127.0.0.1',
        port: 9477,
        path: '/metrics',
      },
    } as const;

    loadMock.mockResolvedValue(config);
    getConfigMock.mockReturnValue(config);

    await import('../src/main.js');

    expect(appEmitter.requestSingleInstanceLock).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Another instance of aiembodied is already running. Quitting.',
    );
    expect(appEmitter.quit).toHaveBeenCalledTimes(1);

    whenReadyDeferred.resolve();
    await whenReadyDeferred.promise;
    await flushPromises();
  });

  it('initializes wake word service, ipc handlers, and window lifecycle on ready', async () => {
    const baseConfig = {
      realtimeApiKey: 'rt-key',
      audioInputDeviceId: undefined,
      audioOutputDeviceId: undefined,
      featureFlags: {},
      wakeWord: {
        accessKey: 'access',
        keywordPath: 'keyword.ppn',
        keywordLabel: 'Porcupine',
        sensitivity: 0.5,
        minConfidence: 0.6,
        cooldownMs: 900,
        deviceIndex: 1,
        modelPath: '/path/to/model',
      },
      metrics: {
        enabled: false,
        host: '127.0.0.1',
        port: 9477,
        path: '/metrics',
      },
    } as const;

    let currentConfig = { ...baseConfig };

    loadMock.mockResolvedValue(baseConfig);
    getConfigMock.mockImplementation(() => currentConfig);
    getRendererConfigMock.mockReturnValue({ hasRealtimeApiKey: true });
    setAudioDevicePreferencesMock.mockImplementation(async () => ({ hasRealtimeApiKey: true }));
    setSecretMock.mockImplementation(async (_key: string, value: string) => {
      currentConfig = { ...currentConfig, realtimeApiKey: value };
      return { hasRealtimeApiKey: true };
    });
    testSecretMock.mockResolvedValue({ ok: true });

    const serviceReady = createDeferred<void>();
    WakeWordServiceMock.mockImplementation((options: unknown) => {
      const instance = createWakeWordServiceInstance(options);
      serviceReady.resolve();
      return instance;
    });

    await import('../src/main.js');

    expect(dotenvConfigMock).toHaveBeenCalledTimes(1);
    const envConfigCall = dotenvConfigMock.mock.calls[0]?.[0];
    expect(typeof envConfigCall?.path).toBe('string');
    const normalizedEnvPath = (envConfigCall?.path as string).replace(/\\/g, '/');
    expect(/^(?:\/[\s\S]*|[A-Za-z]:\/)/.test(normalizedEnvPath)).toBe(true);
    expect(normalizedEnvPath).toMatch(/\/\.env$/);

    whenReadyDeferred.resolve();
    await whenReadyDeferred.promise;
    await flushPromises();
    await serviceReady.promise;

    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(AutoLaunchManagerMock).toHaveBeenCalledWith({
      logger: mockLogger,
      appName: 'AI Embodied Assistant',
      appPath: '/tmp/aiembodied-test/app.exe',
    });
    expect(autoLaunchSyncMock).toHaveBeenCalledWith(false);
    expect(createDevTrayMock).toHaveBeenCalledTimes(1);
    expect(WakeWordServiceMock).toHaveBeenCalledTimes(1);
    expect(WakeWordServiceMock.mock.calls[0][0]).toMatchObject({
      logger: mockLogger,
      cooldownMs: baseConfig.wakeWord.cooldownMs,
      minConfidence: baseConfig.wakeWord.minConfidence,
    });

    const wakeWordService = wakeWordServiceInstances[0];
    expect(wakeWordService.start).toHaveBeenCalledWith({
      accessKey: baseConfig.wakeWord.accessKey,
      keywordPath: baseConfig.wakeWord.keywordPath,
      keywordLabel: baseConfig.wakeWord.keywordLabel,
      sensitivity: baseConfig.wakeWord.sensitivity,
      modelPath: baseConfig.wakeWord.modelPath,
      deviceIndex: baseConfig.wakeWord.deviceIndex,
    });

    expect(BrowserWindowMock).toHaveBeenCalledTimes(1);
    expect(BrowserWindowMock.mock.calls[0]?.[0]).toMatchObject({
      webPreferences: expect.objectContaining({
        preload: '/tmp/aiembodied-test/preload.js',
      }),
    });
    const mainWindow = createdWindows[0];
    expect(diagnosticsTrackWindowMock).toHaveBeenCalledWith(mainWindow);
    expect(mainWindow.loadFile).toHaveBeenCalledWith('/tmp/aiembodied-test/renderer/index.html');

    expect(crashGuardInstances).toHaveLength(1);
    expect(crashGuardInstances[0].watch).toHaveBeenCalledWith(mainWindow);

    expect(ipcMainMock.handle).toHaveBeenCalledTimes(13);
    const handleEntries = new Map(ipcMainMock.handle.mock.calls.map(([channel, handler]) => [channel, handler]));

    expect(mockLogger.info).toHaveBeenCalledWith('Avatar face service initialized.', {
      reason: 'startup',
    });

    const expectedConfigChannels = [
      'config:get',
      'config:get-secret',
      'config:set-secret',
      'config:test-secret',
      'config:set-audio-devices',
    ];
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Initializing configuration bridge IPC handlers.',
      expect.objectContaining({ channels: expectedConfigChannels }),
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Configuration bridge IPC handlers registered.',
      expect.objectContaining({ channels: expectedConfigChannels }),
    );

    const configHandler = handleEntries.get('config:get');
    expect(typeof configHandler).toBe('function');
    await expect(configHandler?.({} as unknown as IpcMainInvokeEvent)).resolves.toEqual({
      hasRealtimeApiKey: true,
    });

    const secretHandler = handleEntries.get('config:get-secret');
    expect(typeof secretHandler).toBe('function');
    getSecretMock.mockResolvedValueOnce('secret');
    await expect(secretHandler?.({}, 'realtimeApiKey')).resolves.toBe('secret');
    expect(getSecretMock).toHaveBeenCalledWith('realtimeApiKey');

    const setSecretHandler = handleEntries.get('config:set-secret');
    expect(typeof setSecretHandler).toBe('function');
    await expect(setSecretHandler?.({}, { key: 'realtimeApiKey', value: 'next-key' })).resolves.toEqual({
      hasRealtimeApiKey: true,
    });
    expect(setSecretMock).toHaveBeenCalledWith('realtimeApiKey', 'next-key');

    expect(mockLogger.info).toHaveBeenCalledWith('Avatar face service initialized.', {
      reason: 'secret-update',
    });

    expect(avatarFaceServiceInstances).toHaveLength(2);

    const avatarServiceOptionsList = avatarFaceServiceInstances.map(
      (instance) => instance.options as Record<string, unknown>,
    );

    for (const options of avatarServiceOptionsList) {
      expect(options).toMatchObject({
        client: expect.objectContaining({
          responses: expect.objectContaining({
            create: expect.any(Function),
          }),
        }),
        logger: mockLogger,
      });

      expect(options).not.toHaveProperty('apiKey');
      expect(options).not.toHaveProperty('endpoint');
      expect(options).not.toHaveProperty('fetch');
    }

    const testSecretHandler = handleEntries.get('config:test-secret');
    expect(typeof testSecretHandler).toBe('function');
    await expect(testSecretHandler?.({}, 'wakeWordAccessKey')).resolves.toEqual({ ok: true });
    expect(testSecretMock).toHaveBeenCalledWith('wakeWordAccessKey');

    const deviceHandler = handleEntries.get('config:set-audio-devices');
    expect(typeof deviceHandler).toBe('function');
    await deviceHandler?.({}, { audioInputDeviceId: 'mic', audioOutputDeviceId: 'spk' });
    expect(setAudioDevicePreferencesMock).toHaveBeenCalledWith({
      audioInputDeviceId: 'mic',
      audioOutputDeviceId: 'spk',
    });

    expect(typeof handleEntries.get('conversation:get-history')).toBe('function');
    expect(typeof handleEntries.get('conversation:append-message')).toBe('function');
    const metricsHandler = handleEntries.get('metrics:observe-latency');
    expect(typeof metricsHandler).toBe('function');
    const metricsResult = metricsHandler?.({}, { metric: 'wake_to_capture_ms', valueMs: 100 });
    expect(metricsResult).toBe(false);

    const avatarService = avatarFaceServiceInstances[avatarFaceServiceInstances.length - 1];
    expect(avatarService).toBeDefined();

    const listFacesHandler = handleEntries.get('avatar:list-faces');
    expect(typeof listFacesHandler).toBe('function');
    await expect(listFacesHandler?.({})).resolves.toEqual([]);
    expect(avatarService?.listFaces).toHaveBeenCalledTimes(1);

    const getActiveHandler = handleEntries.get('avatar:get-active-face');
    expect(typeof getActiveHandler).toBe('function');
    await expect(getActiveHandler?.({})).resolves.toBeNull();
    expect(avatarService?.getActiveFace).toHaveBeenCalledTimes(1);

    const setActiveHandler = handleEntries.get('avatar:set-active-face');
    expect(typeof setActiveHandler).toBe('function');
    await expect(setActiveHandler?.({}, 'face-1')).resolves.toBeNull();
    expect(avatarService?.setActiveFace).toHaveBeenCalledWith('face-1');

    const generateHandler = handleEntries.get('avatar:generate-face');
    expect(typeof generateHandler).toBe('function');
    await expect(generateHandler?.({}, { name: 'Friendly', imageDataUrl: 'data:' })).resolves.toEqual({ generationId: 'gen-1', candidates: expect.any(Array) });
    expect(avatarService?.generateFace).toHaveBeenCalledWith({ name: 'Friendly', imageDataUrl: 'data:' });

    const deleteHandler = handleEntries.get('avatar:delete-face');
    expect(typeof deleteHandler).toBe('function');
    await expect(deleteHandler?.({}, 'face-1')).resolves.toBe(true);
    expect(avatarService?.deleteFace).toHaveBeenCalledWith('face-1');

    const wakePayload = { keywordLabel: 'Porcupine', confidence: 0.92, timestamp: Date.now() };
    wakeWordService.emit('wake', wakePayload);
    const createdSessionId = createSessionMock.mock.calls[0]?.[0]?.id;
    expect(createdSessionId).toBeDefined();
    expect(setValueMock).toHaveBeenCalledWith('conversation:currentSessionId', createdSessionId);
    expect(setValueMock).toHaveBeenCalledWith('conversation:lastSessionId', createdSessionId);
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      'conversation:session-started',
      expect.objectContaining({ id: createdSessionId }),
    );
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      'wake-word:event',
      expect.objectContaining({
        keywordLabel: wakePayload.keywordLabel,
        confidence: wakePayload.confidence,
        sessionId: createdSessionId,
      }),
    );

    const wakeError = new Error('worker failed');
    wakeWordService.emit('error', wakeError);
    expect(mockLogger.error).toHaveBeenCalledWith('Wake word service error', {
      message: wakeError.message,
      stack: wakeError.stack,
    });

    wakeWordService.emit('ready', { keywordLabel: 'Porcupine', frameLength: 512, sampleRate: 16000 });
    expect(mockLogger.info).toHaveBeenCalledWith('Wake word service ready', {
      keywordLabel: 'Porcupine',
      frameLength: 512,
      sampleRate: 16000,
    });

    mainWindow.emit('ready-to-show');
    expect(mockLogger.info).toHaveBeenCalledWith('Main window ready to show.');

    mainWindow.emit('closed');
    expect(createdWindows[0].isDestroyed()).toBe(false);

    appEmitter.emit('second-instance');
    expect(mockLogger.warn).toHaveBeenLastCalledWith(
      'Main window missing on second-instance event. Relaunching.',
    );
    expect(BrowserWindowMock).toHaveBeenCalledTimes(2);

    const replacementWindow = createdWindows[1];
    expect(diagnosticsTrackWindowMock).toHaveBeenCalledWith(replacementWindow);
    replacementWindow.isDestroyed.mockReturnValue(false);
    replacementWindow.isMinimized.mockReturnValue(true);
    appEmitter.emit('second-instance');
    expect(replacementWindow.restore).toHaveBeenCalledTimes(1);
    expect(replacementWindow.focus).toHaveBeenCalledTimes(1);

    replacementWindow.isMinimized.mockReturnValue(false);
    appEmitter.emit('second-instance');
    expect(replacementWindow.restore).toHaveBeenCalledTimes(1);
    expect(replacementWindow.focus).toHaveBeenCalledTimes(2);

    getAllWindowsResult = [];
    appEmitter.emit('activate');
    expect(BrowserWindowMock).toHaveBeenCalledTimes(3);

    const activationWindow = createdWindows[2];
    expect(diagnosticsTrackWindowMock).toHaveBeenCalledWith(activationWindow);

    appEmitter.emit('before-quit');
    expect(crashGuardInstances[0].notifyAppQuitting).toHaveBeenCalledTimes(1);
    expect(diagnosticsDisposeMock).toHaveBeenCalledTimes(1);
    expect(wakeWordService.dispose).toHaveBeenCalledTimes(1);
    await expect(wakeWordService.dispose.mock.results[0].value).resolves.toBeUndefined();
    expect(memoryStoreDisposeMock).toHaveBeenCalledTimes(1);
    expect(createDevTrayDestroyMock).toHaveBeenCalledTimes(1);

    appEmitter.emit('window-all-closed');
    expect(appEmitter.quit).toHaveBeenCalledTimes(1);
  });

  it('initializes the avatar face service when the realtime key is added after startup', async () => {
    const baseConfig = {
      realtimeApiKey: '',
      audioInputDeviceId: undefined,
      audioOutputDeviceId: undefined,
      featureFlags: {},
      wakeWord: {
        accessKey: 'access',
        keywordPath: 'keyword.ppn',
        keywordLabel: 'Porcupine',
        sensitivity: 0.5,
        minConfidence: 0.6,
        cooldownMs: 900,
        deviceIndex: 1,
        modelPath: '/path/to/model',
      },
      metrics: {
        enabled: false,
        host: '127.0.0.1',
        port: 9477,
        path: '/metrics',
      },
    } as const;

    let currentConfig = { ...baseConfig };

    loadMock.mockResolvedValue(baseConfig);
    getConfigMock.mockImplementation(() => currentConfig);
    getRendererConfigMock.mockImplementation(() => ({
      hasRealtimeApiKey: Boolean(currentConfig.realtimeApiKey),
    }));
    setSecretMock.mockImplementation(async (_key: string, value: string) => {
      currentConfig = { ...currentConfig, realtimeApiKey: value };
      return { hasRealtimeApiKey: Boolean(currentConfig.realtimeApiKey) };
    });
    setAudioDevicePreferencesMock.mockImplementation(async () => ({
      hasRealtimeApiKey: Boolean(currentConfig.realtimeApiKey),
    }));
    testSecretMock.mockResolvedValue({ ok: true });

    await import('../src/main.js');

    whenReadyDeferred.resolve();
    await whenReadyDeferred.promise;
    await flushPromises();

    expect(avatarFaceServiceInstances).toHaveLength(0);
    await waitForExpect(() => {
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Realtime API key unavailable; avatar face uploads disabled.',
      );
    });

    const handleEntries = new Map(ipcMainMock.handle.mock.calls.map(([channel, handler]) => [channel, handler]));

    const setSecretHandler = handleEntries.get('config:set-secret');
    expect(typeof setSecretHandler).toBe('function');
    await expect(setSecretHandler?.({}, { key: 'realtimeApiKey', value: 'fresh-key' })).resolves.toEqual({
      hasRealtimeApiKey: true,
    });

    expect(avatarFaceServiceInstances).toHaveLength(1);
    expect(mockLogger.info).toHaveBeenCalledWith('Avatar face service initialized.', {
      reason: 'secret-update',
    });

    const listFacesHandler = handleEntries.get('avatar:list-faces');
    expect(typeof listFacesHandler).toBe('function');
    await expect(listFacesHandler?.({})).resolves.toEqual([]);
  });

  it('surfaces configuration validation failures to the user', async () => {
    const { ConfigValidationError } = await import('../src/config/config-manager.js');
    const error = new ConfigValidationError('invalid config');
    loadMock.mockRejectedValue(error);

    await import('../src/main.js');

    whenReadyDeferred.resolve();
    await flushPromises();

    await waitForExpect(() => {
      expect(mockLogger.error).toHaveBeenCalledWith('Configuration validation failed', {
        message: error.message,
      });
    });
    await waitForExpect(() => {
      expect(dialogMock.showErrorBox).toHaveBeenCalledWith('Configuration Error', error.message);
    });
    await waitForExpect(() => {
      expect(appEmitter.quit).toHaveBeenCalledTimes(1);
    });
  });

  it('surfaces preload resolution failures and aborts window creation', async () => {
    const attempted = ['/missing/preload.js'];
    resolvePreloadScriptPathMock.mockImplementationOnce(() => {
      throw new RuntimeResourceNotFoundErrorDouble('Unable to locate preload bundle.', attempted);
    });

    const baseConfig = {
      realtimeApiKey: 'rt-key',
      audioInputDeviceId: undefined,
      audioOutputDeviceId: undefined,
      featureFlags: {},
      wakeWord: {
        accessKey: 'access',
        keywordPath: 'keyword.ppn',
        keywordLabel: 'Porcupine',
        sensitivity: 0.5,
        minConfidence: 0.6,
        cooldownMs: 900,
      },
      metrics: {
        enabled: false,
        host: '127.0.0.1',
        port: 9477,
        path: '/metrics',
      },
    } as const;

    loadMock.mockResolvedValue(baseConfig);
    getConfigMock.mockReturnValue(baseConfig);
    getRendererConfigMock.mockReturnValue({ hasRealtimeApiKey: true });
    setAudioDevicePreferencesMock.mockResolvedValue({ hasRealtimeApiKey: true });
    setSecretMock.mockResolvedValue({ hasRealtimeApiKey: true });
    testSecretMock.mockResolvedValue({ ok: true });

    await import('../src/main.js');

    whenReadyDeferred.resolve();
    await whenReadyDeferred.promise;
    await flushPromises();

    await waitForExpect(() => {
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to resolve renderer resources.', {
        message: 'Unable to locate preload bundle.',
        attempted,
      });
    });

    await waitForExpect(() => {
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to create main window.', {
        message: 'Unable to locate preload bundle.',
      });
    });
    await waitForExpect(() => {
      expect(dialogMock.showErrorBox).toHaveBeenCalledWith(
        'Window Creation Error',
        'Unable to locate preload bundle.',
      );
    });
    expect(BrowserWindowMock).not.toHaveBeenCalled();
    expect(appEmitter.quit).toHaveBeenCalledTimes(1);
  });

  it('logs and surfaces configuration bridge registration failures', async () => {
    const registrationError = new Error('Duplicate handler registration');
    ipcMainMock.handle.mockImplementationOnce(() => {
      throw registrationError;
    });

    const config = {
      realtimeApiKey: 'rt-key',
      audioInputDeviceId: undefined,
      audioOutputDeviceId: undefined,
      featureFlags: {},
      wakeWord: {
        accessKey: 'access',
        keywordPath: 'keyword.ppn',
        keywordLabel: 'Porcupine',
        sensitivity: 0.5,
        minConfidence: 0.6,
        cooldownMs: 900,
        deviceIndex: 1,
        modelPath: '/path/to/model',
      },
      metrics: {
        enabled: false,
        host: '127.0.0.1',
        port: 9477,
        path: '/metrics',
      },
    } as const;

    loadMock.mockResolvedValue(config);
    getConfigMock.mockReturnValue(config);
    getRendererConfigMock.mockReturnValue({ hasRealtimeApiKey: true });

    await import('../src/main.js');

    whenReadyDeferred.resolve();
    await whenReadyDeferred.promise;
    await flushPromises();

    const expectedConfigChannels = [
      'config:get',
      'config:get-secret',
      'config:set-secret',
      'config:test-secret',
      'config:set-audio-devices',
    ];

    await waitForExpect(() => {
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Initializing configuration bridge IPC handlers.',
        expect.objectContaining({ channels: expectedConfigChannels }),
      );
    });

    await waitForExpect(() => {
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to register configuration IPC handler.',
        expect.objectContaining({
          channel: 'config:get',
          message: registrationError.message,
        }),
      );
    });

    await waitForExpect(() => {
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to register IPC handlers',
        expect.objectContaining({ message: registrationError.message }),
      );
    });

    await waitForExpect(() => {
      expect(dialogMock.showErrorBox).toHaveBeenCalledWith('IPC Error', registrationError.message);
    });

    await waitForExpect(() => {
      expect(appEmitter.quit).toHaveBeenCalledTimes(1);
    });

    expect(mockLogger.info).not.toHaveBeenCalledWith(
      'Configuration bridge IPC handlers registered.',
      expect.objectContaining({ channels: expectedConfigChannels }),
    );
  });
});
