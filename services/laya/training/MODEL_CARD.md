---
license: apache-2.0
base_model: convaiinnovations/laya
language: en
tags:
  - text-classification
  - laya
  - aiembodied
---

# laya-floor-v1

A fine-tune of [Laya](https://pypi.org/project/laya/) that routes one line of a person's speech among the avatars in a room. For each line it answers three typed choice questions in one pass, with no text generation:

- `addressed`: which avatar the person is speaking to (an avatar, `everyone`, or `unclear`);
- `wants`: what they want that avatar to do (`answer`, `converse` or `relay`);
- `other`: which other avatar is involved (an avatar or `none`).

It is used by [aiembodied](https://github.com/silarsis/aiembodied), which downloads it automatically on first start.

## Prompt format

The prompt must match this format exactly, because the model was trained on it. The state is plain text, built from the scene (avatar names, the host marked), who the person last spoke with, up to four recent lines (each clipped to 200 characters) and the new line:

```
Avatars in the room: Lenha (host), Orin, Mira.
Kevin last spoke with: Orin.
Orin: <recent line>
Kevin: <the line to route>
```

If nobody was spoken with, the second line reads `Kevin last spoke with: nobody.` The three questions, with one option per avatar (lower-case name as the key):

```
addressed (choice): "Which avatar is Kevin speaking to in his last line, the one who should act on it?"
  <name>: "Kevin is speaking to <Name>"          (one per avatar)
  everyone: "Kevin is speaking to all the avatars"
  unclear: "The line does not say which avatar he is speaking to"
wants (choice): "What does Kevin want that avatar to do?"
  answer: "reply to Kevin or do what he asks"
  converse: "go and have a conversation with another avatar"
  relay: "ask or tell another avatar something for Kevin"
other (choice): "Which other avatar should they talk to or pass the message to?"
  <name>: "<Name>"                                (one per avatar)
  none: "no other avatar is involved"
```

The reference implementation is `services/laya/training/floor_prompt.py` in the repository.

## Training data

8,000 generated rows of made-up room conversations (`floor_data.py`), 4 epochs, starting from `convaiinnovations/laya`. Sentences that match the hold-out sets were removed from training.

## Results

| Hold-out set | Lines | All three fields right |
| --- | --- | --- |
| Floor set | 47 | 100% |
| Fresh independent set | 110 | 94.5% |

Known weakness: it sometimes picks an avatar that is mentioned in the line but is not the one addressed. The app falls back to its chat model when the answer is unsure.

## Serving

Serve it with `laya-serve` by registering the folder as an extra model:

```
LAYA_EXTRA_MODELS={"laya-floor-v1":"/path/to/laya-floor-v1"}
LAYA_MODELS=english,laya-floor-v1
```

Then send requests to `/v1/systemone` with `"model": "laya-floor-v1"`.

## License

Apache-2.0. This model is a derivative of Laya by Convai Innovations (Apache-2.0).
