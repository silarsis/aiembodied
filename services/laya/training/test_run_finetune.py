"""Tests for run_finetune.py that need neither torch nor laya (and never touch the real hold-out files)."""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import floor_data as fd  # noqa: E402
import run_finetune as rf  # noqa: E402


def acc(a, w, o, all3):
    return {"addressed": a, "wants": w, "other": o}, all3


def fake_set(all3, misses=()):
    return {"rows": 10, "counted": 10, "accuracy": {"addressed": 0.99, "wants": 0.98, "other": 0.97},
            "all_three": all3, "mean_top_prob_right": 0.9, "mean_top_prob_wrong": 0.6,
            "latency_median": 0.02, "misses": list(misses)}


def fake_miss(text, top, counted=True):
    return {"text": text, "group": "g", "counted": counted,
            "expected": {"addressed": ["lenha"], "wants": ["answer"], "other": ["none"]},
            "got": {"addressed": "everyone", "wants": "answer", "other": "none"},
            "raw": {"addressed": {"key": "everyone", "top": top, "probabilities": {"everyone": top}}},
            "error": None}


def fake_results(floor, fresh, misses=()):
    return {"val": fake_set(0.99), "holdout_floor": fake_set(floor, misses), "holdout_fresh": fake_set(fresh),
            "latency": {"device": "cuda", "device_median": 0.01, "cpu_median": 0.05}}


class ArgsTests(unittest.TestCase):
    def test_defaults(self):
        a = rf.parse_args(["--work", "w"])
        self.assertEqual((a.n, a.seed, a.epochs, a.precision, a.loss, a.device, a.micro_batch),
                         (8000, 0, 4, "auto", "rlcd", "auto", 8))
        self.assertEqual(a.base, "convaiinnovations/laya")
        self.assertFalse(a.trial or a.skip_baseline or a.math_attention)

    def test_flags(self):
        a = rf.parse_args(["--work", "w", "--trial", "--skip-baseline", "--math-attention", "--precision", "fp32",
                           "--loss", "soft-ce", "--epochs", "2", "--device", "cpu", "--micro-batch", "4"])
        self.assertTrue(a.trial and a.skip_baseline and a.math_attention)
        self.assertEqual((a.precision, a.loss, a.epochs, a.device, a.micro_batch), ("fp32", "soft-ce", 2, "cpu", 4))

    def test_rejects_bad(self):
        for bad in (["--work", "w", "--precision", "fp8"], ["--work", "w", "--loss", "x"], [],
                    ["--work", "w", "--micro-batch", "5"], ["--work", "w", "--epochs", "0"]):
            with self.assertRaises(SystemExit):
                rf.parse_args(bad)


class PrecisionTests(unittest.TestCase):
    def test_auto(self):
        self.assertEqual(rf.choose_precision("auto", True, True), "bf16")
        self.assertEqual(rf.choose_precision("auto", True, False), "fp16")
        self.assertEqual(rf.choose_precision("auto", False, False), "fp32")

    def test_explicit(self):
        self.assertEqual(rf.choose_precision("fp16", True, True), "fp16")
        self.assertEqual(rf.choose_precision("bf16", True, True), "bf16")
        self.assertEqual(rf.choose_precision("bf16", True, False), "fp16")
        self.assertEqual(rf.choose_precision("fp32", True, True), "fp32")
        self.assertEqual(rf.choose_precision("fp16", False, False), "fp32")

    def test_fallback_order(self):
        self.assertEqual(rf.next_try("fp16", False, "rlcd"), "--precision bf16")
        self.assertEqual(rf.next_try("fp16", False, "rlcd", bf16_supported=False), "--precision fp32")
        self.assertEqual(rf.next_try("bf16", False, "rlcd"), "--precision fp32")
        self.assertEqual(rf.next_try("fp32", False, "rlcd"), "--math-attention")
        self.assertEqual(rf.next_try("fp32", True, "rlcd"), "--loss soft-ce")
        self.assertIsNone(rf.next_try("fp32", True, "soft-ce"))


class VerdictTests(unittest.TestCase):
    def test_pass(self):
        self.assertEqual(rf.verdict(fake_results(0.95, 0.97)), "PASS")

    def test_needs_work(self):
        self.assertEqual(rf.verdict(fake_results(0.949, 0.99)), "NEEDS WORK")
        self.assertEqual(rf.verdict(fake_results(0.99, 0.5)), "NEEDS WORK")
        self.assertEqual(rf.verdict({}), "NEEDS WORK")
        self.assertEqual(rf.verdict(fake_results(float("nan"), 0.99)), "NEEDS WORK")


class EstimateTests(unittest.TestCase):
    def test_scales_with_rows(self):
        per_epoch, total = rf.estimate_full_run(20.0, 180, 8000, 4)
        self.assertAlmostEqual(per_epoch, 20.0 / 180 * 7600)
        self.assertAlmostEqual(total, per_epoch * 4)


