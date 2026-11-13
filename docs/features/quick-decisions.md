# Quick decisions (System 1)

Quick decisions are fast, small judgements made by a local model instead of a chat model. The model is
[Laya](https://pypi.org/project/laya/) (Convai, Apache-2.0), run by `services/laya`. You give it a small state and a few
typed questions; it answers all of them in one pass, in tens of milliseconds on a CPU. It answers with probabilities,
never with text.

## Question types

| Type | You give | You get |
| --- | --- | --- |
| `choice` | `criteria`: option key -> what it means | `Record<option, probability>` |
| `score` | `criteria`: the scale, lowest level first | `0..1` |
| `noul` | a yes/no question | the probability of yes |

## The service

- `services/laya`, port **8197**, bound to `127.0.0.1`. Runs on the CPU by default (`LAYA_DEVICE=cpu`), which keeps the GPU free.
- Env: `LAYA_URL`, `LAYA_DEVICE`, `LAYA_MODELS` (default `english`), `LAYA_DEFAULT_MODEL`, `LAYA_VENV`, `LAYA_API_KEY`;
  `LAYA_ENABLED=0` or `LAYA_AUTOSTART=0` stops `pnpm dev:run` starting it. Details: `services/laya/README.md`.
- `GET /health` says what is loaded. `POST /v1/systemone` takes `{model, state, questions}`.
- The English checkpoint reads about 512 tokens. Keep `state` small: clip text, send only the last few lines.
- `pnpm laya:check` (optionally `-- http://host:8197`) sends a few known situations asked the way the app asks them ("lenha", two names, bids, home events, an arrival) and prints the answers, timings and any answer the app would not want. Run it after installing or changing the checkpoint.

## The route and the client

The model use is `decide` ("Quick decisions" in Models and servers, see [models-and-servers.md](models-and-servers.md)),
with backups like any other use. Code is in `app/main/src/decide/system-one.ts`.

```ts
const client = createSystemOne({ routing: manager.getConfig().models, keyFor: (id) => manager.getServerKey(id), logger });
if (client) {
  const { who, urgent } = await client.ask(
    { line: 'lenha, what are you up to?' },
    {
      who: { type: 'choice', instructions: 'Who is being spoken to?', criteria: { lenha: 'Lenha', echo: 'Echo' } },
      urgent: { type: 'noul', instructions: 'Is this urgent?' },
    },
    { signal, timeoutMs: 2000 },
  );
  // who: { lenha: 0.93, echo: 0.07 }, urgent: 0.04
}
```

- `createSystemOne` returns `null` when the route is off. Build the client per call so a changed route applies at once.
- `ask` rejects on any failure (no server, timeout, bad answer). The caller must handle that and fall back.

## Who uses it now

| Caller | Question | Threshold | If off, unsure or failing |
| --- | --- | --- | --- |
| Floor addressee check (`floor/system-one-floor.ts`) | `choice`: who an avatar's line is for | confidence from the floor controller | skipped, old name rules. Avatar chatter only; not asked when a name, relay or pair conversation already decides |
| Floor intent for Kevin's lines (`createSystemOneIntent`, same file) | three `choice` questions in the trained format: who he speaks to, what he wants, the other avatar | lowest top probability >= 0.8 | Idle thoughts chat model (`floor/intent-router.ts`), then an unsure quick answer, then the last partner or the host |
| Floor bids (same file) | one `score` per avatar: want to reply | none, bids are ranked | Idle thoughts model |
| Switchboard decide step (`switchboard/deliberate-system-one.ts`) | `choice` ignore / remember / say, `noul` urgent | top action >= 0.6; urgent needs `say` and >= 0.85, never under do-not-disturb | chat-model `deliberate`, then speak when idle (a Home Assistant change is remembered instead) |
| Proactive tick (`presence/proactive-tick.ts`) | `noul` act, `choice` what to say | act >= 0.75 and top choice >= 0.6 | do nothing (quiet is the safe default) |

### Kevin's lines are decided by the quick model

With two or more avatars, Kevin's lines go to the quick model first, then to the chat model (`floor/intent-router.ts`) when it is unsure, fails or times out. No code analyses his sentences. The prompt must be exactly the one in `services/laya/training/floor_prompt.py` (it is mirrored in `createSystemOneIntent` and checked by a test). This only works when the `decide` route's model is the fine-tuned floor checkpoint (for example `laya-floor-v1`, served through `LAYA_EXTRA_MODELS`): the stock checkpoint is near chance, so most lines fall through to the chat model. The addressee check above still serves avatar chatter only. See `services/switchboard/README.md`.

## When to use it

Use it for any fixed-option or yes/no judgement that must be fast: routing, triage, gating an expensive LLM call, "is this
worth a second look".

Do not use it for anything that writes text, or for judgements that need long context or tools.

Because it is overconfident:

1. Pick a threshold for each use and treat anything below it as "unsure".
2. Keep a fallback: a rule, or an LLM call, or doing nothing, whichever is safest for that feature.
3. Never let it alone approve anything risky (tool approvals, purchases, locks). It may decline or flag, not approve.
4. Keep the state small and put the facts it needs in it; it does not know anything else.
5. Log which engine decided so mistakes can be traced.
