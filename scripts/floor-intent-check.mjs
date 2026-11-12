#!/usr/bin/env node
/**
 * An experiment: can a decision model work out, from Kevin's sentence alone, who should speak next
 * and what Kevin wants, well enough to replace the hand-written rules in
 * app/main/src/floor/floor-manager.ts (routePerson)? Every case is put to:
 *  - a chat model on an OpenAI-compatible server, in four prompt/request variants (--variants):
 *      a  baseline: one JSON object {speaker, intent, target}
 *      b  a, with a JSON schema that only allows the legal values
 *      c  reframed fields {addressed, wants, other} + schema; the app-side code picks the speaker
 *         when the line names no listener
 *      d  c plus six worked examples from another room
 *  - the Quick decisions server (Laya): a diagnosis on a subset of cases, asked in several request
 *    shapes, printing the full probability vectors (--laya-probes, on by default). The full
 *    54-case Laya run of round 1 is off unless --laya-main is given.
 *
 *   pnpm floor:check
 *   pnpm floor:check -- --variants c,d --no-laya-probes --md report.md
 *   pnpm floor:check -- --only laya --json out.json --verbose
 *   LAYA_URL=http://other:8197 LLM_URL=http://other:1234 LLM_MODEL=name pnpm floor:check
 *
 * Flags: --only laya|llm, --variants a,b,c,d, --laya-main, --no-laya-probes, --json file,
 * --md file, --verbose (per-case tables on the console; --json always has them).
 * The code half of the hybrid router (which lines the rules decide) is replayed with these same cases in
 * app/main/tests/floor-intent-replay.test.ts; the table lives in app/main/tests/fixtures/floor-intent-cases.ts.
 * A back end that does not answer its health probe is skipped. Exits 1 only when both are down.
 */
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(name);
const only = flag('--only');
const jsonPath = flag('--json');
const mdPath = flag('--md');
const verbose = has('--verbose');
const layaMain = has('--laya-main') && !has('--skip-laya-main');
const layaProbes = !has('--no-laya-probes');
const ALL_VARIANTS = ['a', 'b', 'c', 'd'];
const variantIds = (flag('--variants') ?? ALL_VARIANTS.join(',')).split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
const badVariant = variantIds.find((v) => !ALL_VARIANTS.includes(v));
if (badVariant || variantIds.length === 0) {
  console.error(`Unknown variant "${badVariant}"; use a comma list of ${ALL_VARIANTS.join(', ')}.`);
  process.exit(2);
}
const layaBase = (process.env.LAYA_URL || 'http://127.0.0.1:8197').replace(/\/+$/, '');
const layaModel = process.env.LAYA_CHECK_MODEL || 'english';
const llmBase = (process.env.LLM_URL || 'http://127.0.0.1:1234').replace(/\/+$/, '');
const CALL_MS = 20_000;
const CONFIDENT = 0.6;
const GRADES = ['simple', 'medium', 'convoluted'];
const FIELDS = ['speaker', 'intent', 'target'];

