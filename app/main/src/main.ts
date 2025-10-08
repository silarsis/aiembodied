import { app, BrowserWindow, Tray, dialog, ipcMain } from 'electron';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigManager, ConfigValidationError, type ConfigSecretKey } from './config/config-manager.js';
import { KeytarSecretStore } from './config/keytar-secret-store.js';
import { InMemorySecretStore } from './config/secret-store.js';
import { FilePreferencesStore } from './config/preferences-store.js';
import { initializeLogger } from './logging/logger.js';
import { CrashGuard } from './crash-guard.js';
import { WakeWordService } from './wake-word/wake-word-service.js';
import { ConversationManager } from './conversation/conversation-manager.js';
import type {
  ConversationAppendMessagePayload,
  ConversationMessage,
  ConversationSession,
} from './conversation/types.js';
import { MemoryStore } from './memory/index.js';
import { PrometheusCollector } from './metrics/prometheus-collector.js';
import type { LatencyObservation } from './metrics/types.js';
import { AutoLaunchManager } from './lifecycle/auto-launch.js';
import { createDevTray } from './lifecycle/dev-tray.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isProduction = app.isPackaged || process.env.NODE_ENV === 'production';
const APP_NAME = 'AI Embodied Assistant';

if (!isProduction) {
  const repoRoot = path.resolve(__dirname, '../../..');
  dotenv.config({ path: path.join(repoRoot, '.env') });
}

const secretStore = isProduction ? new KeytarSecretStore('aiembodied') : new InMemorySecretStore();
const { logger } = initializeLogger();
let mainWindow: BrowserWindow | null = null;
let wakeWordService: WakeWordService | null = null;
let memoryStore: MemoryStore | null = null;
let conversationManager: ConversationManager | null = null;
let removeConversationListeners: (() => void) | null = null;
let metricsCollector: PrometheusCollector | null = null;
let autoLaunchManager: AutoLaunchManager | null = null;
let developmentTray: Tray | null = null;

const createWindow = () => {
  const window = new BrowserWindow({
    width: 1920,
    height: 1080,
    kiosk: isProduction,
    fullscreen: !isProduction,
    fullscreenable: true,
    autoHideMenuBar: true,
    backgroundColor: '#020617',
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (!isProduction) {
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        window.setFullScreen(false);
      }
    });
  }

  const rendererDist = path.join(__dirname, '../../renderer/dist/index.html');
  window
    .loadFile(rendererDist)
    .then(() => {
      logger.info('Renderer bundle loaded successfully.');
    })
    .catch((error) => {
      logger.error('Failed to load renderer bundle', { message: error?.message, stack: error?.stack });
    });

  window.on('ready-to-show', () => {
    logger.info('Main window ready to show.');
  });

  window.on('closed', () => {
    mainWindow = null;
  });

  mainWindow = window;
  return window;
};

const crashGuard = new CrashGuard({
  createWindow,
  logger,
});

function registerIpcHandlers(
  manager: ConfigManager,
  conversation: ConversationManager | null,
  metrics: PrometheusCollector | null,
) {
  ipcMain.handle('config:get', () => manager.getRendererConfig());
  ipcMain.handle('config:get-secret', (_event, key: ConfigSecretKey) => manager.getSecret(key));
  ipcMain.handle('config:set-secret', (_event, payload: { key: ConfigSecretKey; value: string }) =>
    manager.setSecret(payload.key, payload.value),
  );
  ipcMain.handle('config:test-secret', (_event, key: ConfigSecretKey) => manager.testSecret(key));
  ipcMain.handle('config:set-audio-devices', (_event, preferences) =>
    manager.setAudioDevicePreferences(preferences),
  );
  ipcMain.handle('conversation:get-history', () => {
    if (!conversation) {
      throw new Error('Conversation manager is not initialized.');
    }
    return conversation.getHistory();
  });
  ipcMain.handle('conversation:append-message', (_event, payload: ConversationAppendMessagePayload) => {
    if (!conversation) {
      throw new Error('Conversation manager is not initialized.');
    }
    return conversation.appendMessage(payload);
  });
  ipcMain.handle('metrics:observe-latency', (_event, payload: LatencyObservation) => {
    if (!metrics) {
      return false;
    }

    if (!payload || typeof payload.valueMs !== 'number') {
      throw new Error('Invalid latency observation payload received.');
    }

    metrics.observeLatency(payload.metric, payload.valueMs);
    return true;
  });
}

function focusExistingWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    logger.warn('Main window missing on second-instance event. Relaunching.');
    const window = createWindow();
    crashGuard.watch(window);
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.focus();
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  logger.warn('Another instance of aiembodied is already running. Quitting.');
  app.quit();
} else {
  logger.info('Primary instance lock acquired.');
  app.on('second-instance', () => {
    focusExistingWindow();
  });
}

