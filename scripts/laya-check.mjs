#!/usr/bin/env node
/**
 * A quick live check of the Quick decisions server (Laya, services/laya): sends a few known
 * situations, asked the way the app asks them, and prints the answers and how long each took.
 *
 *   pnpm laya:check                         # http://127.0.0.1:8197
 *   pnpm laya:check -- http://other:8197
 *   LAYA_URL=http://other:8197 pnpm laya:check
 *
 * Start the server first (pnpm dev:run does, or services/laya/scripts/start.ps1).
 * Exits 1 when the server does not answer or an answer looks wrong.
 */
const base = (process.argv[2] || process.env.LAYA_URL || 'http://127.0.0.1:8197').replace(/\/+$/, '');
const model = process.env.LAYA_CHECK_MODEL || 'english';

const WANT_LEVELS = ['nothing to add', 'a little', 'somewhat', 'quite a lot', 'must answer'];

const cases = [
  {
    name: 'Sage asks Echo, but says "lenha"',
    expect: { who: 'Echo' },
    state: {
      recent: ["Kevin: Sage, can you ask Echo what they're doing?"],
      line: { speaker: 'Sage', text: 'lenha, what are you up to right now?' },
    },
    questions: {
      who: {
        type: 'choice',
        instructions: 'Who is Sage speaking to in their last line?',
        criteria: {
          Echo: 'Echo is the one being spoken to.',
          Kevin: 'Kevin, the person in the room, is the one being spoken to.',
          everyone: 'Everyone in the room is being spoken to, or no one in particular.',
        },
      },
    },
  },
  {
    name: 'Kevin names two avatars',
    expect: { who: 'Sage' },
    state: { line: { speaker: 'Kevin', text: "Sage, what do you think Echo would like for dinner?" } },
    questions: {
      who: {
        type: 'choice',
        instructions: 'Who is Kevin speaking to in their last line?',
        criteria: {
          Sage: 'Sage is the one being spoken to.',
          Echo: 'Echo is the one being spoken to.',
          everyone: 'Everyone in the room is being spoken to, or no one in particular.',
        },
      },
    },
  },
  {
    name: 'Bids after a question to the room',
    state: { recent: ['Echo: Does anyone know if it will rain this afternoon?'] },
    questions: {
      bid0: { type: 'score', instructions: 'How much does Sage want to reply right now to the last line?', criteria: WANT_LEVELS },
    },
  },
  {
    name: 'Home event: front door left open at night',
    expect: { action: 'say' },
    state: {
      presence: { doNotDisturb: false, listening: true, voicePhase: 'waiting', secondsSinceUserSpoke: 900, localTime: 'Thu 23:40' },
      event: { type: 'home.change', source: 'homeassistant', priority: 'normal', text: 'Front door has been open for 10 minutes.' },
    },
    questions: {
      action: {
        type: 'choice',
        instructions: 'What should the assistant do with this message?',
        criteria: {
          ignore: 'noise, nothing Kevin needs',
          remember: 'worth knowing later, not worth interrupting',
          say: 'Kevin would want to hear it now',
        },
      },
      urgent: { type: 'noul', instructions: 'Is this urgent enough to interrupt Kevin even mid-conversation?' },
    },
  },
  {
    name: 'Home event: sensor noise',
    expect: { action: 'ignore' },
    state: {
      presence: { doNotDisturb: false, listening: true, voicePhase: 'waiting', secondsSinceUserSpoke: 300, localTime: 'Thu 14:05' },
      event: { type: 'home.change', source: 'homeassistant', priority: 'normal', text: 'Hallway sensor battery 87% (was 88%).' },
    },
    questions: {
      action: {
        type: 'choice',
        instructions: 'What should the assistant do with this message?',
        criteria: {
          ignore: 'noise, nothing Kevin needs',
          remember: 'worth knowing later, not worth interrupting',
          say: 'Kevin would want to hear it now',
        },
      },
    },
  },
  {
    name: 'Proactive: Kevin came back after two hours',
    expect: { what: 'arrival' },
    state: {
      presence: { doNotDisturb: false, secondsSinceUserSpoke: 7300, secondsSinceFaceSeen: 5, awayMinutes: 120, localTime: 'Thu 18:10' },
      reasons: ['arrival'],
    },
    questions: {
      act: { type: 'noul', instructions: 'Is this a good moment for Echo to say something to Kevin unprompted?' },
      what: {
        type: 'choice',
        instructions: 'What should Echo say something about?',
        criteria: { arrival: 'Kevin has just come back after being away', nothing: 'nothing, stay quiet' },
      },
    },
  },
];

/** The top option of a choice answer, or the number for score / yes-no. */
function summarise(question, answer) {
  if (!answer || typeof answer !== 'object') return { text: JSON.stringify(answer) };
  if (question.type === 'choice') {
    const probs = answer.probabilities ?? {};
    const sorted = Object.entries(probs).sort((a, b) => b[1] - a[1]);
    return { top: sorted[0]?.[0], text: sorted.map(([k, p]) => `${k} ${Number(p).toFixed(2)}`).join(', ') };
  }
  if (question.type === 'score') {
    const levels = question.criteria.length;
    const score = Number(answer.score);
    return { text: `${score.toFixed(2)} of ${levels - 1} (want ${(score / (levels - 1)).toFixed(2)})` };
  }
  return { text: `yes ${Number(answer.noul).toFixed(2)}` };
}

async function main() {
  let failed = false;
  const t0 = performance.now();
  let health;
  try {
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
    health = await response.json();
  } catch (error) {
    console.error(`No answer from ${base}/health: ${error instanceof Error ? error.message : String(error)}`);
    console.error('Start the server with pnpm dev:run or services/laya/scripts/start.ps1.');
    process.exit(1);
  }
  console.log(`Laya at ${base}: ${JSON.stringify(health)} (${Math.round(performance.now() - t0)} ms)\n`);

  for (const item of cases) {
    const started = performance.now();
    try {
      const response = await fetch(`${base}/v1/systemone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, state: item.state, questions: item.questions }),
        signal: AbortSignal.timeout(30_000),
      });
      const ms = Math.round(performance.now() - started);
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const body = await response.json();
      console.log(`${item.name}  (${ms} ms)`);
      for (const [key, question] of Object.entries(item.questions)) {
        const { top, text } = summarise(question, body.answers?.[key]);
        const want = item.expect?.[key];
        const mark = want === undefined ? '' : top === want ? '  ok' : `  EXPECTED ${want}`;
        if (want !== undefined && top !== want) failed = true;
        console.log(`  ${key}: ${text}${mark}`);
      }
      console.log('');
    } catch (error) {
      failed = true;
      console.log(`${item.name}: failed (${error instanceof Error ? error.message : String(error)})\n`);
    }
  }
  console.log(failed ? 'Some answers were not what the app would want; see EXPECTED above.' : 'All answers as expected.');
  process.exit(failed ? 1 : 0);
}

void main();
