# Agent Operating Guide

## Project Context
An embodied assistant: 3D VRM characters (Echo and others) who live in rooms on Kevin's screens, talk by voice, remember, plan their own time and use tools. It runs local-first on Kevin's Windows PC "bija" (Ryzen, 128 GB unified memory), with local LLM, speech, motion and image models, and other PCs or phones as extra rooms. It started as the "Embodied ChatGPT Assistant MVP" (`prd.md`, `archspec.md`, `plan.md`); those files are background now, not the spec.

Where to look:
- How a feature works now: its doc in [`docs/features/`](docs/features/README.md), or the service's `README.md` under `services/`.
- Why something is the way it is: [`docs/history.md`](docs/history.md), the dated decision log. Search it, don't read it whole.
- Record a new decision in the feature's doc (create one if needed), not in this file. This file holds rules and orientation only.

## Coding Rules (always apply)
These apply to every change, in the TypeScript app and the Python services. Where a rule can be checked by lint, tests or CI, it should be; these words are the fallback.

### Structure: deep modules, narrow interfaces
1. **Export only what callers need.** A module hides real work behind a few functions. Don't add thin pass-through wrappers or export helpers "in case".
2. **Imports go one way.** Higher layers import lower ones, never the reverse. If two modules import each other, or a child knows its parent, move the shared piece down a layer or have the parent call both.
3. **Keep state private.** Other modules call operations; they don't read or write another module's fields or internal objects. TypeScript: `private`/`#` fields, return copies or `readonly` views. Python: leading-underscore names are not touched from outside their module.
4. **Fix structural problems from first principles.** Work out what the layers should be and fix the design as a whole; don't shuffle code just to silence a warning. For a structural change, put a before/after sketch in the PR.

### Where code goes
5. **One feature, one folder.** Keep a feature's code together (`app/main/src/<feature>/`, `app/renderer/src/<feature>/`, its doc in `docs/features/`). Don't scatter one feature's helpers across the repo.
6. **Respect the Electron split.** Main-process code lives in `app/main`, UI in `app/renderer`. `app/main` never imports from `app/renderer`. The renderer reaches main only through the preload bridge; `import type` from `app/main` is fine, runtime imports are not. Code both sides run belongs in `app/main/src/shared/<feature>/`: pure TypeScript with no `electron`, no Node built-ins, no npm packages and no runtime imports from outside `shared/`. ESLint enforces this split.
7. **Make the right way the easy way.** Agents copy the nearest pattern. Follow the existing pattern; if it is wrong, fix it rather than adding a second one beside it.

### No slop
8. **Smallest change that does the job.** No drive-by renames, reformatting or refactors outside the task.
9. **No speculative code.** No unused parameters, options, config flags or abstractions "for later". No dead or commented-out code.
10. **Reuse before writing.** Search for an existing helper, type or service client first. Don't add a second one that does the same thing.
11. **Errors fail loudly.** No empty `catch`/`except`, no catch-log-and-carry-on unless carrying on is the intended behaviour, and no silent fallbacks (defaults that hide missing config or a failed call). Log the error's message and context, never `[object Object]`.
12. **Comments say why, not what.** Don't narrate the change ("added X", "now uses Y"), restate the code, or record PR history in comments.
13. **Types are not silenced.** No `any`, `as` casts or `!` to quiet the checker (ESLint already blocks most). Python public functions get type hints.

### Tests
14. **Test behaviour through the public interface.** Don't export internals just to test them, and don't mock the unit under test.
15. **Never weaken, skip or delete a test to get green.** Fix the code, or say plainly why the test is wrong.

### Formatting
16. TypeScript follows `prettier.config.cjs` (single quotes, semicolons, trailing commas, 100 columns; run `pnpm format`) and `eslint.config.js`. Python follows `ruff.toml` (`ruff check` and `ruff format`).

