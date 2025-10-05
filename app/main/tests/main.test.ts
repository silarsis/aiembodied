import { EventEmitter } from 'node:events';
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

const loadMock = vi.fn();
const getConfigMock = vi.fn();
const getRendererConfigMock = vi.fn();
const getSecretMock = vi.fn();
const setAudioDevicePreferencesMock = vi.fn();
const loadPreferencesMock = vi.fn();
const savePreferencesMock = vi.fn();

const ConfigManagerMock = vi.fn(() => ({
  load: loadMock,
  getConfig: getConfigMock,
  getRendererConfig: getRendererConfigMock,
  getSecret: getSecretMock,
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
});

vi.mock('electron', () => ({
  app: appEmitter,
  BrowserWindow: BrowserWindowMock,
  dialog: dialogMock,
  ipcMain: ipcMainMock,
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

    loadMock.mockReset();
    getConfigMock.mockReset();
    getRendererConfigMock.mockReset();
    getSecretMock.mockReset();
    setAudioDevicePreferencesMock.mockReset();
    loadPreferencesMock.mockReset();
    savePreferencesMock.mockReset();
    FilePreferencesStoreMock.mockReset();
    ConfigManagerMock.mockClear();

    WakeWordServiceMock.mockReset();
    WakeWordServiceMock.mockImplementation(createWakeWordServiceInstance);
    wakeWordServiceInstances.length = 0;

    CrashGuardMock.mockReset();
    CrashGuardMock.mockImplementation(createCrashGuardInstance);
    crashGuardInstances.length = 0;

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
    appEmitter.getPath.mockClear();

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
    } as const;

    loadMock.mockResolvedValue(config);
    getConfigMock.mockReturnValue(config);
    getRendererConfigMock.mockReturnValue({ hasRealtimeApiKey: true });
    setAudioDevicePreferencesMock.mockResolvedValue({ hasRealtimeApiKey: true });

    const serviceReady = createDeferred<void>();
    WakeWordServiceMock.mockImplementation((options: unknown) => {
      const instance = createWakeWordServiceInstance(options);
      serviceReady.resolve();
      return instance;
    });

    await import('../src/main.js');

    whenReadyDeferred.resolve();
    await whenReadyDeferred.promise;
    await flushPromises();
    await serviceReady.promise;

    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(WakeWordServiceMock).toHaveBeenCalledTimes(1);
    expect(WakeWordServiceMock.mock.calls[0][0]).toMatchObject({
      logger: mockLogger,
      cooldownMs: config.wakeWord.cooldownMs,
      minConfidence: config.wakeWord.minConfidence,
    });

    const wakeWordService = wakeWordServiceInstances[0];
    expect(wakeWordService.start).toHaveBeenCalledWith({
      accessKey: config.wakeWord.accessKey,
      keywordPath: config.wakeWord.keywordPath,
      keywordLabel: config.wakeWord.keywordLabel,
      sensitivity: config.wakeWord.sensitivity,
      modelPath: config.wakeWord.modelPath,
      deviceIndex: config.wakeWord.deviceIndex,
    });

    expect(BrowserWindowMock).toHaveBeenCalledTimes(1);
    const mainWindow = createdWindows[0];
    expect(mainWindow.loadFile).toHaveBeenCalledWith(
      expect.stringContaining('renderer/dist/index.html'),
    );

    expect(crashGuardInstances).toHaveLength(1);
    expect(crashGuardInstances[0].watch).toHaveBeenCalledWith(mainWindow);

    expect(ipcMainMock.handle).toHaveBeenCalledTimes(5);
    const handleEntries = new Map(ipcMainMock.handle.mock.calls.map(([channel, handler]) => [channel, handler]));

    const configHandler = handleEntries.get('config:get');
    expect(typeof configHandler).toBe('function');
    expect(configHandler?.()).toEqual({ hasRealtimeApiKey: true });

    const secretHandler = handleEntries.get('config:get-secret');
    expect(typeof secretHandler).toBe('function');
    getSecretMock.mockResolvedValueOnce('secret');
    await expect(secretHandler?.({}, 'realtimeApiKey')).resolves.toBe('secret');
    expect(getSecretMock).toHaveBeenCalledWith('realtimeApiKey');

    const deviceHandler = handleEntries.get('config:set-audio-devices');
    expect(typeof deviceHandler).toBe('function');
    await deviceHandler?.({}, { audioInputDeviceId: 'mic', audioOutputDeviceId: 'spk' });
    expect(setAudioDevicePreferencesMock).toHaveBeenCalledWith({
      audioInputDeviceId: 'mic',
      audioOutputDeviceId: 'spk',
    });

    expect(typeof handleEntries.get('conversation:get-history')).toBe('function');
    expect(typeof handleEntries.get('conversation:append-message')).toBe('function');

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

    appEmitter.emit('before-quit');
    expect(crashGuardInstances[0].notifyAppQuitting).toHaveBeenCalledTimes(1);
    expect(wakeWordService.dispose).toHaveBeenCalledTimes(1);
    await expect(wakeWordService.dispose.mock.results[0].value).resolves.toBeUndefined();
    expect(memoryStoreDisposeMock).toHaveBeenCalledTimes(1);

    appEmitter.emit('window-all-closed');
    expect(appEmitter.quit).toHaveBeenCalledTimes(1);
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
});
