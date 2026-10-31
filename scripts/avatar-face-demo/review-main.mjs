import { app, BrowserWindow, ipcMain } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
const output = path.resolve(process.env.FACE_DEMO_OUTPUT || 'artifacts/local-face-mvp-2026-10-31');
const work = path.join(root, '.dev-home/face-runtime-review');
await mkdir(work, { recursive: true });
app.setPath('userData', path.join(work, 'electron-cache'));
ipcMain.handle('face:characters', () =>
  readFile(path.join(output, 'characters.json'), 'utf8')
    .then(JSON.parse)
    .then((characters) =>
      process.env.FACE_DEMO_IDS
        ? characters.filter(([id]) => process.env.FACE_DEMO_IDS.split(',').includes(id))
        : characters,
    ),
);
ipcMain.handle('face:model', async (_, id) => {
  if (!/^[a-z]+$/.test(id)) throw new Error('Invalid character');
  return new Uint8Array(await readFile(path.join(output, id, 'avatar.vrm')));
});
ipcMain.handle('face:frame', async (_, id) => {
  if (!/^[a-z]+$/.test(id)) throw new Error('Invalid character');
  return JSON.parse(await readFile(path.join(output, id, 'face-landmarks.json'), 'utf8'));
});
ipcMain.handle('face:save', async (_, { id, name, png, meta }) => {
  if (!/^[a-z]+$/.test(id) || !/^[a-z-]+$/.test(name)) throw new Error('Invalid review output');
  const directory = path.join(output, id, 'runtime');
  await mkdir(directory, { recursive: true });
  if (png)
    await writeFile(path.join(directory, name + '.png'), Buffer.from(png.split(',')[1], 'base64'));
  if (meta) await writeFile(path.join(directory, name + '.json'), JSON.stringify(meta, null, 2));
});
ipcMain.on('face:done', () => app.quit());
app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({
      width: 400,
      height: 400,
      show: false,
      webPreferences: {
        offscreen: true,
        backgroundThrottling: false,
        sandbox: false,
        contextIsolation: true,
        preload: path.join(root, 'scripts/avatar-face-demo/review-preload.mjs'),
      },
    });
    win.webContents.on('console-message', (event) => console.log(event.message));
    await win.loadFile(path.join(work, 'index.html'));
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
