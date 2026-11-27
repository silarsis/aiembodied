# Sit lab runbook

You compare ten ways of fixing a bad sitting pose (body sinking into the seat, feet through the chair front, arm through the torso). Work in this folder: `experiments/sit-lab`. Follow the steps in order. Commands are PowerShell.

## Rules

1. One GPU job at a time. Never start a second motion run, vision run or ComfyUI job while one is running.
2. Do not edit any file outside `experiments/sit-lab`. Only write under `results/`, `rooms/` and the plan copies you make in `plans/`.
3. Never delete files.
4. Never call ComfyUI's `/free` endpoint.
5. If a step fails 3 times, stop and write `results/<runId>/STOPPED.md` with the command, the error and what you tried. Do not go on.
6. Trial results are the data. Never edit a trial JSON or `summary.csv` by hand (`judge.mjs` is the only tool that rewrites them).

## 1. Set up (once)

```powershell
cd experiments\sit-lab
npm install
```

The driver uses the installed Microsoft Edge (no browser download). The repo root needs `pnpm install` done already.

## 2. Export the room and find the seat

```powershell
node export-room.mjs
```

This lists every saved room with its objects (`id  name  position`). Pick the room the problem sofa or chair is in, then:

```powershell
node export-room.mjs "<room name or id>" --out rooms\sofa-room.json
```

It also prints the room assets folder; use it as `--assets` below. If no rooms are found, add `--user-data <the app's data folder>` (usually `%APPDATA%\Electron`).

The seat id is the `id` of the sofa or chair object. Copy the plan you need and put the id in `seatObjectId` (replace `SEAT_ID` or `SOFA_ID`):

```powershell
Copy-Item plans\smoke.json plans\smoke-mine.json
```

The avatar is a `.vrm` file (for example `app\main\assets\vrm-models\default-avatar.vrm`, or the avatar the app uses).

## 3. Start the motion service

From the repo root, start it with the real model (the command is in `services/motion/README.md`, around line 83: `.venv-ardy\Scripts\python -m motion_service --backend ardy --host 127.0.0.1 --port 8190 --text-encoders-dir <dir>`; it listens on `http://127.0.0.1:8190`). Check:

```powershell
Invoke-RestMethod http://127.0.0.1:8190/health
```

It must say `ready: true` and a real backend (not `fake`). The vite page server starts by itself when `run.mjs` runs, on port 5199.

## 4. Smoke test (1 trial)

```powershell
node run.mjs --plan plans\smoke-mine.json --room rooms\sofa-room.json --avatar <avatar.vrm> --assets <assets folder>
```

Then LOOK at the pictures in `results\smoke\baseline\front-s1-final-*.png` and `front-s1-sit-*.png` (the room view too). Check: the avatar is in the room, on the seat, facing the right way, and `summary.csv` has one row. If the picture is empty or the avatar is far from the seat, the seat id or the room is wrong: go back to step 2. A baseline that fails (`pass` false) is expected; that is the problem we are fixing.

## 5. Full run (150 trials)

Put the seat id into `plans\full.json`, then:

```powershell
node run.mjs --plan plans\full.json --room rooms\sofa-room.json --avatar <avatar.vrm> --assets <assets folder>
```

It runs one trial at a time and can be stopped and started again: finished trials are skipped. A trial that errors writes `<trial>.error.txt` and the run goes on; after 3 errors in a row it stops (rule 5). Use `--only <method name>` to run one method.

Starts (in the plan): `front` (2 m in front of the seat), `left` (to its left), `behind` (behind it, so it must walk round).

## 6. Judge with the vision model

Start the vision server (`scripts/start-local-vision.ps1`; it serves `http://127.0.0.1:1237/v1`). Stop the motion service first if the GPU is short on memory (rule 1).

```powershell
node judge.mjs full
```

The judge sees only the three final pictures, not the method name. It writes `visionScore` (1 to 5) into each trial JSON and into `summary.csv`.

## 7. Tune the top 3 methods

Rank methods by pass rate, then by lower median `shapeMeanDeg`. For each of the top 3 (not baseline) try at most 4 parameter settings, changing parameters only inside the ranges below. Put each variant in a copy of `plans\full.json` (`plans\tune-<method>.json`) as a new entry in `methods`, with a new unique `name`, `"method"` the method id and `"params"` the changed ones, `runId` `tune`, seeds `[1,2,3]`. Run it, judge it. Every change goes in `results\tune\tuning.md`: the method, the parameters, why you tried it, and the pass rate and median shape change you got.

Parameters (name, default, range):

- rigidTranslate / translateYaw: `blendStartS` 0.6 (0..3), `blendS` 1.2 (0.2..3), `pelvisTol` 0.05 (0..0.08); translateYaw also `maxYawDeg` 15 (0..30), `yawCost` 0.002 (0..0.02).
- closedLoop: `maxIters` 3 (1..5), `pelvisTol` 0.03 (0.01..0.1), `kneeTol` 0.05 (0.02..0.15), `footTol` 0.05 (0.02..0.15), `gain` 0.8 (0.2..1.5).
- wholeBodyTargets: `kneeOverhang` 0.03 (0..0.15), `footForward` 0 (0..0.3), `revealLeadS` 0 (-2..2), `holdS` 0.5 (0.2..2).
- hipsOnlyIK: `blendStartS` 0.6 (0..3), `blendS` 1.2 (0.2..3), `settleDamping` 12 (2..40), `footClearance` 0.03 (0..0.15).
- poseOptimise: `shapeWeight` 1 (0.1..20), `shiftWeight` 3 (0..50), `iterations` 25 (5..200), `blendStartS` 0.6 (0..3), `blendS` 1.2 (0.2..3).
- bestOfN: `n` 3 (1..8); the model is called 2n times.
- landThenSettle: `settleS` 1.5 (0.5..4).
- combo: `planning` (none | wholeBodyTargets | bestOfN, default wholeBodyTargets), `correction` (none | baseline | rigidTranslate | hipsOnlyIK, default rigidTranslate); the chosen methods' parameters go in with a `plan.` or `fix.` prefix, for example `"fix.blendS": 1.5`.
- baseline: no parameters.

An out-of-range value is an error at once; it is not clamped.

## 8. Sofa run with the winners

Copy `plans\sofa.json`, set `seatObjectId` to the sofa's id, and replace the three `WINNER_x` entries with your best three variants (their `method` and `params`). Keep `baseline`. Use the sofa's room export. Run and judge it the same way as steps 5 and 6 (`runId` `sofa`).

## 9. Write ANALYSIS.md

Copy `ANALYSIS.template.md` to `results\<runId>\ANALYSIS.md` for the full run (and another for `sofa`) and fill every section. Take numbers from `summary.csv` (open it with PowerShell `Import-Csv`, then `Group-Object method`). Do not invent numbers: if you did not compute one, write "not measured".

## Reading the metrics

Pass means all of: furniture penetration at the end under 1 cm, self penetration under 5 mm, `|seatGap|` at most 2 cm, pelvis within 8 cm of the sit point, feet within 2 cm of the floor, both ankles in front of the seat, no hinge breaks (elbow or knee sideways swing over 15 degrees or twist over 30). `shapeMeanDeg` is how far, on average, the joints were turned away from what the motion model produced (lower keeps its pose). `translationUsed` is how far the body was moved from where the model put it (metres). `modelCalls` and `computeMs` are the cost.
