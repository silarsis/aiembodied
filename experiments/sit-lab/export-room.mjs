// Finds the rooms the app saved (<userData>/rooms/<id>/room.json) and its built-in rooms, lists them, and copies one out.
// Usage: node export-room.mjs                       list rooms and their seats
//        node export-room.mjs <room id or name> --out rooms/sofa.json
//        add --user-data <folder> if the app's data folder is not one of the usual places
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function candidateFolders(explicit) {
  if (explicit) return [resolve(explicit)];
  const roaming = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  const devRoaming = join(repoRoot, '.dev-home', 'AppData', 'Roaming');
  return [
    join(roaming, 'Electron'),
    join(roaming, '@aiembodied', 'main'),
    join(devRoaming, 'Electron'),
    join(devRoaming, '@aiembodied', 'main'),
  ];
}

const argv = process.argv.slice(2);
let userData;
let out;
let wanted;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--user-data') userData = argv[(i += 1)];
  else if (argv[i] === '--out') out = argv[(i += 1)];
  else wanted = argv[i];
}

const found = [];
for (const folder of candidateFolders(userData)) {
  const roomsDir = join(folder, 'rooms');
  if (!existsSync(roomsDir)) continue;
  for (const entry of readdirSync(roomsDir, { withFileTypes: true })) {
    const file = join(roomsDir, entry.name, 'room.json');
    if (entry.isDirectory() && existsSync(file)) {
      found.push({
        assets: join(roomsDir, 'assets'),
        id: entry.name,
        file,
        room: JSON.parse(readFileSync(file, 'utf8')),
      });
    }
  }
}
if (found.length === 0) {
  console.log(
    `No saved rooms in ${candidateFolders(userData).join(' or ')}; pass --user-data <the app's data folder> for them.`,
  );
}
// The app's built-in rooms (the reading room and the studio flat) are not saved under userData.
const builtInDir = join(repoRoot, 'app', 'main', 'assets', 'rooms');
for (const name of readdirSync(builtInDir)) {
  if (!name.endsWith('.json')) continue;
  const file = join(builtInDir, name);
  const room = JSON.parse(readFileSync(file, 'utf8'));
  found.push({ assets: builtInDir, id: room.id, file, room });
}
if (!wanted) {
  for (const { id, room, assets } of found) {
    console.log(`${id}  "${room.name}"  (assets: ${assets})`);
    for (const object of room.objects) {
      console.log(
        `    ${object.id}  ${object.name}  at ${object.position.map((v) => v.toFixed(2)).join(', ')}`,
      );
    }
  }
  process.exit(0);
}

const match = found.filter(
  ({ id, room }) =>
    id === wanted || room.id === wanted || room.name.toLowerCase() === wanted.toLowerCase(),
);
if (match.length !== 1) {
  throw new Error(`${match.length} rooms match "${wanted}"; run without arguments to list them.`);
}
if (!out) throw new Error('Give --out <file> for the copy.');
mkdirSync(dirname(resolve(out)), { recursive: true });
copyFileSync(match[0].file, resolve(out));
console.log(`Copied ${match[0].file} to ${resolve(out)}`);
console.log(`Room assets (pass to run.mjs as --assets): ${match[0].assets}`);
