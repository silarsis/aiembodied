// Scores the final-pose pictures of every trial in a run with a local vision model, blind to the method.
// Usage: node judge.mjs <runId> [--url http://127.0.0.1:1237/v1] [--model qwen3-vl] [--redo]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rewriteSummary, trialFiles } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const VIEWS = ['front', 'side', 'threeQuarter'];
const RUBRIC = `You are checking a 3D avatar that has just sat down on a piece of furniture. You see three pictures of the same moment: front, side and three-quarter view. Score how natural and physically plausible the seated pose looks.

5 = a natural seated pose: sitting on the seat, thighs on it, feet on the floor in front, nothing passes through anything.
4 = natural overall with one small flaw (a hand or knee slightly off).
3 = recognisably seated but with a clear flaw: a limb through the furniture or the body, or feet floating or sunk.
2 = badly wrong: body sunk into the seat, legs through the chair front, or a twisted limb.
1 = not seated at all, or a broken, tangled body.

Look for: the body sinking into the seat, legs or feet through the chair, an arm through the torso, twisted knees or elbows, floating above the seat.
Answer with JSON only: {"score": <1-5>, "reason": "<one short sentence>"}`;

const args = process.argv.slice(2);
const runId = args.find((a) => !a.startsWith('--'));
if (!runId) throw new Error('Usage: node judge.mjs <runId>');
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const base = option('url', 'http://127.0.0.1:1237/v1');
const model = option('model', 'qwen3-vl');
const redo = args.includes('--redo');
const runDir = join(here, 'results', runId);
if (!existsSync(runDir)) throw new Error(`No run folder ${runDir}`);

const picture = (stem, view) =>
  `data:image/png;base64,${readFileSync(`${stem}-final-${view}.png`).toString('base64')}`;

async function judge(stem) {
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 200,
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: RUBRIC },
            ...VIEWS.map((view) => ({
              type: 'image_url',
              image_url: { url: picture(stem, view) },
            })),
          ],
        },
      ],
    }),
  });
  if (!response.ok)
    throw new Error(`The vision server answered ${response.status}: ${await response.text()}`);
  const text = (await response.json()).choices?.[0]?.message?.content ?? '';
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error(`No JSON in the answer: ${text}`);
  const parsed = JSON.parse(json);
  if (!Number.isInteger(parsed.score) || parsed.score < 1 || parsed.score > 5) {
    throw new Error(`Score out of range in: ${text}`);
  }
  return { score: parsed.score, reason: String(parsed.reason ?? '') };
}

let scored = 0;
for (const file of trialFiles(runDir)) {
  const trial = JSON.parse(readFileSync(file, 'utf8'));
  if (trial.visionScore !== undefined && !redo) continue;
  const verdict = await judge(file.replace(/\.json$/, ''));
  trial.visionScore = verdict.score;
  trial.visionReason = verdict.reason;
  writeFileSync(file, JSON.stringify(trial, null, 1));
  scored += 1;
  console.log(`${trial.trialId}: ${verdict.score} ${verdict.reason}`);
}
rewriteSummary(runDir);
console.log(`Scored ${scored} trials; summary.csv updated.`);