const S2 = ['Echo', 'Sage'];
const S3 = ['Echo', 'Sage', 'Rex'];
/** Truth values: a string, or an array of accepted strings. `d` marks a debatable case (printed, not scored). */
const C = (grade, text, speaker, intent, target, o = {}) => ({ grade, text, speaker, intent, target, scene: o.scene ?? S2, last: o.last ?? null, recent: o.recent ?? [], debatable: !!o.d });
// Keep in step with app/main/tests/fixtures/floor-intent-cases.ts (the same 54 cases, replayed by the floor tests).
const cases = [
  // simple
  C('simple', 'Sage, what time is it?', 'sage', 'answer', 'none'),
  C('simple', 'Hey Echo, how are you?', 'echo', 'answer', 'none'),
  C('simple', "What's the weather like?", 'sage', 'answer', 'none', { last: 'Sage' }),
  C('simple', "What's the weather like?", 'echo', 'answer', 'none'),
  C('simple', 'You two, introduce yourselves.', 'everyone', 'answer', 'none'),
  C('simple', 'Echo, talk to Sage.', 'echo', 'converse', 'sage'),
  C('simple', 'Sage, ask Echo what time it is.', 'sage', 'relay', 'echo'),
  C('simple', 'Echo, tell me a joke.', 'echo', 'answer', 'none'),
  C('simple', 'Sage, how was your day?', 'sage', 'answer', 'none'),
  C('simple', 'Thanks, that was really helpful.', 'sage', 'answer', 'none', { last: 'Sage' }),
  C('simple', 'Hello everybody.', 'everyone', 'answer', 'none'),
  C('simple', 'Sage, go and talk to Echo.', 'sage', 'converse', 'echo'),
  C('simple', 'Echo, ask Sage if she wants some tea.', 'echo', 'relay', 'sage'),
  C('simple', 'Both of you, say hello.', 'everyone', 'answer', 'none'),
  C('simple', "Rex, what's your favourite colour?", 'rex', 'answer', 'none', { scene: S3 }),
  C('simple', 'Hi Sage!', 'sage', 'answer', 'none', { last: 'Echo' }),
  // medium
  C('medium', 'Can you strike up a conversation with Sage, please?', 'echo', 'converse', 'sage', { last: 'Echo' }),
  C('medium', 'Can you strike up a conversation with Echo, please?', 'sage', 'converse', 'echo', { last: 'Sage' }),
  C('medium', "I'd like you to talk to Sage.", 'echo', 'converse', 'sage', { last: 'Echo' }),
  C('medium', 'Hey Echo, talk to Sage', 'echo', 'converse', 'sage'),
  C('medium', 'I want you to take your avatar and sit on the chair.', 'echo', 'answer', 'none', { last: 'Echo' }),
  C('medium', 'Echo, what do you think of Sage?', 'echo', 'answer', 'none'),
  C('medium', 'Tell me about Sage.', 'echo', 'answer', 'none', { last: 'Echo' }),
  C('medium', 'Sage, talk to me.', 'sage', 'answer', 'none'),
  C('medium', 'I want to talk to Sage.', 'sage', 'answer', 'none', { last: 'Echo' }),
  C('medium', 'Could one of you find out from Sage what she had planned today?', 'echo', 'relay', 'sage', { last: 'Echo' }),
  C('medium', "Why don't you two have a chat about the weekend.", 'echo', 'converse', 'sage', { d: true }),
  C('medium', 'Everyone, what do you think?', 'everyone', 'answer', 'none'),
  C('medium', 'Sage, could you have a chat with Echo?', 'sage', 'converse', 'echo'),
  C('medium', "Echo, go and ask Sage what she's cooking.", 'echo', 'relay', 'sage'),
  C('medium', 'Tell Sage I said hello.', 'echo', 'relay', 'sage', { last: 'Echo' }),
  C('medium', 'What does Sage think about this?', 'echo', ['answer', 'relay'], ['none', 'sage'], { last: 'Echo', d: true }),
  C('medium', 'Rex, say something to Echo.', 'rex', 'converse', 'echo', { scene: S3 }),
  C('medium', 'Let Rex and Sage talk for a while.', ['rex', 'sage'], 'converse', ['rex', 'sage'], { scene: S3, d: true }),
  // convoluted
  C('convoluted', "Echo, I don't want to hear from Sage right now, just tell me the time.", 'echo', 'answer', 'none'),
  C('convoluted', 'Not you, Echo. Sage, what do you think?', 'sage', 'answer', 'none'),
  C('convoluted', 'Sage, when you get a second, see if Echo remembers where I left my keys and let me know.', 'sage', 'relay', 'echo'),
  C('convoluted', "I was telling Sage earlier about my trip. Anyway Echo, what's on my calendar?", 'echo', 'answer', 'none'),
  C('convoluted', "Echo, would you mind getting Sage's opinion on the sofa colour and then telling me what you both decide?", 'echo', ['relay', 'converse'], 'sage'),
  C('convoluted', 'My friend Sage from work is coming over later.', 'echo', 'answer', 'none', { last: 'Echo', d: true }),
  C('convoluted', 'Rex, can you get those two to stop arguing?', 'rex', ['answer', 'converse'], ['none', 'echo', 'sage'], { scene: S3, d: true }),
  C('convoluted', 'Sage, tell Echo she should talk to Rex.', 'sage', 'relay', 'echo', { scene: S3 }),
  C('convoluted', "Could somebody who isn't Echo answer this one: what's two plus two?", 'sage', 'answer', 'none'),
  C('convoluted', 'Go on then, the pair of you, argue it out.', ['echo', 'sage'], 'converse', ['echo', 'sage'], { d: true }),
  C('convoluted', 'Ask her yourself.', 'echo', ['converse', 'relay'], 'sage', { last: 'Echo', recent: [['Echo', 'I wonder what Sage thinks about that.']] }),
  C('convoluted', "I'd love to hear the two of you discuss whether cats are better than dogs. Sage, you start.", 'sage', 'converse', 'echo'),
  C('convoluted', 'hey echo um can you like talk to sage for a bit', 'echo', 'converse', 'sage'),
  C('convoluted', 'sage can you uh strike up a chat with echo', 'sage', 'converse', 'echo'),
  C('convoluted', 'echo talk to sage', 'echo', 'converse', 'sage'),
  C('convoluted', 'Hey Eko, have a word with Sage.', 'echo', 'converse', 'sage'),
  C('convoluted', "Echo, stop talking to Sage and talk to me.", 'echo', 'answer', 'none'),
  C('convoluted', "Rex, forget Echo for a second, what's the capital of France?", 'rex', 'answer', 'none', { scene: S3 }),
  C('convoluted', "Sage, I'm not asking Echo, I'm asking you: will it rain?", 'sage', 'answer', 'none'),
  C('convoluted', 'Tell her I said thanks.', 'sage', 'relay', 'echo', { last: 'Sage', recent: [['Sage', 'Echo found the recipe for you.']], d: true }),
];

