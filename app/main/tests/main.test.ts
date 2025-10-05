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

const ConfigManagerMock = vi.fn(() => ({
  load: loadMock,
  getConfig: getConfigMock,
  getRendererConfig: getRendererConfigMock,
  getSecret: getSecretMock,
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

    whenReadyDeferred = createDeferred<void>();
    appEmitter.whenReady.mockImplementation(() => whenReadyDeferred.promise);
    appEmitter.requestSingleInstanceLock.mockReturnValue(true);

    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
    mockLogger.debug.mockReset();
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

    expect(ipcMainMock.handle).toHaveBeenCalledTimes(2);
    const [configChannel, configHandler] = ipcMainMock.handle.mock.calls[0];
    expect(configChannel).toBe('config:get');
    expect(configHandler()).toEqual({ hasRealtimeApiKey: true });

    const [secretChannel, secretHandler] = ipcMainMock.handle.mock.calls[1];
    expect(secretChannel).toBe('config:get-secret');
    getSecretMock.mockResolvedValueOnce('secret');
    await expect(secretHandler({}, 'realtimeApiKey')).resolves.toBe('secret');
    expect(getSecretMock).toHaveBeenCalledWith('realtimeApiKey');

    const wakePayload = { keywordLabel: 'Porcupine', confidence: 0.92, timestamp: Date.now() };
    wakeWordService.emit('wake', wakePayload);
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('wake-word:event', wakePayload);

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
