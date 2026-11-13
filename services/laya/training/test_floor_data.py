import json
import os
import re
import sys
import tempfile
import unittest
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import floor_banks as banks  # noqa: E402
import floor_data as fd  # noqa: E402
import score  # noqa: E402
from floor_prompt import build_questions, build_state, resolve_speaker  # noqa: E402

_CACHE = {}


def rows(n, seed, split="train", exclude=frozenset()):
    key = (n, seed, split, len(exclude))
    if key not in _CACHE or exclude:
        _CACHE[key] = fd.generate_split(n, seed, split, exclude)
    return _CACHE[key]


class GeneratorTests(unittest.TestCase):
    def test_determinism(self):
        a = fd.generate_split(300, 3, "train")
        b = fd.generate_split(300, 3, "train")
        c = fd.generate_split(300, 4, "train")
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)

    def test_expected_keys_exist(self):
        for r in rows(1500, 1):
            exp, q = r["expected"], r["questions"]
            self.assertIn(exp["addressed"], q["addressed"]["criteria"])
            self.assertIn(exp["wants"], q["wants"]["criteria"])
            self.assertIn(exp["other"], q["other"]["criteria"])
            self.assertTrue(r["meta"]["text"].strip())
            self.assertIn("Kevin: " + r["meta"]["text"], r["state"])

    def test_addressed_differs_from_other(self):
        for r in rows(1500, 2):
            e = r["expected"]
            if e["other"] != "none":
                self.assertNotEqual(e["addressed"], e["other"])
                self.assertIn(e["wants"], ("converse", "relay"))
            else:
                self.assertEqual(e["wants"], "answer")

    def test_no_duplicate_states(self):
        rs = rows(1500, 5)
        self.assertEqual(len({r["state"] for r in rs}), len(rs))

    def test_anyone_but_resolution(self):
        for r in rows(4000, 6):
            if r["meta"]["frame"] != "anyone-but":
                continue
            m, e = r["meta"], r["expected"]
            got = resolve_speaker(e["addressed"], e["other"], m["scene"], m["host"], m["last"])
            self.assertNotEqual(got, "everyone")
            if len(m["scene"]) >= 3:
                self.assertEqual(e["addressed"], "unclear")
                named = [n for n in m["scene"] if re.search(r"\b%s\b" % n, m["text"], re.I)]
                self.assertTrue(named)

    def test_exclude_filter(self):
        base = rows(200, 7)
        banned = [r["meta"]["text"] for r in base[:40]]
        with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as f:
            for t in banned[:20]:
                f.write(json.dumps({"meta": {"text": t}}) + "\n")
            for t in banned[20:]:
                f.write(json.dumps({"text": t.upper() + "!!"}) + "\n")
            path = f.name
        try:
            excl = fd.load_exclude(path)
        finally:
            os.unlink(path)
        new = fd.generate_split(200, 7, "train", excl)
        got = {fd.norm(r["meta"]["text"]) for r in new}
        for t in banned:
            self.assertNotIn(fd.norm(t), got)

    def test_val_content_not_in_train(self):
        tr, va = fd.get_bank("train"), fd.get_bank("val")
        self.assertTrue(va.imp and va.q and va.topics and va.relay_q and va.relay_msg)
        trn = {fd.norm(p) for p in tr.phrases()}
        van = {fd.norm(p) for p in va.phrases()}
        self.assertFalse(trn & van)
        for r in rows(3000, 8, "train"):
            t = fd.norm(r["meta"]["text"])
            for p in van:
                if len(p) >= 15:
                    self.assertNotIn(p, t, r["meta"]["text"])

    def test_bank_sizes_and_names(self):
        self.assertGreaterEqual(len(banks.IMP) + len(banks.Q) + len(banks.ST), 250)
        self.assertGreaterEqual(len(banks.TOPICS), 80)
        self.assertGreaterEqual(len(banks.RELAY_Q), 80)
        self.assertGreaterEqual(len(banks.RELAY_MSG), 50)
        self.assertGreaterEqual(len(banks.PEOPLE_NAMES) + len(banks.PEOPLE_REL), 40)
        self.assertGreaterEqual(len(banks.NAMES), 60)
        self.assertGreaterEqual(len(banks.ALIASES), 25)
        low = {n.lower() for n in banks.NAMES}
        self.assertFalse(low & {p.lower() for p in banks.PEOPLE_NAMES})
        for k, al in banks.ALIASES.items():
            self.assertIn(k, banks.NAMES)
            self.assertFalse({a.lower() for a in al} & low)

    def test_no_avatar_name_inside_content(self):
        words = set()
        for lst in (banks.IMP, banks.Q, banks.ST, banks.G_IMP, banks.G_Q, banks.G_ST, banks.TOPICS, banks.RELAY_Q,
                    banks.RELAY_MSG, banks.PEOPLE_REL):
            for p in lst:
                words.update(re.findall(r"[a-z]+", p.lower()))
        self.assertFalse(words & {n.lower() for n in banks.NAMES})

    def test_label_balance(self):
        rs = rows(4000, 9)
        n = len(rs)

        def cat_a(e):
            return e if e in ("everyone", "unclear") else "avatar"
        for q, cat in (("addressed", cat_a), ("wants", lambda e: e),
                       ("other", lambda e: "none" if e == "none" else "avatar")):
            cnt = Counter(cat(r["expected"][q]) for r in rs)
            for k, v in cnt.items():
                self.assertGreaterEqual(v / n, 0.05, (q, k, v))

    def test_scene_sizes(self):
        cnt = Counter(len(r["meta"]["scene"]) for r in rows(4000, 10))
        self.assertTrue(0.03 < cnt[1] / 4000 < 0.08)
        self.assertTrue(cnt[2] > cnt[3] > cnt[4])