const lower = (s) => s.toLowerCase();
const accepted = (v) => (Array.isArray(v) ? v : [v]);
const show = (v) => accepted(v).join('|');
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] : 0);
const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1)}~`);
const names = (c) => c.scene.map(lower);
const errText = (e) => (e instanceof Error ? e.message : String(e));

/** Judge one field: `v` is the model's value, `p` its probability (1 when the back end gives none). */
const judge = (c, field, v, p = 1) => ({ v, p, ok: v !== undefined && accepted(c[field]).includes(v), sure: p >= CONFIDENT });

/** A reply value as a lower-case trimmed string; undefined when absent. Unknown values are kept (and fail). */
const clean = (v) => (v === undefined || v === null ? undefined : lower(String(v).trim()));
/** An "other avatar" value: null, missing or empty means none. */
const orNone = (v) => {
  const s = clean(v);
  return s === undefined || s === '' ? 'none' : s;
};

async function post(url, body) {
  const started = performance.now();
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(CALL_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return { json: await response.json(), ms: Math.round(performance.now() - started) };
}

// ---- Quick decisions server (Laya) ----
// Wire format (services/laya is only a pin of the `laya[serve]` package; the contract is in
// services/laya/README.md and app/main/src/decide/system-one.ts): POST /v1/systemone
// {model, state, questions} -> {answers: {<key>: {probabilities: {<option>: p}} | {noul: p} | {score: n}}}.
// The app reads answers[key].probabilities[option] for every option key of the question (missing ->
// 0, clamped to 0..1, not renormalised) and answers[key].noul; top() below reads the same field.
let firstLaya = null;
async function layaCall(body) {
  const result = await post(`${layaBase}/v1/systemone`, body);
  firstLaya ??= { body, json: result.json };
  return result;
}

function layaRequest(c) {
  const options = names(c);
  const speaker = { everyone: 'Every avatar should answer in turn.' };
  const target = { none: 'No other avatar; the reply is for Kevin.' };
  const speakerCriteria = {};
  const targetCriteria = {};
  for (const name of c.scene) speakerCriteria[lower(name)] = `${name} should speak next.`;
  for (const name of c.scene) targetCriteria[lower(name)] = `${name} is the other avatar.`;
  const state = {
    scene: c.scene.map((n, i) => (i === 0 ? `${n} (host)` : n)),
    lastSpokeWith: c.last,
    recent: c.recent.map(([who, text]) => ({ speaker: who, text })),
    line: { speaker: 'Kevin', text: c.text },
  };
  return {
    options,
    body: {
      model: layaModel,
      state,
      questions: {
        speaker: { type: 'choice', instructions: "Who should speak next, in reply to Kevin's last line?", criteria: { ...speakerCriteria, ...speaker } },
        intent: {
          type: 'choice',
          instructions: 'What does Kevin want the one who speaks next to do?',
          criteria: { answer: 'Reply to Kevin himself.', converse: 'Start talking with another avatar in the room.', relay: 'Ask or tell another avatar something on Kevin\'s behalf.' },
        },
        target: { type: 'choice', instructions: 'Which other avatar is Kevin asking them to talk to or pass something on to?', criteria: { ...targetCriteria, ...target } },
      },
    },
  };
}

/** The app's current addressee question (system-one-floor.ts), with no Kevin option. */
function currentRequest(c) {
  const criteria = {};
  for (const name of c.scene) criteria[lower(name)] = `${name} is the one being spoken to.`;
  criteria.everyone = 'Everyone in the room is being spoken to, or no one in particular.';
  return {
    model: layaModel,
    state: { recent: c.recent.slice(-4).map(([who, text]) => ({ speaker: who, text })), line: { speaker: 'Kevin', text: c.text } },
    questions: { who: { type: 'choice', instructions: 'Who is Kevin speaking to in their last line?', criteria } },
  };
}

const top = (answer) => {
  const sorted = Object.entries(answer?.probabilities ?? {}).sort((a, b) => b[1] - a[1]);
  return sorted.length ? { v: sorted[0][0], p: Number(sorted[0][1]) } : { v: undefined, p: 0 };
};

async function askLaya(c) {
  const r = { case: c };
  try {
    const { body } = layaRequest(c);
    const main = await layaCall(body);
    r.ms = main.ms;
    r.raw = main.json;
    for (const f of FIELDS) {
      const t = top(main.json.answers?.[f]);
      r[f] = judge(c, f, t.v, t.p);
    }
    const cur = await layaCall(currentRequest(c));
    const t = top(cur.json.answers?.who);
    r.current = judge(c, 'speaker', t.v, t.p);
    r.currentMs = cur.ms;
  } catch (error) {
    r.error = errText(error);
  }
  return r;
}

// ---- Laya probes: does any request shape move the answers off uniform? ----
const PROBE_TEXTS = [
  'Sage, what time is it?', 'Echo, talk to Sage.', 'Sage, ask Echo what time it is.', 'Hello everybody.',
  'Can you strike up a conversation with Sage, please?', 'Hey Echo, talk to Sage', 'Echo, what do you think of Sage?', 'Tell Sage I said hello.',
  'Not you, Echo. Sage, what do you think?', 'Sage, tell Echo she should talk to Rex.', 'Echo, stop talking to Sage and talk to me.', 'echo talk to sage',
];
const probeCases = () => PROBE_TEXTS.map((t) => cases.find((c) => c.text === t)).filter(Boolean);

const capital = (s) => s[0].toUpperCase() + s.slice(1);
const roomText = (c) => c.scene.map((n, i) => (i === 0 ? `${n} (host)` : n)).join(', ');
const conversationLines = (c) => [...c.recent.map(([w, t]) => `${w}: ${t}`), `Kevin: ${c.text}`];
const flatState = (c) => ({ conversation: conversationLines(c).join('\n'), room: roomText(c), last_spoke_with: c.last ?? 'nobody' });

function probeBodies(shape, c) {
  const qs = layaRequest(c).body.questions;
  const flat = flatState(c);
  const mk = (state, questions) => ({ model: layaModel, state, questions });
  if (shape === 'p0') return [mk(layaRequest(c).body.state, qs)];
  if (shape === 'p1') return [mk(flat, qs)];
  if (shape === 'p2') return Object.entries(qs).map(([k, q]) => mk(flat, { [k]: q }));
  if (shape === 'p3') {
    const questions = {};
    for (const n of c.scene) questions[`to_${lower(n)}`] = { type: 'noul', instructions: `Is Kevin speaking to ${n} in this line?` };
    for (const n of c.scene) questions[`go_${lower(n)}`] = { type: 'noul', instructions: `Does Kevin want ${n} to go and talk with another avatar?` };
    return [mk(flat, questions)];
  }
  // p4: the style of scripts/laya-check.mjs and the app's own addressee question: capitalised
  // option keys, "<Name> is the one being spoken to.", recent as "Name: text" strings.
  const criteria = {};
  for (const n of c.scene) criteria[n] = `${n} is the one being spoken to.`;
  criteria.everyone = 'Everyone in the room is being spoken to, or no one in particular.';
  const state = { ...(c.recent.length ? { recent: c.recent.map(([w, t]) => `${w}: ${t}`) } : {}), line: { speaker: 'Kevin', text: c.text } };
  return [mk(state, { who: { type: 'choice', instructions: 'Who is Kevin speaking to in their last line?', criteria } })];
}

/** Every answered question of a probe: choice -> full vector, noul -> probability of yes. */
function collect(body, json, out) {
  for (const [key, q] of Object.entries(body.questions)) {
    const a = json.answers?.[key];
    if (q.type === 'choice') out.push({ key, vec: a?.probabilities && typeof a.probabilities === 'object' ? a.probabilities : null, rawA: a });
    else out.push({ key, yes: typeof a?.noul === 'number' ? a.noul : null, rawA: a });
  }
}

async function probeShape(shape, c) {
  const res = { shape, qs: [], ms: [] };
  try {
    for (const body of probeBodies(shape, c)) {
      const { json, ms } = await layaCall(body);
      res.ms.push(ms);
      collect(body, json, res.qs);
    }
  } catch (error) {
    res.error = errText(error);
  }
  return res;
}

const vecText = (vec) => (vec ? Object.entries(vec).sort((a, b) => b[1] - a[1]).map(([k, p]) => `${k} ${Number(p).toFixed(2)}`).join(' ') : '(no probabilities)');
const topOf = (vec) => (vec ? Object.entries(vec).sort((a, b) => b[1] - a[1])[0] : undefined);

/** Right/wrong for one probe result, where the shape allows it. */
function probeGrade(res, c) {
  const g = { speaker: undefined, intent: undefined, target: undefined };
  if (res.error) return g;
  const choice = (key) => topOf(res.qs.find((q) => q.key === key)?.vec)?.[0];
  if (['p0', 'p1', 'p2'].includes(res.shape)) for (const f of FIELDS) g[f] = choice(f) === undefined ? false : accepted(c[f]).includes(lower(choice(f)));
  if (res.shape === 'p4') g.speaker = choice('who') === undefined ? false : accepted(c.speaker).includes(lower(choice('who')));
  if (res.shape === 'p3') {
    const yes = c.scene.map((n) => [lower(n), res.qs.find((q) => q.key === `to_${lower(n)}`)?.yes ?? 0]).sort((a, b) => b[1] - a[1]);
    const pick = yes[0][1] < 0.5 ? 'everyone' : yes[0][0];
    g.speaker = accepted(c.speaker).includes(pick);
  }
  return g;
}

const SHAPES = [
  ['p0', 'current shape (round 1)'],
  ['p1', 'flat text state, same three questions'],
  ['p2', 'flat text state, one question per call'],
  ['p3', 'yes/no questions, flat state'],
  ['p4', 'documented style (capitalised keys, "Name: text" recent), who question'],
];

function probeLine(res) {
  if (res.error) return `${res.shape} error: ${clip(res.error, 90)}`;
  const parts = res.qs.map((q) => (q.vec !== undefined && 'vec' in q ? `${q.key}[${vecText(q.vec)}]` : `${q.key}=${q.yes === null ? '?' : q.yes.toFixed(2)}`));
  return `${res.shape} ${parts.join(' ')}  (${median(res.ms)} ms${res.ms.length > 1 ? ` x${res.ms.length}` : ''})`;
}

async function sanityChecks() {
  const out = [];
  const questions = {
    emergency: { type: 'noul', instructions: 'Is this an emergency?' },
    sky: { type: 'choice', instructions: 'What colour is the sky on a clear day?', criteria: { blue: 'The sky is blue.', green: 'The sky is green.', red: 'The sky is red.' } },
  };
  for (const [label, state] of [['state.line as a string', { line: 'The kitchen is on fire!' }], ['state.line as {speaker, text}', { line: { speaker: 'Kevin', text: 'The kitchen is on fire!' } }]]) {
    try {
      const { json, ms } = await layaCall({ model: layaModel, state, questions });
      out.push(`${label} (${ms} ms): ${JSON.stringify(json)}`);
    } catch (error) {
      out.push(`${label}: error ${clip(errText(error), 120)}`);
    }
  }
  return out;
}

async function runProbes() {
  const rows = [];
  for (const c of probeCases()) {
    const shapes = [];
    for (const [shape] of SHAPES) shapes.push(await probeShape(shape, c));
    rows.push({ case: c, shapes, grades: shapes.map((s) => probeGrade(s, c)) });
  }
  const sanity = await sanityChecks();
  return { rows, sanity };
}

function probeSummary(rows) {
  return SHAPES.map(([shape, label]) => {
    const all = rows.map((r) => ({ res: r.shapes.find((s) => s.shape === shape), g: r.grades[SHAPES.findIndex(([s]) => s === shape)] }));
    const ok = all.filter((x) => !x.res.error);
    const n = ok.length;
    const cnt = (f) => (ok.some((x) => x.g[f] !== undefined) ? `${ok.filter((x) => x.g[f]).length}/${n}` : '-');
    const all3 = ['p0', 'p1', 'p2'].includes(shape) ? `${ok.filter((x) => FIELDS.every((f) => x.g[f])).length}/${n}` : '-';
    const tops = ok.flatMap((x) => x.res.qs.map((q) => (q.vec ? topOf(q.vec)?.[1] : q.yes))).filter((v) => typeof v === 'number');
    const mean = tops.length ? (tops.reduce((a, b) => a + b, 0) / tops.length).toFixed(2) : '-';
    const spread = tops.length ? `${Math.min(...tops).toFixed(2)}-${Math.max(...tops).toFixed(2)}` : '-';
    return [shape, label, cnt('speaker'), cnt('intent'), cnt('target'), all3, mean, spread, String(median(ok.flatMap((x) => x.res.ms)))];
  });
}

// ---- Chat model ----
const idList = (c) => names(c);
const ctx = (c) => `${c.scene.map((n, i) => (i === 0 ? `${n} (host)` : n)).join(', ')}. Kevin last spoke with ${c.last ?? 'nobody yet'}.`;

function promptBaseline(c) {
  const host = c.scene[0];
  const people = c.scene.join(', ');
  return [
    `Kevin is a person in a room with these avatars: ${people}. ${host} is the host. Kevin last spoke with ${c.last ?? 'nobody yet'}.`,
    'From Kevin\'s last line alone, decide three things:',
    `"speaker": who speaks next, one of ${idList(c).join(', ')}, or everyone (every avatar answers in turn).`,
    '"intent": answer (the speaker replies to Kevin), converse (the speaker starts a conversation with another avatar), or relay (the speaker passes a question or message on to another avatar, and/or reports back).',
    '"target": the other avatar involved in converse or relay, else none.',
    'A name in the line can be the one spoken to, or the one to be talked to or about. "Hey <name>" calls that avatar. With no name, the one Kevin last spoke with answers, otherwise the host.',
    'Reply with only a JSON object: {"speaker": "...", "intent": "...", "target": "..."}',
  ].join('\n');
}

const REFRAMED_RULES = [
  'Kevin is talking to avatars in a room. Read his last line and fill in three fields.',
  '"addressed": the avatar Kevin is speaking TO in this line, the one who should act on it. It is NOT the avatar he wants them to go and talk to, ask, or talk about. Use "everyone" when he speaks to all of them. Use "unclear" when the line names no one as the listener (then the app picks).',
  '"wants": "answer" = just reply to Kevin; "converse" = go and have a conversation with another avatar; "relay" = ask or tell another avatar something for Kevin.',
  '"other": that other avatar when wants is converse or relay, else "none".',
];
const reframedAnswer = '{"addressed": "...", "wants": "...", "other": "..."}';
const reframedValues = (c) => [
  `Allowed values, lower case: addressed = ${[...idList(c), 'everyone', 'unclear'].join(' | ')}; wants = answer | converse | relay; other = ${[...idList(c), 'none'].join(' | ')}.`,
  `Reply with only a JSON object: ${reframedAnswer}`,
];

function promptReframed(c) {
  return [REFRAMED_RULES[0], `The room: ${ctx(c)}`, ...REFRAMED_RULES.slice(1), ...reframedValues(c)].join('\n');
}

/** Worked examples in a made-up room; none of them is a test sentence. */
const EXAMPLES = [
  ['Tobin, did you sleep well?', 'tobin', 'answer', 'none'],
  ['Is it cold out?', 'unclear', 'answer', 'none'],
  ['Mira, go and chat with Tobin for a bit.', 'mira', 'converse', 'tobin'],
  ['Why not have a natter with Tobin?', 'unclear', 'converse', 'tobin'],
  ['Tobin, find out if Mira is hungry.', 'tobin', 'relay', 'mira'],
  ['Mira, is Tobin always this grumpy?', 'mira', 'answer', 'none'],
];

function promptExamples(c) {
  return [
    REFRAMED_RULES[0],
    ...REFRAMED_RULES.slice(1),
    'Examples from another room (avatars: Mira (host), Tobin):',
    ...EXAMPLES.map(([text, a, w, o]) => `Kevin: "${text}" -> {"addressed": "${a}", "wants": "${w}", "other": "${o}"}`),
    `Now the actual room: ${ctx(c)}`,
    ...reframedValues(c),
  ].join('\n');
}

const enumProp = (values) => ({ type: 'string', enum: values });
const schemaOf = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const schemaBaseline = (c) => schemaOf({ speaker: enumProp([...idList(c), 'everyone']), intent: enumProp(['answer', 'converse', 'relay']), target: enumProp([...idList(c), 'none']) });
const schemaReframed = (c) => schemaOf({ addressed: enumProp([...idList(c), 'everyone', 'unclear']), wants: enumProp(['answer', 'converse', 'relay']), other: enumProp([...idList(c), 'none']) });

const readBaseline = (o) => ({ speaker: clean(o.speaker), intent: clean(o.intent), target: orNone(o.target) });

/** Variants c and d: the fallback for "unclear" is done here. */
function readReframed(o, c) {
  const other = orNone(o.other);
  const ids = idList(c);
  let speaker = clean(o.addressed);
  if (speaker === 'unclear') {
    const last = c.last ? lower(c.last) : null;
    if (last && ids.includes(last) && last !== other) speaker = last;
    else if (ids[0] !== other) speaker = ids[0];
    else speaker = ids.find((id) => id !== other) ?? ids[0];
  }
  return { speaker, intent: clean(o.wants), target: other };
}

const VARIANTS = {
  a: { label: 'baseline', prompt: promptBaseline, schema: null, read: readBaseline },
  b: { label: 'constrained', prompt: promptBaseline, schema: schemaBaseline, read: readBaseline },
  c: { label: 'reframed + constrained', prompt: promptReframed, schema: schemaReframed, read: readReframed },
  d: { label: 'reframed + constrained + examples', prompt: promptExamples, schema: schemaReframed, read: readReframed },
};

function parseJson(text) {
  const m = /\{[\s\S]*?\}/.exec(text ?? '');
  if (!m) throw new Error(`no JSON in reply: ${clip(String(text), 80)}`);
  return JSON.parse(m[0]);
}

function chatBody(model, c, variant, format) {
  return {
    model,
    messages: [{ role: 'system', content: variant.prompt(c) }, { role: 'user', content: conversationLines(c).join('\n') }],
    temperature: 0,
    max_tokens: 60,
    stream: false,
    // As the app's own small calls do (local-llm-client.ts): answer directly instead of thinking first.
    chat_template_kwargs: { enable_thinking: false },
    ...(format ? { response_format: format } : {}),
  };
}

async function askLlm(c, model, id) {
  const variant = VARIANTS[id];
  const r = { case: c };
  try {
    let result;
    if (variant.schema) {
      try {
        result = await post(`${llmBase}/v1/chat/completions`, chatBody(model, c, variant, { type: 'json_schema', json_schema: { name: 'floor_intent', strict: true, schema: variant.schema(c) } }));
      } catch (error) {
        if (!/^HTTP 400/.test(errText(error))) throw error;
        r.downgraded = true;
        result = await post(`${llmBase}/v1/chat/completions`, chatBody(model, c, variant, { type: 'json_object' }));
      }
    } else result = await post(`${llmBase}/v1/chat/completions`, chatBody(model, c, variant, null));
    r.ms = result.ms;
    r.raw = result.json;
    r.reply = result.json.choices?.[0]?.message?.content;
    const got = variant.read(parseJson(r.reply), c);
    for (const f of FIELDS) r[f] = judge(c, f, got[f]);
  } catch (error) {
    r.error = errText(error);
  }
  return r;
}

// ---- Report ----
const mark = (f) => (f ? (f.ok ? 'ok' : 'NO') : '--');
const cell = (r, f, withP) => {
  const x = r[f];
  if (!x) return `${show(r.case[f])} > ?`;
  return `${show(r.case[f])} > ${x.v ?? '?'} ${withP ? `${x.p.toFixed(2)} ` : ''}${mark(x)}`;
};

function rowsFor(name, results) {
  const laya = name === 'laya';
  const head = ['grade', 'line', 'speaker', 'intent', 'target', ...(laya ? ['current'] : []), 'ms'];
  const rows = results.map((r) => {
    const c = r.case;
    const base = [c.grade + (c.debatable ? '*' : ''), clip(c.text, 60)];
    if (r.error) return [...base, `error: ${clip(r.error, 70)}`, '', '', ...(laya ? [''] : []), ''];
    return [...base, cell(r, 'speaker', laya), cell(r, 'intent', laya), cell(r, 'target', laya), ...(laya ? [`${r.current.v ?? '?'} ${r.current.p.toFixed(2)} ${mark(r.current)}`] : []), String(r.ms)];
  });
  return { head, rows };
}

const pct = (a, n) => (n ? `${Math.round((100 * a) / n)}% (${a}/${n})` : '-');
/** Rows of the comparison table for one result set: one per grade plus all. */
function gradeRows(label, results) {
  return [...GRADES, 'all'].map((grade) => {
    const rs = results.filter((r) => (grade === 'all' || r.case.grade === grade) && !r.case.debatable);
    const n = rs.length;
    const each = (f) => rs.filter((r) => r[f]?.ok).length;
    const ms = rs.filter((r) => r.ms !== undefined).map((r) => r.ms);
    return [label, grade, String(n), ...FIELDS.map((f) => pct(each(f), n)), pct(rs.filter((r) => FIELDS.every((f) => r[f]?.ok)).length, n), ms.length ? String(median(ms)) : '-'];
  });
}
const failedOf = (results) => results.filter((r) => !r.case.debatable && (r.error || !FIELDS.every((f) => r[f]?.ok)));
const failLine = (r) => `[${r.case.grade}] ${r.case.text}  ${r.error ? `(${clip(r.error, 90)})` : FIELDS.filter((f) => !r[f]?.ok).map((f) => `${f}: want ${show(r.case[f])} got ${r[f]?.v ?? '?'}`).join('; ')}`;

const pad = (rows, widths) => rows.map((row) => row.map((v, i) => String(v).padEnd(widths[i])).join('  ').trimEnd());
function text(head, rows) {
  const all = [head, ...rows];
  const widths = head.map((_, i) => Math.max(...all.map((r) => String(r[i] ?? '').length)));
  return pad(all, widths).join('\n');
}
const md = (head, rows) => [head, head.map(() => '---'), ...rows].map((r) => `| ${r.map((v) => String(v).replace(/\|/g, '/')).join(' | ')} |`).join('\n');

/** `fmt` is 'text' (console) or 'md'. The Markdown report has no per-case tables. */
function render(fmt, data) {
  const o = [];
  const M = fmt === 'md';
  const H = (t) => o.push(M ? `\n## ${t}\n` : `\n== ${t} ==\n`);
  const T = (head, rows) => o.push(M ? md(head, rows) : text(head, rows));
  const list = (lines) => o.push(M ? lines.map((l) => `- ${l}`).join('\n') : lines.map((l) => `  ${l}`).join('\n'));
  const code = (lines) => o.push(M ? ['```', ...lines, '```'].join('\n') : lines.map((l) => `  ${l}`).join('\n'));
  if (M) o.push('# Floor intent check', '', 'Debatable cases (marked * in the case list) are not scored. "all three" needs speaker, intent and target right.');
  const sets = [...data.variants.map((v) => ({ label: `${v.id} ${VARIANTS[v.id].label}`, results: v.results, v })), ...(data.laya ? [{ label: 'laya (main)', results: data.laya, laya: true }] : [])];
  if (sets.length) {
    H('Comparison (debatable cases excluded; ms = median)');
    T(['variant', 'grade', 'n', 'speaker', 'intent', 'target', 'all three', 'ms'], sets.flatMap((s) => gradeRows(s.label, s.results)));
    for (const s of sets) {
      const down = s.v ? s.results.filter((r) => r.downgraded).length : 0;
      if (down) o.push(`${M ? '- ' : '* '}${s.label}: the server rejected json_schema (HTTP 400) on ${down} of ${s.results.length} requests; those were retried with json_object.`);
    }
    H('Failed cases (want vs got)');
    for (const s of sets) {
      const failed = failedOf(s.results);
      o.push(M ? `### ${s.label}: ${failed.length} failed\n` : `-- ${s.label}: ${failed.length} failed`);
      if (failed.length) list(failed.map(failLine));
    }
  }
  if (!M && verbose) for (const s of sets) {
    H(`Per case: ${s.label}`);
    const t = rowsFor(s.laya ? 'laya' : 'llm', s.results);
    T(t.head, t.rows);
  }
  if (data.probes) {
    const p = data.probes;
    H(`Laya probes (${p.rows.length} cases, model ${layaModel})`);
    T(['shape', 'what', 'speaker', 'intent', 'target', 'all three', 'mean top p', 'top p range', 'ms'], probeSummary(p.rows));
    o.push('\nFull vectors per case (truth in brackets: speaker/intent/target):');
    const lines = [];
    for (const r of p.rows) {
      lines.push(`[${r.case.grade}] ${r.case.text}  (${show(r.case.speaker)}/${show(r.case.intent)}/${show(r.case.target)})`);
      for (const s of r.shapes) lines.push(`  ${probeLine(s)}`);
    }
    code(lines);
    o.push('\nSanity questions in the documented style (raw responses):');
    code(p.sanity);
    if (firstLaya) {
      o.push('\nFirst Laya call, raw response, read as answers.<question>.probabilities (choice) / .noul (yes-no), the same fields as app/main/src/decide/system-one.ts readAnswer:');
      code([`request: ${JSON.stringify(firstLaya.body)}`, `response: ${JSON.stringify(firstLaya.json)}`]);
    }
  }
  return o.join('\n');
}

