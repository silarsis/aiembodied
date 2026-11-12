#!/usr/bin/env node
/**
 * An experiment: can a decision model work out, from Kevin's sentence alone, who should speak next
 * and what Kevin wants, well enough to replace the hand-written rules in
 * app/main/src/floor/floor-manager.ts (routePerson)? Every case is put to two back ends:
 *  - the Quick decisions server (Laya): three choice questions in one call, plus the app's
 *    current "who is Kevin speaking to" question for comparison;
 *  - a chat model on an OpenAI-compatible server, answering with one small JSON object.
 *
 *   pnpm floor:check
 *   pnpm floor:check -- --only laya --json out.json --md report.md
 *   LAYA_URL=http://other:8197 LLM_URL=http://other:1234 LLM_MODEL=name pnpm floor:check
 *
 * A back end that does not answer its health probe is skipped. Exits 1 only when both are down.
 */
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = flag('--only');
const jsonPath = flag('--json');
const mdPath = flag('--md');
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

/** Judge one field: `v` is the model's value, `p` its probability (1 when the back end gives none). */
const judge = (c, field, v, p = 1) => ({ v, p, ok: v !== undefined && accepted(c[field]).includes(v), sure: p >= CONFIDENT });

async function post(url, body) {
  const started = performance.now();
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(CALL_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return { json: await response.json(), ms: Math.round(performance.now() - started) };
}

// ---- Quick decisions server (Laya) ----
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
    const main = await post(`${layaBase}/v1/systemone`, body);
    r.ms = main.ms;
    r.raw = main.json;
    for (const f of FIELDS) {
      const t = top(main.json.answers?.[f]);
      r[f] = judge(c, f, t.v, t.p);
    }
    const cur = await post(`${layaBase}/v1/systemone`, currentRequest(c));
    const t = top(cur.json.answers?.who);
    r.current = judge(c, 'speaker', t.v, t.p);
    r.currentMs = cur.ms;
  } catch (error) {
    r.error = error instanceof Error ? error.message : String(error);
  }
  return r;
}

// ---- Chat model ----
function systemPrompt(c) {
  const host = c.scene[0];
  const people = c.scene.join(', ');
  return [
    `Kevin is a person in a room with these avatars: ${people}. ${host} is the host. Kevin last spoke with ${c.last ?? 'nobody yet'}.`,
    'From Kevin\'s last line alone, decide three things:',
    `"speaker": who speaks next, one of ${c.scene.map((n) => lower(n)).join(', ')}, or everyone (every avatar answers in turn).`,
    '"intent": answer (the speaker replies to Kevin), converse (the speaker starts a conversation with another avatar), or relay (the speaker passes a question or message on to another avatar, and/or reports back).',
    '"target": the other avatar involved in converse or relay, else none.',
    'A name in the line can be the one spoken to, or the one to be talked to or about. "Hey <name>" calls that avatar. With no name, the one Kevin last spoke with answers, otherwise the host.',
    'Reply with only a JSON object: {"speaker": "...", "intent": "...", "target": "..."}',
  ].join('\n');
}

function parseJson(text) {
  const m = /\{[\s\S]*?\}/.exec(text ?? '');
  if (!m) throw new Error(`no JSON in reply: ${clip(String(text), 80)}`);
  const o = JSON.parse(m[0]);
  const get = (k) => (typeof o[k] === 'string' ? lower(o[k].trim()) : undefined);
  return { speaker: get('speaker'), intent: get('intent'), target: get('target') };
}