### React
17. **Effects live in named hooks.** Components don't call `useEffect`/`useLayoutEffect` directly; put each effect in a `useX` hook named for what it does, in the feature folder. Prefer no effect at all: derive values during render, and do event work in the handler. ESLint enforces this for new code; existing direct effects are listed in `app/renderer/eslint-suppressions.json`. Remove entries as you fix them (`pnpm --filter ./app/renderer exec eslint "src/**/*.{ts,tsx}" --prune-suppressions`).

### Keeping the rules alive
18. **Turn corrections into checks.** When the same kind of mistake is corrected twice, propose a lint rule, test or CI check that catches it, not just another line here.

## Development Workflow
1. Read the feature's doc in `docs/features/` (or the service README) and the code around the change.
2. Implement, with tests in the same package.
3. Run the checks below before committing.
4. Update the feature doc when behaviour or a decision changes.

## Development Startup
- `pnpm dev:run` (`scripts/run-dev.mjs`) builds the packages, rebuilds native modules (better-sqlite3, keytar) for Electron inside an isolated `.dev-home`, starts the local services this PC's model routes use (`scripts/local-services.mjs`; `--no-services` skips them) and launches Electron.
- `pnpm dev:satellite` runs this PC as a satellite room of bija; `pnpm satellite` is the daily (non-dev) satellite start.

## Testing & Verification
Run these from the repository root:
- `pnpm install` — dependencies resolve from a clean checkout.
- `pnpm format:check` — Prettier (`pnpm format` fixes it).
- `pnpm lint` — ESLint across packages.
- `pnpm typecheck` — TypeScript across packages.
- `pnpm test` — typecheck, then unit/integration tests. Main's tests run in groups in separate processes (`app/main/scripts/test-split.mjs`); add a new test folder to a group there.
- `pnpm test:coverage` — tests with coverage.
- `pnpm build` — production builds, as needed.
- `pnpm knip` — unused files, exports, types and dependencies (rules 1 and 9); only findings not in `knip-baseline.json` fail. `pnpm knip:update` rewrites the baseline; run it only to shrink it.
- `pnpm cycles` — runtime import cycles in `app/main/src` and `app/renderer/src` (rule 2; type-only imports are allowed).
- `pnpm size-ratchet` — recorded source files may not grow and no new file may pass 1500 lines (`file-size-ratchet.json`; `--update` lowers the numbers).
- `basedpyright` (`pip install basedpyright==1.40.2`) — Python types on each service's `src/` (rule 13), against `.basedpyright/baseline.json`; `basedpyright --writebaseline` after fixing errors.
- `ruff check services` and `ruff format --check services` — for Python changes (CI runs both). Each service also has its own tests (see its README).

Document any deviations or extra checks in the PR description.

## Architecture map
- **Electron main** (`app/main/src/`, entry `main.ts`): config and secrets (`config/`, Zod, keytar), SQLite store (`memory/`), model routing (`shared/config/model-routing.ts`: every model job goes to a server picked per use in Models and servers), the voice loop (`local-voice/`), avatars and the floor (`avatars/`, `floor/`), places, satellites and the room hub (`places/`, `satellite/`, `room-hub/`), stations and pursuits, agent time, MCP and tools, the wake word worker (`wake-word/`), and clients for every Python service.
- **Preload bridge** (`app/main/src/preload.ts` plus `shared/bridge/create-bridge.ts`): the only way the renderer reaches main. Channels are sorted for satellites in `shared/satellite/channels.ts`.
- **Shared** (`app/main/src/shared/<feature>/`): pure TypeScript both sides run, including the bridge types.
- **Renderer** (`app/renderer/src/`, Vite + React + three.js): stage, avatars (`avatar/`, one `AvatarActor` per character), 3D rooms (`rooms/`), audio and the local voice client (`realtime/`), settings pop-ups, satellite and web-satellite pages.
- **Python services** (`services/*`, each a small HTTP service with its own README and port): `speech` (STT/TTS), `motion` (text to motion), `memory` (long-term memory, PostgreSQL + pgvector), `switchboard` (event bus), `workflows` + `temporal` (agent time), `coder` (coding runner), `laya` (quick decisions), `searxng`, `avatar-face`, `avatar-paint`, `wakeword-trainer`.
- **Other**: `android-room/` (Kotlin WebView phone room), `scripts/` (dev, install and service start-up), `experiments/` (local-only investigations).

