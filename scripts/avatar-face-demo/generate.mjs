import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { ComfyUIClient } from '../../app/main/dist/avatar/generation/comfyui-client.js';
import { ComfyUIRuntime } from '../../app/main/dist/avatar/generation/comfyui-runtime.js';
import { conceptGraph } from '../../app/main/dist/avatar/generation/graphs.js';
import { characterMeshGraph } from '../../app/main/dist/avatar/generation/character/graphs.js';
const out = process.env.FACE_DEMO_OUTPUT || process.cwd() + '/artifacts/local-face-mvp-2026-10-31';
await mkdir(out, { recursive: true });
const characters = [
  [
    'ada',
    'Ada — explorer',
    'An adult woman explorer, warm light skin, short swept back auburn hair, green eyes, round face, fitted sage green jumpsuit and tan boots',
  ],
  [
    'malik',
    'Malik — engineer',
    'An adult Black man engineer, dark brown skin, short tightly curled black hair, brown eyes, broad nose, clean shaven, fitted blue utility jumpsuit and orange boots',
  ],
  [
    'mei',
    'Mei — botanist',
    'An adult East Asian woman botanist, pale warm skin, straight short black bob tucked behind ears, dark brown eyes, oval face, fitted mustard yellow jumpsuit and green boots',
  ],
  [
    'oscar',
    'Oscar — pilot',
    'An older adult man pilot, fair skin, short swept back silver hair, blue eyes, long face and prominent nose, clean shaven, fitted burgundy jumpsuit and black boots',
  ],
  [
    'ines',
    'Ines — artist',
    'An adult woman artist, medium olive skin, short swept back violet hair, hazel eyes, angular face and thick dark eyebrows, fitted teal jumpsuit and red boots',
  ],
];
const client = new ComfyUIClient({ baseUrl: 'http://127.0.0.1:8188' });
await new ComfyUIRuntime({ client, logDirectory: process.cwd() + '/.dev-home/logs' }).ensureReady();
await writeFile(out + '/characters.json', JSON.stringify(characters, null, 2));
for (let i = 0; i < characters.length; i++) {
  const [id, name, description] = characters[i];
  const dir = out + '/' + id;
  await mkdir(dir, { recursive: true });
  const prompt = `Full body front view stylised 3D animated film character: ${description}. Adult human proportions, head one sixth total height. Symmetric A pose, straight arms 45 degrees away from body, straight legs slightly apart. One character only. Visible detailed attractive neutral relaxed face with open eyes and closed lips, clearly defined eyelids, lips, eyebrows and nose. Entire face unobscured. Short hair. Close fitting outfit. Whole body and feet visible with margin. Pure white background, soft even lighting, no shadows, no props, no text, no turnaround. Realistic facial anatomy with moderate stylisation, no oversized eyes.`;
  const previous = await readFile(dir + '/request.json', 'utf8')
    .then(JSON.parse)
    .catch(() => null);
  if (previous && (previous.prompt !== prompt || previous.seed !== 903100 + i))
    throw new Error(
      'Existing demo differs from the requested prompt/seed. Choose another FACE_DEMO_OUTPUT directory.',
    );
  await writeFile(
    dir + '/request.json',
    JSON.stringify({ id, name, description, prompt, seed: 903100 + i }, null, 2),
  );
  let png;
  try {
    await access(dir + '/concept.png');
    png = await readFile(dir + '/concept.png');
  } catch {
    console.log('IMAGE', id);
    png = await client.run(conceptGraph(prompt, 903100 + i));
    await writeFile(dir + '/concept.png', png);
  }
  try {
    await access(dir + '/source.glb');
  } catch {
    console.log('MESH', id);
    const image = await client.uploadImage('face-mvp-' + id + '.png', png);
    const graph = characterMeshGraph(image, 903100 + i);
    await writeFile(dir + '/mesh.graph.json', JSON.stringify(graph));
    const mesh = await client.run(graph, { output: 'mesh' });
    await writeFile(dir + '/source.glb', mesh);
  }
  console.log('READY', id);
}
