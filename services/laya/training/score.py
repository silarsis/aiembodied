#!/usr/bin/env python3
"""Score a Laya floor classifier against a JSONL file.

    python score.py --data FILE.jsonl [--url http://127.0.0.1:8197] [--model NAME] [--out results.json]

Rows have either `expected` ({addressed, wants, other}) or `truth`
({speaker, intent, target} as lists of accepted lower-case values, plus
scene, host, last, optional debatable and grade). Exit code is always 0.
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from floor_prompt import build_questions, build_state, resolve_speaker  # noqa: E402

QIDS = ("addressed", "wants", "other")


def make_fetch(url: str, api_key=None, timeout: float = 120.0):
    endpoint = url.rstrip("/") + "/v1/systemone"

    def fetch(payload: dict) -> dict:
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        req = urllib.request.Request(endpoint, data=json.dumps(payload).encode(), headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    return fetch


def top_of(answer):
    """Return (key, probability, probabilities) for one choice answer."""
    if isinstance(answer, str):
        return answer, None, {}
    probs = answer.get("probabilities") or {}
    if probs:
        key = max(probs, key=lambda k: probs[k])
        return key, probs[key], probs
    choice = answer.get("choice")
    return choice, None, {}


def extract(resp: dict) -> dict:
    src = resp.get("answers", resp) if isinstance(resp, dict) else {}
    out = {}
    for q in QIDS:
        if q in src:
            out[q] = top_of(src[q])
    return out


def row_text(row):
    return (row.get("meta") or {}).get("text") or row.get("text") or ""


def row_group(row):
    return (row.get("meta") or {}).get("frame") or row.get("grade") or "ungrouped"


def build_payload(row, model=None):
    state = row.get("state")
    questions = row.get("questions")
    if questions is None:
        questions = build_questions(row["scene"])
    if state is None:
        state = build_state(row["scene"], row["host"], row.get("last"), [tuple(x) for x in row.get("recent", [])],
                            row_text(row))
    payload = {"state": state, "questions": questions}
    if model:
        payload = {"model": model, **payload}
    return payload


def grade(row, got: dict) -> dict:
    """got: {qid: (key, prob, probs)}. Returns per-field correctness and the comparison values."""
    keys = {q: (got[q][0] if q in got else None) for q in QIDS}
    if "expected" in row:
        exp = row["expected"]
        want = {q: [exp[q]] for q in QIDS}
        have = dict(keys)
        counted = True
    else:
        t = row["truth"]
        speaker = None
        if keys["addressed"] is not None:
            speaker = resolve_speaker(keys["addressed"], keys["other"] or "none", row["scene"], row["host"],
                                      row.get("last"))
        have = {"addressed": speaker, "wants": keys["wants"], "other": keys["other"]}
        want = {"addressed": t["speaker"], "wants": t["intent"], "other": t["target"]}
        counted = not row.get("debatable")
    ok = {q: have[q] is not None and str(have[q]).lower() in [str(x).lower() for x in want[q]] for q in QIDS}
    return {"ok": ok, "want": want, "have": have, "counted": counted, "all": all(ok.values())}


def percentile(values, p):
    if not values:
        return None
    v = sorted(values)
    return v[min(len(v) - 1, int(round(p / 100 * (len(v) - 1))))]


def run(rows, fetch, model=None, progress=None):
    items = []
    for i, row in enumerate(rows):
        payload = build_payload(row, model)
        t0 = time.perf_counter()
        err = None
        try:
            got = extract(fetch(payload))
        except Exception as e:  # network or server failure counts as a miss
            got, err = {}, f"{type(e).__name__}: {e}"
        lat = time.perf_counter() - t0
        g = grade(row, got)
        items.append({"index": i, "text": row_text(row), "group": row_group(row), "latency": lat, "error": err,
                      "got": {q: {"key": got[q][0], "top": got[q][1], "probabilities": got[q][2]} for q in got},
                      **g})
        if progress:
            progress(i + 1, len(rows))
    return summarise(items)


def summarise(items):
    counted = [it for it in items if it["counted"]]
    n = len(counted)
    acc = {q: (sum(it["ok"][q] for it in counted) / n if n else None) for q in QIDS}
    all3 = sum(it["all"] for it in counted) / n if n else None
    groups = {}
    for it in counted:
        g = groups.setdefault(it["group"], [0, 0])
        g[0] += it["all"]
        g[1] += 1
    lats = [it["latency"] for it in items]
    right, wrong = [], []
    for it in counted:
        for q in QIDS:
            top = (it["got"].get(q) or {}).get("top")
            if top is not None:
                (right if it["ok"][q] else wrong).append(top)
    misses = [it for it in items if not it["all"]]
    debatable = [it for it in items if not it["counted"]]
    return {
        "rows": len(items), "counted": n, "debatable_rows": len(debatable),
        "debatable_all_correct": sum(it["all"] for it in debatable),
        "accuracy": acc, "all_three": all3,
        "by_group": {k: {"correct": v[0], "total": v[1], "accuracy": v[0] / v[1]} for k, v in sorted(groups.items())},
        "latency_median": statistics.median(lats) if lats else None, "latency_p95": percentile(lats, 95),
        "mean_top_prob_right": statistics.mean(right) if right else None,
        "mean_top_prob_wrong": statistics.mean(wrong) if wrong else None,
        "errors": sum(1 for it in items if it["error"]),
        "misses": [{"text": it["text"], "group": it["group"], "counted": it["counted"], "expected": it["want"],
                    "got": it["have"], "raw": it["got"], "error": it["error"]} for it in misses],
    }


def fmt(x, pct=False):
    if x is None:
        return "n/a"
    return f"{100 * x:.1f}%" if pct else f"{x:.3f}"


def report(res):
    print(f"rows {res['rows']}  counted {res['counted']}  debatable (not counted) {res['debatable_rows']}"
          f" ({res['debatable_all_correct']} fully right)  errors {res['errors']}")
    for q in QIDS:
        print(f"  {q:10s} {fmt(res['accuracy'][q], True)}")
    print(f"  all three  {fmt(res['all_three'], True)}")
    print("by group:")
    for k, v in res["by_group"].items():
        print(f"  {k:28s} {v['correct']:5d}/{v['total']:<5d} {100 * v['accuracy']:5.1f}%")
    print(f"latency median {fmt(res['latency_median'])}s  p95 {fmt(res['latency_p95'])}s")
    print(f"mean top probability: right {fmt(res['mean_top_prob_right'])}  wrong {fmt(res['mean_top_prob_wrong'])}")
    print(f"misses ({len(res['misses'])}):")
    for m in res["misses"]:
        tag = "" if m["counted"] else " [debatable]"
        print(f"- {m['text']!r} ({m['group']}){tag}")
        print(f"    expected {m['expected']}")
        print(f"    got      {m['got']}")
        for q, a in m["raw"].items():
            probs = ", ".join(f"{k}={v:.2f}" for k, v in sorted(a["probabilities"].items(), key=lambda kv: -kv[1])[:4])
            print(f"    {q}: {a['key']}  [{probs}]")
        if m["error"]:
            print(f"    error: {m['error']}")


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--url", default="http://127.0.0.1:8197")
    ap.add_argument("--model")
    ap.add_argument("--out")
    a = ap.parse_args(argv)
    with open(a.data, encoding="utf-8") as f:
        rows = [json.loads(line) for line in f if line.strip()]
    fetch = make_fetch(a.url, os.environ.get("LAYA_API_KEY"))
    res = run(rows, fetch, a.model)
    report(res)
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            json.dump(res, f, indent=2, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"score.py failed: {e}", file=sys.stderr)
    sys.exit(0)
