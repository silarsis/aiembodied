# Agent Operating Guide

## Project Context
This repository implements the **Embodied ChatGPT Assistant MVP**, as outlined in the high-level documents:
- Product requirements: see [`prd.md`](./prd.md).
- Architecture specification: see [`archspec.md`](./archspec.md).
- Phased implementation roadmap: see [`plan.md`](./plan.md).

Always cross-check planned work against these references before making changes. When adding or modifying features, verify that the resulting behavior satisfies the PRD goals (wake-word driven, low-latency, kiosk-ready assistant) while conforming to the architecture boundaries and module responsibilities in the spec.

## Development Workflow
1. Read the relevant section in `plan.md` for the feature you are implementing.
2. Confirm functional expectations against `prd.md` and architectural constraints in `archspec.md`.
3. Implement and update tests in the scoped package (prefer colocated unit/integration tests).
4. Run the full verification commands listed below before committing.
5. Update the "Implementation Progress" checklist in this file to reflect completed milestones.

## Testing & Verification
Run these commands from the repository root unless a task specifies otherwise:
- `pnpm install` — ensure dependencies resolve from a clean checkout.
- `pnpm lint` — enforce linting rules across packages.
- `pnpm typecheck` — run TypeScript project-wide type analysis.
- `pnpm test` — execute automated unit/integration tests.
- `pnpm build` — (as needed) validate production builds for Electron targets.

Document any deviations or additional checks in your PR description, especially if a module introduces new tooling.

## Implementation Progress
Track progress against `plan.md` here. Update the status markers (`[ ]` incomplete, `[x]` complete, `[~]` in progress) immediately after meaningful work lands.

- [x] 0. Repo Scaffolding & Tooling — base monorepo in place; ongoing validation of lint/type/test harness.
- [x] 1. Configuration & Secrets Foundation
- [x] 2. Logging & Crash Guard Infrastructure
- [x] 3. Wake Word Service (Porcupine Worker) — Worker entrypoint adjusted for ts-node dev usage
- [x] 4. Audio Graph & Device Management
- [x] 5. Realtime Client (WebRTC Loop)
- [ ] 6. Viseme Driver MVP
- [ ] 7. Avatar Renderer (2D Canvas)
- [ ] 8. Transcript Overlay & UI Shell
- [ ] 9. Memory Store (SQLite)
- [ ] 10. Persistence in Conversation Loop
- [ ] 11. Observability & Metrics
- [ ] 12. Packaging & Auto-Launch
- [ ] 13. Appliance Readiness Validation
- [ ] 14. Future Unity Integration Prep (Stretch)

Keep this checklist accurate; it is the authoritative tracker for execution state.

## Recent QA Activities

- 2025-10-05 — Added integration tests for the main process bootstrap and Porcupine worker to raise coverage across wake word orchestration.
- 2025-10-04 — Added Vitest coverage instrumentation and validated preload bridge ping wiring via renderer tests.