async function probe(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    return { unreachable: errText(error) };
  }
}

async function main() {
  const data = { variants: [], laya: null, probes: null };
  let reachable = 0;
  if (only !== 'llm') {
    const health = await probe(`${layaBase}/health`);
    if (health.unreachable) console.log(`Laya at ${layaBase}: skipped (${health.unreachable})`);
    else {
      reachable += 1;
      console.log(`Laya at ${layaBase}: ${JSON.stringify(health)}, model ${layaModel}`);
      if (layaMain) {
        data.laya = [];
        for (const c of cases) data.laya.push(await askLaya(c));
      }
      if (layaProbes) data.probes = await runProbes();
    }
  }
  if (only !== 'laya') {
    const models = await probe(`${llmBase}/v1/models`);
    const model = process.env.LLM_MODEL || models.data?.[0]?.id;
    if (models.unreachable) console.log(`Chat model at ${llmBase}: skipped (${models.unreachable})`);
    else if (!model) console.log(`Chat model at ${llmBase}: skipped (no model listed; set LLM_MODEL)`);
    else {
      reachable += 1;
      console.log(`Chat model at ${llmBase}: ${model}, variants ${variantIds.join(',')}`);
      for (const id of variantIds) {
        const results = [];
        for (const c of cases) results.push(await askLlm(c, model, id));
        data.variants.push({ id, model, results });
      }
    }
  }
  if (reachable === 0) {
    console.error('Neither back end answered; nothing to check.');
    process.exit(1);
  }
  console.log(render('text', data));
  if (mdPath) writeFileSync(mdPath, `${render('md', data)}\n`);
  if (jsonPath) {
    const full = { variants: data.variants, laya: data.laya, probes: data.probes, firstLayaCall: firstLaya };
    writeFileSync(jsonPath, JSON.stringify(full, null, 2));
  }
}

void main();
