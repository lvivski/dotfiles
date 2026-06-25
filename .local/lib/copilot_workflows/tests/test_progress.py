"""Phase 4 progress tests: Runtime event emission, ProgressReporter, cwf runs/watch.

Zero credits — agents use tests/fake_copilot.py; CLI tests shell out to cwf with
the fake binary.

    python3 -m unittest discover -s .local/lib/copilot_workflows/tests
"""
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.dirname(os.path.dirname(HERE))     # .local/lib
REPO = os.path.dirname(os.path.dirname(LIB))     # repo root (.local/.. )
CWF = os.path.join(REPO, ".local", "bin", "cwf")
HELLO = os.path.join(LIB, "copilot_workflows", "examples", "hello.py")
if LIB not in sys.path:
    sys.path.insert(0, LIB)

from copilot_workflows import ProgressReporter, Runtime, replay  # noqa: E402

FAKE = os.path.join(HERE, "fake_copilot.py")


def _ensure_exec(path):
    st = os.stat(path)
    os.chmod(path, st.st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


class TestRuntimeEmits(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        _ensure_exec(FAKE)

    def rt(self, recs, **kw):
        kw.setdefault("copilot_bin", FAKE)
        kw.setdefault("default_model", "fake")
        return Runtime(progress=recs.append, **kw)

    def test_start_end_pair(self):
        recs = []
        wf = self.rt(recs)
        wf.agent("hello", label="greeter")
        self.assertEqual([r["ev"] for r in recs], ["start", "end"])
        self.assertEqual(recs[0]["seq"], recs[1]["seq"])
        end = recs[1]
        self.assertEqual(end["label"], "greeter")
        self.assertTrue(end["ok"])
        self.assertFalse(end["cached"])
        self.assertFalse(end["skipped"])
        self.assertAlmostEqual(end["cr"], 0.01)

    def test_phase_tagging(self):
        recs = []
        wf = self.rt(recs)
        with wf.phase("port-files"):
            wf.agent("x")
        self.assertEqual(recs[0]["phase"], "port-files")
        wf.agent("y")  # phase cleared after the block
        self.assertIsNone(recs[-1]["phase"])

    def test_fan_out_emits_each_branch(self):
        recs = []
        wf = self.rt(recs)
        wf.fan_out([1, 2, 3], lambda n: wf.agent("n%d" % n))
        ends = [r for r in recs if r["ev"] == "end"]
        self.assertEqual(len(ends), 3)


class TestProgressReporter(unittest.TestCase):
    def test_counters_and_persistence(self):
        d = tempfile.mkdtemp(prefix="cwf-prog-")
        path = os.path.join(d, "progress.ndjson")
        rep = ProgressReporter(stream=io.StringIO(), ndjson_path=path, live=False)
        rep({"ev": "start", "seq": 1, "label": "a", "t": 0})
        rep({"ev": "end", "seq": 1, "label": "a", "ok": True, "cached": False,
             "skipped": False, "cr": 0.33, "tok": 10, "t": 1})
        rep({"ev": "end", "seq": 2, "label": "b", "ok": False, "cached": False,
             "skipped": False, "cr": 0.0, "tok": 0, "error": "boom", "t": 1})
        rep({"ev": "end", "seq": 3, "label": "c", "ok": True, "cached": True,
             "skipped": False, "cr": 0.33, "tok": 0, "t": 1})
        rep({"ev": "end", "seq": 4, "label": "d", "ok": False, "cached": False,
             "skipped": True, "cr": 0.0, "tok": 0, "t": 1})
        st = rep.stats
        self.assertEqual(st["done"], 1)
        self.assertEqual(st["failed"], 1)
        self.assertEqual(st["cached"], 1)
        self.assertEqual(st["skipped"], 1)
        self.assertAlmostEqual(st["cr"], 0.66)
        rep.close()
        with open(path) as fh:
            lines = [json.loads(ln) for ln in fh if ln.strip()]
        self.assertEqual(len(lines), 5)

    def test_live_render_no_crash(self):
        buf = io.StringIO()
        rep = ProgressReporter(stream=buf, live=True, write=False, title="t")
        rep({"ev": "start", "seq": 1, "label": "agent-one", "model": "m", "t": 0})
        rep({"ev": "end", "seq": 1, "label": "agent-one", "ok": True, "cached": False,
             "skipped": False, "cr": 0.1, "tok": 5, "t": 1})
        rep.close()
        out = buf.getvalue()
        self.assertIn("done", out)        # summary line rendered
        self.assertIn("\x1b[", out)       # ANSI control sequences emitted

    def test_replay_from_file(self):
        d = tempfile.mkdtemp(prefix="cwf-prog-")
        path = os.path.join(d, "progress.ndjson")
        with open(path, "w") as fh:
            fh.write(json.dumps({"ev": "run_start", "t": 0}) + "\n")
            fh.write(json.dumps({"ev": "start", "seq": 1, "label": "a", "t": 0}) + "\n")
            fh.write(json.dumps({"ev": "end", "seq": 1, "label": "a", "ok": True,
                                 "cached": False, "skipped": False, "cr": 0.2, "tok": 3, "t": 1}) + "\n")
            fh.write(json.dumps({"ev": "run_end", "agents": 1, "cr": 0.2, "failed": 0, "t": 2}) + "\n")
        rep = replay(path, follow=False,
                     reporter=ProgressReporter(stream=io.StringIO(), live=False, write=False))
        self.assertEqual(rep.stats["done"], 1)
        self.assertAlmostEqual(rep.stats["cr"], 0.2)


class TestCwfCli(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        _ensure_exec(FAKE)

    def test_run_then_runs_then_watch(self):
        runs = tempfile.mkdtemp(prefix="cwf-cli-")
        run = subprocess.run(
            [sys.executable, CWF, "run", HELLO, "--copilot-bin", FAKE,
             "--runs-dir", runs, "--run-id", "t1", "--quiet"],
            capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertTrue(os.path.isfile(os.path.join(runs, "t1", "progress.ndjson")))

        listing = subprocess.run(
            [sys.executable, CWF, "runs", "--runs-dir", runs],
            capture_output=True, text=True)
        self.assertEqual(listing.returncode, 0, listing.stderr)
        self.assertIn("t1", listing.stdout)
        self.assertIn("hello.py", listing.stdout)

        watch = subprocess.run(
            [sys.executable, CWF, "watch", "t1", "--runs-dir", runs, "--no-follow"],
            capture_output=True, text=True)
        self.assertEqual(watch.returncode, 0, watch.stderr)

    def test_harness_system_exit_sets_status(self):
        runs = tempfile.mkdtemp(prefix="cwf-cli-")
        harness = os.path.join(runs, "exit.py")
        with open(harness, "w", encoding="utf-8") as fh:
            fh.write("raise SystemExit(7)\n")

        run = subprocess.run(
            [sys.executable, CWF, "run", harness, "--copilot-bin", FAKE,
             "--runs-dir", runs, "--run-id", "exit", "--quiet"],
            capture_output=True, text=True)
        self.assertEqual(run.returncode, 7, run.stderr)
        self.assertNotIn("harness raised", run.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
