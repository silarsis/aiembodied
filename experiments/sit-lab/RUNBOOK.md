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

The armchair room is the built-in "Reading room" (`room:builtin:reading-room`, `app\main\assets\rooms\reading-room.json`). Its seats are `armchair` and `sofa`. List the saved rooms (use the main checkout's dev data folder, not the worktree's):

```powershell
node export-room.mjs --user-data <main checkout>\.dev-home\AppData\Roaming\Electron
```

This lists every room with its objects (`id  name  position`) and prints the room assets folder (use the worktree's `app\main\assets\rooms` as `--assets`). Export the room:

```powershell
node export-room.mjs "Reading room" --out rooms\reading-room.json
```

`plans\smoke.json` and `plans\full.json` already use the seat id `armchair`, and `plans\sofa.json` uses `sofa`. For another seat, change `seatObjectId` in a copy of the plan.

Do not write JSON with PowerShell `Set-Content -Encoding utf8`: Windows PowerShell 5.1 adds a byte order mark. Edit plans with node (or an editor that writes plain UTF-8). `run.mjs` strips a leading BOM from the plan and the room file anyway.

The avatar is a `.vrm` file (for example `app\main\assets\vrm-models\default-avatar.vrm`, or the avatar the app uses).

## 3. Start the motion service

Run the motion service from the worktree's code, on port 8291, with the real model. It takes about 100 s to load; `run.mjs` waits for `/health` to say ready.

```powershell
$env:PYTHONPATH = "<worktree>\services\motion\src"
Start-Process <main>\experiments\kimodo\.venv-ardy\Scripts\python.exe -ArgumentList '-m','motion_service','--backend','ardy','--host','127.0.0.1','--port','8291','--text-encoder-device','gpu','--text-encoders-dir','<main>\experiments\kimodo\text_encoders_merged' -WindowStyle Hidden
Invoke-RestMethod http://127.0.0.1:8291/health
```

It must say `ready: true` and a real backend (not `fake`). The motion URL is read from `"motionUrl"` in the plan file (default `http://127.0.0.1:8190`); it is not a flag of its own, but `--motion-url <url>` on `run.mjs` overrides the plan. The vite page server starts by itself when `run.mjs` runs, on port 5199.

Set `"jointTargets": false` in a plan to drop the knee and ankle targets the app sends with every sit (they make ARDY turn the feet and head about 180 degrees near the end of the sit).

## 4. Smoke test (1 trial)

```powershell
node run.mjs --plan plans\smoke.json --room rooms\reading-room.json --avatar <vrm path> --assets <worktree>\app\main\assets\rooms --run-id smoke --motion-url http://127.0.0.1:8291
```

Then LOOK at the pictures in `results\smoke\baseline\front-s1-final-*.png` and `front-s1-sit-*.png` (the room view too). Check: the avatar is in the room, on the seat, facing the right way, and `summary.csv` has one row. If the picture is empty or the avatar is far from the seat, the seat id or the room is wrong: go back to step 2. A baseline that fails (`pass` false) is expected; that is the problem we are fixing.

## 5. Full run (150 trials)

```powershell
node run.mjs --plan plans\full.json --room rooms\reading-room.json --avatar <vrm path> --assets <worktree>\app\main\assets\rooms --run-id <id> --motion-url http://127.0.0.1:8291
```

It runs one trial at a time and can be stopped and started again: finished trials are skipped. A trial that errors writes `<trial>.error.txt` and the run goes on; after 3 errors in a row it stops (rule 5). Use `--only <method name>` to run one method.

Starts (in the plan): `front` (2 m in front of the seat), `left` (to its left), `behind` (behind it, so it must walk round).

## 6. Judge with the vision model

Start the vision server (`scripts/start-local-vision.ps1`; it serves `http://127.0.0.1:1237/v1`, model `qwen3-vl`). The model files are Qwen3-VL-8B from `unsloth/Qwen3-VL-8B-Instruct-GGUF` (the app's download):

```powershell
$d="$env:USERPROFILE\.cache\aiembodied\llm-models\vision\unsloth--Qwen3-VL-8B-Instruct-GGUF"
Start-Process powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-File','<repo>\scripts\start-local-vision.ps1','-Model',"$d\Qwen3-VL-8B-Instruct-Q4_K_M.gguf",'-Mmproj',"$d\mmproj-F16.gguf" -WorkingDirectory <repo> -WindowStyle Hidden -RedirectStandardOutput vision.log -RedirectStandardError vision.err.log
Invoke-RestMethod http://127.0.0.1:1237/v1/models   # lists qwen3-vl when ready (under a minute)
```

A judgement takes about 6 s. Stop the motion service first if the GPU is short on memory (rule 1).

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

Copy `plans\sofa.json` (its `seatObjectId` is already `sofa`, in the same Reading room export) and replace the three `WINNER_x` entries with your best three variants (their `method` and `params`). Keep `baseline`. Run and judge it the same way as steps 5 and 6 (`runId` `sofa`).

## 9. Write ANALYSIS.md

Copy `ANALYSIS.template.md` to `results\<runId>\ANALYSIS.md` for the full run (and another for `sofa`) and fill every section. Take numbers from `summary.csv` (open it with PowerShell `Import-Csv`, then `Group-Object method`). Do not invent numbers: if you did not compute one, write "not measured".

## Reading the metrics

Pass means all of: furniture penetration at the end under 1 cm, self penetration under 5 mm, `|seatGap|` at most 2 cm, pelvis within 8 cm of the sit point, feet within 2 cm of the floor, both ankles in front of the seat, no hinge breaks (elbow or knee sideways swing over 15 degrees or twist over 30). `shapeMeanDeg` is how far, on average, the joints were turned away from what the motion model produced (lower keeps its pose). `translationUsed` is how far the body was moved from where the model put it (metres). `modelCalls` and `computeMs` are the cost.

Self penetration is measured beyond what each pair of body parts already overlaps in the avatar's rest pose (the two thighs overlap at the hips in every pose), and a hand counts against a thigh or the pelvis only when the hand's own axis is inside it. `selfPenPair` names the worst pair.

Model faults and method faults are separate. The `raw*` columns (`rawFurnitureEnd`, `rawSelfPen`, `rawSelfPenPair`, `rawHingeMaxDeg`, `rawHingeWorst` as `joint:twist|sideways`) are measured on the motion model's own poses, with no method and no joint limits. `hingeWorst` lists each joint that broke in the final pose as `joint:component:degrees`. Every method runs with the app's joint limits applied after it (as the app does); the trial JSON's `limitClamps` lists the joints the limits turned at the end pose and by how much. `request.targets` in the trial JSON is what was sent to the motion service (check the knee and ankle targets and their `root` there). `methodReport` holds a method's own findings; `infeasible: true` means rigidTranslate, translateYaw or hipsOnlyIK could not clear the furniture and `residualPenetration` is what is left.
