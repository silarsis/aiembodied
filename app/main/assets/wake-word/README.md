# Wake-word models

These ONNX models come from [openWakeWord](https://github.com/dscripka/openWakeWord) release v0.5.1, by David Scripka.

| File | Role |
| --- | --- |
| `melspectrogram.onnx` | Turns 16 kHz audio into mel-spectrogram frames |
| `embedding_model.onnx` | Google's speech embedding model, shared by every wake word |
| `hey_jarvis_v0.1.onnx`, `alexa_v0.1.onnx`, `hey_mycroft_v0.1.onnx`, `hey_rhasspy_v0.1.onnx` | Pre-trained wake-word classifiers |

- openWakeWord's code is Apache-2.0.
- The pre-trained wake-word models are licensed [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/), so they are for non-commercial use only.
- The feature models are derived from Google's [speech_embedding](https://www.kaggle.com/models/google/speech-embedding) model (Apache-2.0).

To use your own wake word, train a model with openWakeWord's training notebook. Then point `WAKE_WORD_MODEL` at the resulting `.onnx` file.
