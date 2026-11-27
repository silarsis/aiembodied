# Sit lab

A dev-only harness for comparing ways of correcting a bad sitting pose (body sunk into the seat, feet through the chair front). It lives in `app/renderer/src/sit-lab/` (page `app/renderer/sit-lab.html`, served by `vite dev`, not part of the production build) and `experiments/sit-lab/` (Node driver, runbook, plans).

- The page builds the real room controller, physics, contact solver and joint limits, plans the sit with `planAction`, and steps frames at a fixed 1/30 s. `window.sitLab` has `load(spec)`, `runTrial(trial)`, `capture(view)` and `methods()`.
- Ten methods (`src/sit-lab/methods/`) each plan and/or correct a motion. They read the seat only through `Destination` (surface height, front edge, facing, foot floor), derived from the plan's seat geometry, so they are not sofa-specific.
- Metrics (`metrics.ts`) are pure and unit-tested; the pass criteria are in `PASS_LIMITS`.
- The motion service accepts a per-request `seed` (`services/motion/API.md`) and allows requests from localhost pages (CORS) so the page can call it directly.
- `ContactBody.capsulesNow` exists for the lab's measurements.

Run it with `experiments/sit-lab/RUNBOOK.md`.
