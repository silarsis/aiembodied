# Laya floor routing: training data and scoring

Laya (PyPI package `laya`) is a small classifier that routes a person's spoken lines between AI avatars in a room. For each line Kevin says it answers three choice questions:

- `addressed`: the avatar he is speaking to, `everyone`, or `unclear` (the line names no one).
- `wants`: `answer`, `converse` or `relay`.
- `other`: the other avatar involved when `wants` is `converse` or `relay`, else `none`.

## Files

- `floor_prompt.py`: shared builders (`build_state`, `build_questions`, `resolve_speaker`). The app mirrors these, so keep them stable.
- `floor_banks.py`: names, mishearing aliases and the content banks.
- `floor_data.py`: the deterministic data generator.
- `score.py`: scores a running Laya server against a JSONL file.
- `test_floor_data.py`: unit tests.

## The data

Each row is a scene (1 to 4 avatars), an addressing frame that fixes the labels by construction, content written for this project, and surface noise (lower-casing, fillers, dropped commas, misheard names). The generator keeps separate content for train and val, so `val.jsonl` uses phrases never seen in training. The state is plain text, not JSON.

## Generate

```
python floor_data.py --out DIR --n 8000 --seed 0 [--exclude FILE.jsonl]
```

This writes `train.jsonl` and `val.jsonl` and prints counts per frame, label and scene size. The same seed gives the same files. Do not commit the generated data.

## Hold-out rule

The hold-out test sentences are never used for training and never read when writing data. Pass any file of hold-out rows to `--exclude` (rows with `meta.text` or `text`). Any generated line whose lower-cased letters and digits match one of them is dropped.

## Train

This is run on the user's PC, not here:

```
laya-train --data train.jsonl --eval val.jsonl --base convaiinnovations/laya --out <dir> --shuffle-options
```

## Score

```
python score.py --data FILE.jsonl [--url http://127.0.0.1:8197] [--model NAME] [--out results.json]
```

It posts each row to `{url}/v1/systemone` (set `LAYA_API_KEY` for a bearer token). Rows with `expected` need all three fields to match. Rows with `truth` are graded on the speaker from `resolve_speaker`, plus intent and target; rows marked `debatable` are reported but not counted. The output has accuracy per field and for all three, accuracy per frame or grade, latency, mean top probability on right and wrong answers, and every miss. The exit code is always 0.

## Tests

```
python -m unittest discover -s services/laya/training
```
