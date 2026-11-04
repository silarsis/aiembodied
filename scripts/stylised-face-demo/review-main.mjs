import { app, BrowserWindow, ipcMain } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
const output = path.resolve(process.env.STYLISED_REVIEW_DIR);
const work = path.join(root, '.dev-home/stylised-face-review');
app.setPath('userData', path.join(work, 'electron-cache'));
const safe = (id) => {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error('Invalid character');
  return id;
};
ipcMain.handle('face:characters', async () => JSON.parse(await readFile(path.join(output, 'characters.json'), 'utf8')));
ipcMain.handle('face:model', async (_, id) => new Uint8Array(await readFile(path.join(output, safe(id), 'avatar.vrm'))));
ipcMain.handle('face:frame', async (_, id) => JSON.parse(await readFile(path.join(output, safe(id), 'stylised-face-landmarks.json'), 'utf8')));
ipcMain.handle('face:save', async (_, { id, name, png, meta }) => {
  if (!/^[a-zA-Z0-9-]+$/.test(name)) throw new Error('Invalid name');
  const directory = path.join(output, safe(id), 'runtime');
  await mkdir(directory, { recursive: true });
  if (png) await writeFile(path.join(directory, name + '.png'), Buffer.from(png.split(',')[1], 'base64'));
  if (meta) await writeFile(path.join(directory, name + '.json'), JSON.stringify(meta, null, 2));
});
ipcMain.on('face:done', () => app.quit());
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 400, height: 400, show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: false, contextIsolation: true, preload: path.join(root, 'scripts/stylised-face-demo/review-preload.mjs') },
  });
  win.webContents.on('console-message', (event) => console.log(event.message));
  await win.loadFile(path.join(work, 'index.html'));
}).catch((error) => { console.error(error); app.exit(1); });