class PromptTests(unittest.TestCase):
    def test_build_state(self):
        s = build_state(["Echo", "Sage"], "Echo", "Sage", [("Echo", "hi"), ("Kevin", "x" * 300)], "turn it off")
        lines = s.split("\n")
        self.assertEqual(lines[0], "Avatars in the room: Echo (host), Sage.")
        self.assertEqual(lines[1], "Kevin last spoke with: Sage.")
        self.assertEqual(lines[2], "Echo: hi")
        self.assertEqual(lines[3], "Kevin: " + "x" * 200)
        self.assertEqual(lines[4], "Kevin: turn it off")
        s2 = build_state(["Echo"], "Echo", None, [], "hello")
        self.assertEqual(s2, "Avatars in the room: Echo (host).\nKevin last spoke with: nobody.\nKevin: hello")

    def test_build_questions(self):
        q = build_questions(["Echo", "Sage"])
        self.assertEqual(set(q), {"addressed", "wants", "other"})
        self.assertEqual(q["addressed"]["criteria"]["echo"], "Kevin is speaking to Echo")
        self.assertIn("everyone", q["addressed"]["criteria"])
        self.assertEqual(q["other"]["criteria"]["sage"], "Sage")
        self.assertIn("none", q["other"]["criteria"])
        self.assertEqual(set(q["wants"]["criteria"]), {"answer", "converse", "relay"})
        for v in q.values():
            self.assertEqual(v["type"], "choice")

    def test_resolve_speaker(self):
        sc = ["Echo", "Sage", "Rex"]
        self.assertEqual(resolve_speaker("rex", "none", sc, "Echo", "Sage"), "rex")
        self.assertEqual(resolve_speaker("everyone", "none", sc, "Echo", None), "everyone")
        self.assertEqual(resolve_speaker("unclear", "none", sc, "Echo", "Sage"), "sage")
        self.assertEqual(resolve_speaker("unclear", "sage", sc, "Echo", "Sage"), "echo")
        self.assertEqual(resolve_speaker("unclear", "none", sc, "Echo", None), "echo")
        self.assertEqual(resolve_speaker("unclear", "echo", sc, "Echo", None), "sage")
        self.assertEqual(resolve_speaker("unclear", "echo", ["Echo", "Sage"], "Echo", "Echo"), "sage")


def stub_for(answers):
    def fetch(payload):
        return {"answers": {q: {"choice": max(p, key=p.get), "probabilities": p} for q, p in answers.items()}}
    return fetch


class ScoreTests(unittest.TestCase):
    def test_expected_rows(self):
        r = fd.generate_split(2, 1, "train")[0]
        e = r["expected"]
        good = {q: {e[q]: 0.9, "zzz": 0.1} for q in e}
        res = score.run([r], stub_for(good))
        self.assertEqual(res["all_three"], 1.0)
        bad = dict(good)
        bad["wants"] = {"zzz": 0.8, e["wants"]: 0.2}
        res = score.run([r], stub_for(bad))
        self.assertEqual(res["all_three"], 0.0)
        self.assertAlmostEqual(res["accuracy"]["addressed"], 1.0)
        self.assertEqual(len(res["misses"]), 1)
        self.assertAlmostEqual(res["mean_top_prob_wrong"], 0.8)

    def test_truth_rows_and_debatable(self):
        base = {"scene": ["Echo", "Sage"], "host": "Echo", "last": "Sage", "text": "turn off the lights",
                "grade": "easy", "truth": {"speaker": ["sage", "echo"], "intent": ["answer"], "target": ["none"]}}
        ans = {"addressed": {"unclear": 0.7, "echo": 0.3}, "wants": {"answer": 1.0}, "other": {"none": 1.0}}
        res = score.run([base], stub_for(ans))  # unclear resolves to last = sage
        self.assertEqual(res["all_three"], 1.0)
        self.assertIn("easy", res["by_group"])
        wrong = dict(base, truth={"speaker": ["echo"], "intent": ["answer"], "target": ["none"]})
        deb = dict(wrong, debatable=True)
        res = score.run([wrong, deb], stub_for(ans))
        self.assertEqual(res["counted"], 1)
        self.assertEqual(res["all_three"], 0.0)
        self.assertEqual(res["debatable_rows"], 1)
        self.assertEqual(len(res["misses"]), 2)

    def test_top_level_answers_and_errors(self):
        row = {"scene": ["Echo", "Sage"], "host": "Echo", "last": None, "text": "hi",
               "truth": {"speaker": ["echo"], "intent": ["answer"], "target": ["none"]}}
        flat = lambda p: {"addressed": {"probabilities": {"unclear": 1.0}}, "wants": {"choice": "answer"},
                          "other": {"probabilities": {"none": 1.0}}}
        self.assertEqual(score.run([row], flat)["all_three"], 1.0)

        def boom(p):
            raise OSError("down")
        res = score.run([row], boom)
        self.assertEqual(res["errors"], 1)
        self.assertEqual(res["all_three"], 0.0)

    def test_payload_omits_model(self):
        r = fd.generate_split(1, 1, "train")[0]
        self.assertNotIn("model", score.build_payload(r))
        self.assertEqual(score.build_payload(r, "m")["model"], "m")


if __name__ == "__main__":
    unittest.main()
