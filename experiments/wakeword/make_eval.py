"""Synthesize an independent wake-word test set with the app's Kokoro TTS (services/speech), a
different engine from the Piper voices used for training. Writes eval/{pos,neg}/*.wav."""
import json
import urllib.request
from pathlib import Path

URL = "http://127.0.0.1:8192/v1/tts"
VOICES = ["af_heart", "af_bella", "af_nicole", "af_sarah", "af_sky", "af_aoede", "af_kore", "af_jessica", "af_river",
          "am_adam", "am_michael", "am_eric", "am_liam", "am_onyx", "am_puck", "am_fenrir", "am_echo",
          "bf_emma", "bf_isabella", "bf_alice", "bf_lily", "bm_george", "bm_lewis", "bm_daniel", "bm_fable"]
POSITIVE = ["Hey Echo.", "Hey Echo, what time is it?", "Hey Echo, turn on the lights.", "Hey, Echo."]
NEGATIVE = ["I heard an echo in the hallway.", "The echo was really loud in that cave.", "Hey, let's go.",
            "Hey Jarvis, what's the weather?", "Hey, could you pass the salt?", "That's an eco friendly design.",
            "Say hello to everyone.", "We went to the beach yesterday and it was lovely.",
            "Did you hear about the new restaurant on the corner?", "The meeting starts at ten o'clock.",
            "Echoes of the past.", "Hey, ego is not a dirty word.", "They echo each other constantly.",
            "Head echo cancellation is on.", "A gecko on the wall."]
here = Path(__file__).parent / "eval"
voices_ok = []
for kind, texts in (("pos", POSITIVE), ("neg", NEGATIVE)):
    (here / kind).mkdir(parents=True, exist_ok=True)
    for voice in VOICES:
        for speed in (0.9, 1.1):
            for i, text in enumerate(texts):
                out = here / kind / f"{voice}_{speed}_{i:02d}.wav"
                if out.exists():
                    continue
                req = urllib.request.Request(URL, data=json.dumps({"text": text, "voice": voice, "speed": speed}).encode(),
                                             headers={"Content-Type": "application/json"})
                try:
                    out.write_bytes(urllib.request.urlopen(req, timeout=60).read())
                except Exception as error:
                    print(f"skip {voice}: {error}")
                    break
print({k: len(list((here / k).glob("*.wav"))) for k in ("pos", "neg")})