## Rules from experience
- **Fast decisions**: a new fixed-option or yes/no judgement (routing, triage, gating an LLM call) goes through the Quick decisions route and `SystemOneClient` (`app/main/src/decide/system-one.ts`), not a new LLM prompt. Pick a threshold, keep a fallback, and never let it alone approve anything risky. See [quick-decisions.md](docs/features/quick-decisions.md).
- **IPC handlers**: each feature registers its own in `app/main/src/<feature>/ipc.ts` (`registerXIpc({ handle, ...deps })`), where `handle` is the `HandleIpc` main.ts makes with `createHandleIpc(ipcMain)` (`app/main/src/ipc/handle-ipc.ts`; it also remembers the handler for satellites). main.ts only builds services and passes them in; don't call `ipcMain.handle` or add handlers to main.ts.
- **Model jobs**: read servers from `routeTargets(config.models, use)`, not from provider settings. Server keys come from `ConfigManager.getServerKey(id)` and never reach the renderer or the logs.
- **Local LLM calls** send `chat_template_kwargs: {enable_thinking: false}`.
- **ComfyUI**: never call its `/free` endpoint (it crashes Comfy Desktop). Avatar, background and furniture jobs share one `ComfyUIClient`/`ComfyUIRuntime`.
- **Containers on bija** run with `wslc` by default, Docker only as a fallback.
- **Windows start-up**: launch background servers with `Start-Process -WindowStyle Hidden`, not Node `detached` (PowerShell then has no console and exits silently).
- **Voice list**: the renderer's voice dropdown uses the baked-in list and fetches nothing on mount (`app/renderer/tests/App.test.tsx`).
- **Memory engine**: anything that updates a row in place must also set `updated_at`, or the mirror misses it.

### OpenAI Responses API usage
- Every content chunk follows the Responses API schema (text prompts are `{ type: 'input_text', text: '...' }`).
- Structured outputs set `text.format` to `{ type: 'json_schema', name: <identifier>, schema: <definition> }`. Don't send `response_format`, a `response` wrapper or `modalities`. Realtime handshakes choose media with `session.output_modalities` (`['audio']` or `['text']`, never both).
- Avatar component schemas mark `slot`, `mimeType` and `data` as required in each item.
- Non-OpenAI chat servers are wrapped with `createChatCompletionsResponsesClient`.

### Coding runner
- `services/coder` is a Python service (:8195) that runs the pi coding agent per task in a git worktree and opens a pull request after approval. The app side is `app/main/src/coding/`: `runner-client.ts` (HTTP and the event stream), `sync.ts` (workspaces, keys, settings), `model-swap.ts` and `coding-service.ts`.
- The `coding` model use defaults to the built-in `local-coder-llm` server (Qwen3-Coder-Next on :1236). On Windows, while a task needs the local model, `CoderModelSwap` stops Echo's llama-server, starts the coder's (pid file `coder-llm.pid`), and puts the coder server first for Thinking through `RouteOverride` (`routeTargetsWithOverride`, passed to `buildVoiceEngines` as `llmOverride`). After 120 s without need it swaps back.
- Coding settings (`config.coding`: runner, workspaces, coder GGUF) live in preferences.json. The GitHub, Anthropic and OpenAI keys are sent to the runner and never logged. `services/coder` and `app/main/src/coding/` are protected paths for coding tasks on this repository.

### Module system
- **Pure ESM**: no CommonJS except config files that need it (`prettier.config.cjs`).
- Every package has `"type": "module"`, TypeScript uses `"module": "ESNext"`, and imports use `.js` extensions.
- The preload script is compiled as ESM and loaded through Electron's ESM support.