async function askLlm(c, model) {
  const r = { case: c };
  try {
    const { json, ms } = await post(`${llmBase}/v1/chat/completions`, {
      model,
      messages: [{ role: 'system', content: systemPrompt(c) }, { role: 'user', content: `${[...c.recent.map(([w, t]) => `${w}: ${t}`), `Kevin: ${c.text}`].join('\n')}` }],
      temperature: 0,
      max_tokens: 60,
      stream: false,
      // As the app's own small calls do (local-llm-client.ts): answer directly instead of thinking first.
      chat_template_kwargs: { enable_thinking: false },
    });
    r.ms = ms;
    r.raw = json;
    const got = parseJson(json.choices?.[0]?.message?.content);
    for (const f of FIELDS) r[f] = judge(c, f, got[f]);
  } catch (error) {
    r.error = error instanceof Error ? error.message : String(error);
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

function summaryFor(name, results) {
  const laya = name === 'laya';
  const head = ['grade', 'n', 'speaker', 'intent', 'target', 'all three', ...(laya ? ['all three >=0.6', 'current question'] : [])];
  const pct = (a, n) => (n ? `${Math.round((100 * a) / n)}% (${a}/${n})` : '-');
  const rows = [];
  for (const grade of [...GRADES, 'all']) {
    const rs = results.filter((r) => (grade === 'all' || r.case.grade === grade) && !r.case.debatable);
    const n = rs.length;
    const each = (f) => rs.filter((r) => r[f]?.ok).length;
    const row = [grade, String(n), ...FIELDS.map((f) => pct(each(f), n)), pct(rs.filter((r) => FIELDS.every((f) => r[f]?.ok)).length, n)];
    if (laya) row.push(pct(rs.filter((r) => FIELDS.every((f) => r[f]?.ok && r[f].sure)).length, n), pct(rs.filter((r) => r.current?.ok).length, n));
    rows.push(row);
  }
  const ms = results.filter((r) => r.ms !== undefined).map((r) => r.ms);
  const failed = results.filter((r) => !r.case.debatable && (r.error || !FIELDS.every((f) => r[f]?.ok)));
  const extra = laya ? ' Top-1 regardless of probability in the field columns; "all three >=0.6" also needs every top option at 0.60 or more.' : '';
  return { head, rows, ms: ms.length ? `latency: median ${median(ms)} ms, max ${Math.max(...ms)} ms` : 'latency: no answers', failed, extra };
}

const pad = (rows, widths) => rows.map((row) => row.map((v, i) => String(v).padEnd(widths[i])).join('  ').trimEnd());
function text(head, rows) {
  const all = [head, ...rows];
  const widths = head.map((_, i) => Math.max(...all.map((r) => String(r[i] ?? '').length)));
  return pad(all, widths).join('\n');
}
const md = (head, rows) => [head, head.map(() => '---'), ...rows].map((r) => `| ${r.map((v) => String(v).replace(/\|/g, '/')).join(' | ')} |`).join('\n');

function report(sections) {
  const out = [];
  const mdOut = ['# Floor intent check', '', 'Rows marked * are debatable and not scored.', ''];
  for (const { title, name, results } of sections) {
    const t = rowsFor(name, results);
    const s = summaryFor(name, results);
    out.push(`\n== ${title} ==\n`, text(t.head, t.rows), '\nSummary (debatable excluded)', text(s.head, s.rows), s.ms + s.extra);
    out.push('Failed cases:', ...(s.failed.length ? s.failed.map((r) => `  [${r.case.grade}] ${r.case.text}  ${r.error ? `(${r.error})` : FIELDS.filter((f) => !r[f]?.ok).map((f) => `${f}: want ${show(r.case[f])} got ${r[f]?.v}`).join('; ')}`) : ['  none']));
    mdOut.push(`## ${title}`, '', md(t.head, t.rows), '', '### Summary', '', md(s.head, s.rows), '', s.ms + s.extra, '', '### Failed cases', '', ...(s.failed.length ? s.failed.map((r) => `- [${r.case.grade}] ${r.case.text} (${r.error ? r.error : FIELDS.filter((f) => !r[f]?.ok).map((f) => `${f}: want ${show(r.case[f])}, got ${r[f]?.v}`).join('; ')})`) : ['- none']), '');
  }
  console.log(out.join('\n'));
  if (mdPath) writeFileSync(mdPath, `${mdOut.join('\n')}\n`);
}

async function probe(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    return { unreachable: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  const sections = [];
  if (only !== 'llm') {
    const health = await probe(`${layaBase}/health`);
    if (health.unreachable) console.log(`Laya at ${layaBase}: skipped (${health.unreachable})`);
    else {
      console.log(`Laya at ${layaBase}: ${JSON.stringify(health)}, model ${layaModel}`);
      const results = [];
      for (const c of cases) results.push(await askLaya(c));
      sections.push({ title: 'Quick decisions server (Laya)', name: 'laya', results });
    }
  }
  if (only !== 'laya') {
    const models = await probe(`${llmBase}/v1/models`);
    const model = process.env.LLM_MODEL || models.data?.[0]?.id;
    if (models.unreachable) console.log(`Chat model at ${llmBase}: skipped (${models.unreachable})`);
    else if (!model) console.log(`Chat model at ${llmBase}: skipped (no model listed; set LLM_MODEL)`);
    else {
      console.log(`Chat model at ${llmBase}: ${model}`);
      const results = [];
      for (const c of cases) results.push(await askLlm(c, model));
      sections.push({ title: `Chat model (${model})`, name: 'llm', results });
    }
  }
  if (sections.length === 0) {
    console.error('Neither back end answered; nothing to check.');
    process.exit(1);
  }
  report(sections);
  if (jsonPath) writeFileSync(jsonPath, JSON.stringify(sections.map((s) => ({ ...s, results: s.results.map((r) => ({ ...r, case: r.case })) })), null, 2));
}

void main();
