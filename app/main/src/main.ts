import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigManager, ConfigValidationError, type ConfigSecretKey } from './config/config-manager.js';
import { KeytarSecretStore } from './config/keytar-secret-store.js';
import { InMemorySecretStore } from './config/secret-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isProduction = process.env.NODE_ENV === 'production';

if (!isProduction) {
  const repoRoot = path.resolve(__dirname, '../../..');
  dotenv.config({ path: path.join(repoRoot, '.env') });
}

const secretStore = isProduction ? new KeytarSecretStore('aiembodied') : new InMemorySecretStore();
const configManager = new ConfigManager({ secretStore });

function registerIpcHandlers() {
  ipcMain.handle('config:get', () => configManager.getRendererConfig());
  ipcMain.handle('config:get-secret', (_event, key: ConfigSecretKey) => configManager.getSecret(key));
}

function createMainWindow() {
  const window = new BrowserWindow({
    width: 1024,
    height: 768,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  const rendererDist = path.join(__dirname, '../../renderer/dist/index.html');
  window.loadFile(rendererDist).catch((error) => {
    console.error('Failed to load renderer bundle', error);
  });

  return window;
}

app.whenReady().then(async () => {
  try {
    await configManager.load();
  } catch (error) {
    const message =
      error instanceof ConfigValidationError || error instanceof Error
        ? error.message
        : 'Unknown configuration error occurred.';
    dialog.showErrorBox('Configuration Error', message);
    app.quit();
    return;
  }

  registerIpcHandlers();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
