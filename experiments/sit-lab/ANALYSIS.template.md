# Sit lab analysis: <runId>

Seat: <room, seat id>. Avatar: <file>. Trials: <n> (<methods> methods x <seeds> seeds x <starts> starts). Motion service: <backend, date>.

## Per-method summary

One row per method (and tuned variant). Median over its trials.

| method | trials | pass rate | median shape change (deg) | median end penetration (m) | median vision score | model calls per trial | compute ms per trial |
| ------ | ------ | --------- | ------------------------- | -------------------------- | ------------------- | --------------------- | -------------------- |
|        |        |           |                           |                            |                     |                       |                      |

## Failure patterns

For each failure that repeats, name the criterion, the methods and starts it affects, and list the trial ids (for example `hipsOnlyIK/behind-s3`). Say what the pictures show.

## Ranked recommendation

1. Best method and its parameters, with the numbers that justify it.
2. Second and third.
3. What to avoid, and why.

Say how much of the gain comes from the model call (planning) and how much from the correction.

## How it generalises

What in the results depends on this seat or this room, and what does not. What to check on a chair, a stool, a bench and a seat against a wall. Which methods use only the seat's measurements (surface height, front edge, facing) and which assumed something about this sofa.

## Tuning

Summarise `tuning.md`: what changed, what helped.

## Limits of this run

Judge reliability, seeds, anything not measured.