class ReportTests(unittest.TestCase):
    def test_render(self):
        misses = [fake_miss("low | one", 0.6), fake_miss("high one", 0.99), fake_miss("debatable", 0.999, counted=False)]
        res = fake_results(0.96, 0.9, misses)
        info = {"args": {"loss": "rlcd", "epochs": 4, "n": 8000, "seed": 0, "base": "b", "math_attention": False},
                "precision": "bf16", "device_text": "Test GPU, 12.0 GB", "versions": {"torch": "2.x", "laya": "0.4.31"},
                "timings": {"Train": 3600.0}, "epoch_seconds": [900.0, 880.0], "baseline": fake_results(0.5, 0.4),
                "results": res, "worst": rf.worst_misses(res), "checkpoint": {"path": "/x/checkpoint", "size_mb": 600.1}}
        text = rf.render_report(info)
        self.assertIn("**Verdict: NEEDS WORK**", text)
        self.assertIn("| hold-out floor | **all three** | 50.0% | **96.0%** |", text)
        self.assertIn("/x/checkpoint", text)
        self.assertIn("low / one", text)  # pipe escaped
        self.assertNotIn("| debatable |", text)
        self.assertLess(text.index("high one"), text.index("low / one"))  # most confident first
        self.assertNotIn(chr(0x2014), text)

    def test_pass_render_without_baseline(self):
        info = {"args": {}, "results": fake_results(0.97, 0.96), "baseline": None, "worst": [],
                "checkpoint": {"path": "p", "size_mb": 1}}
        text = rf.render_report(info)
        self.assertIn("**Verdict: PASS**", text)
        self.assertIn("None.", text)

    def test_nonfinite_detected(self):
        bad = fake_set(0.5, [fake_miss("x", float("nan"))])
        self.assertIn("non-finite", rf.result_nonfinite(bad))
        self.assertIsNone(rf.result_nonfinite(fake_set(0.9)))


class ExcludeTests(unittest.TestCase):
    def test_both_holdout_files_are_excluded(self):
        with tempfile.TemporaryDirectory() as d:
            a, b = os.path.join(d, "a.jsonl"), os.path.join(d, "b.jsonl")
            with open(a, "w", encoding="utf-8") as f:
                f.write(json.dumps({"meta": {"text": "Fake alpha line, please"}}) + "\n")
                f.write(json.dumps({"text": "Fake beta line"}))  # no trailing newline
            with open(b, "w", encoding="utf-8") as f:
                f.write(json.dumps({"text": "Fake gamma line"}) + "\n\n")
            dest = os.path.join(d, "all.jsonl")
            self.assertEqual(rf.build_exclude_file([a, b], dest), 3)
            self.assertEqual(rf.count_lines(dest), 3)
            excl = fd.load_exclude(dest)
            for t in ("Fake alpha line, please", "Fake beta line", "Fake gamma line"):
                self.assertIn(fd.norm(t), excl)

    def test_real_holdout_paths_are_next_to_script(self):
        for p in rf.HOLDOUT_FILES:
            self.assertEqual(os.path.dirname(p), os.path.dirname(os.path.abspath(rf.__file__)))
        self.assertEqual([os.path.basename(p) for p in rf.HOLDOUT_FILES], ["holdout_floor.jsonl", "holdout_fresh.jsonl"])


class ScoreDatasetTests(unittest.TestCase):
    def test_injected_fetch_and_error_handling(self):
        rows = fd.generate_split(20, 1, "val")
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "v.jsonl")
            with open(p, "w", encoding="utf-8") as f:
                for r in rows:
                    f.write(json.dumps(r) + "\n")
            by_text = {r["meta"]["text"]: r["expected"] for r in rows}

            def oracle(payload):
                text = payload["state"].splitlines()[-1] if isinstance(payload["state"], str) else ""
                exp = next((e for t, e in by_text.items() if t in payload["state"]), None)
                return {"answers": {q: {"choice": exp[q], "probabilities": {exp[q]: 0.9}} for q in rf.QIDS}}
            res = rf.score_dataset(oracle, p, limit=10)
            self.assertEqual(res["rows"], 10)
            self.assertEqual(res["all_three"], 1.0)

            def boom(payload):
                raise RuntimeError("nope")
            with self.assertRaises(rf.StepFailed):
                rf.score_dataset(boom, p)

            def nan(payload):
                return {"answers": {q: {"choice": "x", "probabilities": {"x": float("nan")}} for q in rf.QIDS}}
            with self.assertRaises(rf.NonFiniteError):
                rf.score_dataset(nan, p)


class MiscTests(unittest.TestCase):
    def test_install_help_mentions_pinned_version(self):
        self.assertIn('laya[serve]==0.4.31', rf.install_help("linux"))
        self.assertIn("Scripts", rf.install_help("win32"))
        self.assertIn("cu128", rf.install_help("win32"))

    def test_tee(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "t.log")
            with rf.tee_output(p):
                print("hello tee")
            with open(p, encoding="utf-8") as f:
                self.assertIn("hello tee", f.read())


class BadRunTests(unittest.TestCase):
    def test_fp16_skips(self):
        self.assertIsNone(rf.bad_run(100, 10, 100, 0, "fp16"))
        self.assertIsNone(rf.bad_run(20, 5, 20, 0, "fp16"))
        self.assertIn("bad gradients on most updates", rf.bad_run(100, 11, 100, 0, "fp16"))
        self.assertIn("bad gradients", rf.bad_run(10, 6, 10, 0, "fp16"))

    def test_fp16_ignores_bad_grad_steps(self):
        self.assertIsNone(rf.bad_run(100, 0, 100, 50, "fp16"))

    def test_fp32_bad_grad_steps(self):
        self.assertIsNone(rf.bad_run(0, 0, 40, 5, "fp32"))
        self.assertIsNone(rf.bad_run(0, 0, 100, 10, "fp32"))
        self.assertIn("bad gradients", rf.bad_run(0, 0, 100, 11, "fp32"))
        self.assertIn("bad gradients", rf.bad_run(0, 0, 10, 6, "bf16"))

    def test_error_is_nonfinite(self):
        self.assertTrue(issubclass(rf.BadGradientsError, rf.NonFiniteError))


if __name__ == "__main__":
    unittest.main()
