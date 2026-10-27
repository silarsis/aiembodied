"""Smoke-test a running motion service and measure client-side latency.

  python scripts/smoke_test.py [--url http://127.0.0.1:8190] [--prompt "..."] [--out DIR] [--runs 3]

Prints /health, then wall-clock latency for /v1/motion/clip and for /v1/motion/stream (time to the first
chunk line and to `done`). With --out, writes each returned VRMA JSON there for schema checks.
Standard library only, so it runs from any Python.
"""

import argparse
import json
import statistics
import time
import urllib.request
from pathlib import Path


def post(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=600)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8190")
    ap.add_argument("--prompt", default="A person waves hello with their right hand.")
    ap.add_argument("--clip-duration", type=float, default=3.0)
    ap.add_argument("--stream-duration", type=float, default=6.0)
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--out", type=Path, default=None)
    a = ap.parse_args()
    if a.out:
        a.out.mkdir(parents=True, exist_ok=True)

    print("health:", urllib.request.urlopen(a.url + "/health").read().decode())

    clip_ms, server = [], []
    for i in range(a.runs):
        t = time.perf_counter()
        body = json.load(post(a.url + "/v1/motion/clip",
                              {"prompt": a.prompt, "duration": a.clip_duration, "name": "wave-hello"}))
        clip_ms.append((time.perf_counter() - t) * 1000)
        server.append(body["timings"])
        if a.out and i == 0:
            (a.out / "clip.json").write_text(json.dumps(body["vrma"]))
    print(f"clip {a.clip_duration}s: wall median {statistics.median(clip_ms):.0f} ms {[round(x) for x in clip_ms]}; "
          f"server {server[-1]}")

    first, total, per_chunk = [], [], []
    for i in range(a.runs):
        t = time.perf_counter()
        r = post(a.url + "/v1/motion/stream", {"prompt": a.prompt, "duration": a.stream_duration, "name": "wave-hello"})
        arrivals = []
        for line in r:
            msg = json.loads(line)
            arrivals.append((time.perf_counter() - t) * 1000)
            if msg["type"] == "chunk":
                if a.out and i == 0:
                    (a.out / f"stream-{msg['index']}.json").write_text(json.dumps(msg["vrma"]))
                per_chunk.append(msg["timings"]["totalMs"])
            elif msg["type"] == "error":
                raise SystemExit(f"stream error: {msg['message']}")
            else:
                print(f"  stream run {i}: chunk arrivals {[round(x) for x in arrivals[:-1]]} ms, done {msg}")
        first.append(arrivals[0])
        total.append(arrivals[-1])
    print(f"stream {a.stream_duration}s: first chunk wall median {statistics.median(first):.0f} ms, "
          f"done median {statistics.median(total):.0f} ms")


if __name__ == "__main__":
    main()
