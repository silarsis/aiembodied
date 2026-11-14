# Models

`blaze_face_short_range.tflite` is Google's BlazeFace short-range face detector (float16, version 1), used by
camera presence (`src/camera`). It only says whether a face is in view; it does not recognise anyone.

- Source: https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite
- Licence: Apache License 2.0 (MediaPipe models, Google LLC).

If the file is missing, run `node scripts/fetch-face-model.mjs` from the repo root. Camera presence stays off
(with the reason in the log) while the file is missing.