app.whenReady().then(async () => {
  const manager = new ConfigManager({
    secretStore,
    preferencesStore: new FilePreferencesStore(path.join(app.getPath('userData'), 'preferences.json')),
  });

  try {
    memoryStore = new MemoryStore({ filePath: path.join(app.getPath('userData'), 'memory.db') });
    conversationManager = new ConversationManager({
      store: memoryStore,
      logger,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown database initialization error occurred.';
    logger.error('Failed to initialize memory store', { message });
    dialog.showErrorBox('Database Error', message);
    app.quit();
    return;
  }

  try {
    await manager.load();
  } catch (error) {
    const message =
      error instanceof ConfigValidationError || error instanceof Error
        ? error.message
        : 'Unknown configuration error occurred.';
    logger.error('Configuration validation failed', { message });
    dialog.showErrorBox('Configuration Error', message);
    app.quit();
    return;
  }

  const appConfig = manager.getConfig();

  autoLaunchManager = new AutoLaunchManager({
    logger,
    appName: APP_NAME,
    appPath: app.getPath('exe'),
  });

  const shouldEnableAutoLaunch = isProduction || process.env.ENABLE_AUTO_LAUNCH === '1';
  const launchEnabled = await autoLaunchManager.sync(shouldEnableAutoLaunch);
  logger.info('Auto-launch synchronization complete.', { enabled: launchEnabled });

  if (!isProduction) {
    try {
      developmentTray = await createDevTray({
        autoLaunchManager,
        logger,
        onQuit: () => {
          app.quit();
        },
        onShowWindow: () => {
          if (!mainWindow || mainWindow.isDestroyed()) {
            const newWindow = createWindow();
            crashGuard.watch(newWindow);
            return;
          }

          focusExistingWindow();
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Failed to create development tray', { message });
    }
  }

  if (appConfig.metrics.enabled) {
    metricsCollector = new PrometheusCollector({
      host: appConfig.metrics.host,
      port: appConfig.metrics.port,
      path: appConfig.metrics.path,
      logger,
    });

    try {
      await metricsCollector.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Failed to start metrics exporter', { message });
      metricsCollector = null;
    }
  }

  wakeWordService = new WakeWordService({
    logger,
    cooldownMs: appConfig.wakeWord.cooldownMs,
    minConfidence: appConfig.wakeWord.minConfidence,
  });

  wakeWordService.on('wake', (event) => {
    logger.info('Wake word detected in main process', {
      keyword: event.keywordLabel,
      confidence: event.confidence,
    });

    let sessionId: string | null = null;
    if (conversationManager) {
      try {
        const session = conversationManager.startSession({ startedAt: event.timestamp });
        sessionId = session.id;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Failed to start new conversation session', { message });
      }
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('wake-word:event', {
        ...event,
        sessionId: sessionId ?? event.sessionId,
      });
    }
  });

  wakeWordService.on('error', (serviceError) => {
    logger.error('Wake word service error', {
      message: serviceError.message,
      stack: serviceError.stack,
    });
  });

  wakeWordService.on('ready', (info) => {
    logger.info('Wake word service ready', info);
  });

  try {
    wakeWordService.start({
      accessKey: appConfig.wakeWord.accessKey,
      keywordPath: appConfig.wakeWord.keywordPath,
      keywordLabel: appConfig.wakeWord.keywordLabel,
      sensitivity: appConfig.wakeWord.sensitivity,
      modelPath: appConfig.wakeWord.modelPath,
      deviceIndex: appConfig.wakeWord.deviceIndex,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to start wake word service', {
      message,
    });
  }

  registerIpcHandlers(manager, conversationManager, metricsCollector);

  if (conversationManager) {
    const sessionListener = (session: ConversationSession) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('conversation:session-started', session);
      }
    };

    const messageListener = (message: ConversationMessage) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('conversation:message-appended', message);
      }
    };

    conversationManager.on('session-started', sessionListener);
    conversationManager.on('message-appended', messageListener);
    removeConversationListeners = () => {
      conversationManager?.off('session-started', sessionListener);
      conversationManager?.off('message-appended', messageListener);
      removeConversationListeners = null;
    };
  }
  const window = createWindow();
  crashGuard.watch(window);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const newWindow = createWindow();
      crashGuard.watch(newWindow);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  crashGuard.notifyAppQuitting();
  logger.info('Application is quitting.');
  if (wakeWordService) {
    void wakeWordService.dispose();
  }
  if (memoryStore) {
    memoryStore.dispose();
    memoryStore = null;
  }
  if (removeConversationListeners) {
    removeConversationListeners();
  }
  conversationManager = null;
  if (metricsCollector) {
    void metricsCollector.stop().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Failed to stop metrics exporter cleanly', { message });
    });
    metricsCollector = null;
  }
  if (developmentTray) {
    developmentTray.destroy();
    developmentTray = null;
  }
});
