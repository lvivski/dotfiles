"""Phase 4 progress tests: Runtime event emission, ProgressReporter, cwf runs/watch.

Zero AIC — agents use tests/fake_copilot.py; CLI tests shell out to cwf with
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
        kw.setdefault("model", "fake")
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
        self.assertEqual(end["nano_aiu"], 10_000_000)

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
        path = os.path.join(d, "progress.jsonl")
        rep = ProgressReporter(stream=io.StringIO(), jsonl_path=path, live=False)
        rep({"ev": "start", "seq": 1, "label": "a", "t": 0})
        rep({"ev": "end", "seq": 1, "label": "a", "ok": True, "cached": False,
             "skipped": False, "nano_aiu": 330_000_000, "tok": 10, "t": 1})
        rep({"ev": "end", "seq": 2, "label": "b", "ok": False, "cached": False,
             "skipped": False, "nano_aiu": 0, "tok": 0, "error": "boom", "t": 1})
        rep({"ev": "end", "seq": 3, "label": "c", "ok": True, "cached": True,
             "skipped": False, "nano_aiu": 330_000_000, "tok": 0, "t": 1})
        rep({"ev": "end", "seq": 4, "label": "d", "ok": False, "cached": False,
             "skipped": True, "nano_aiu": 0, "tok": 0, "t": 1})
        st = rep.stats
        self.assertEqual(st["done"], 1)
        self.assertEqual(st["failed"], 1)
        self.assertEqual(st["cached"], 1)
        self.assertEqual(st["skipped"], 1)
        self.assertAlmostEqual(st["aic"], 0.66)
        rep.close()
        with open(path) as fh:
            lines = [json.loads(ln) for ln in fh if ln.strip()]
        self.assertEqual(len(lines), 5)

    def test_live_render_no_crash(self):
        buf = io.StringIO()
        rep = ProgressReporter(stream=buf, live=True, write=False, title="t")
        rep({"ev": "start", "seq": 1, "label": "agent-one", "model": "m", "t": 0})
        rep({"ev": "end", "seq": 1, "label": "agent-one", "ok": True, "cached": False,
             "skipped": False, "nano_aiu": 100_000_000, "tok": 5, "t": 1})
        rep.close()
        out = buf.getvalue()
        self.assertIn("done", out)        # summary line rendered
        self.assertIn("\x1b[", out)       # ANSI control sequences emitted

    def test_replay_from_file(self):
        d = tempfile.mkdtemp(prefix="cwf-prog-")
        path = os.path.join(d, "progress.jsonl")
        with open(path, "w") as fh:
            fh.write(json.dumps({"ev": "run_start", "t": 0}) + "\n")
            fh.write(json.dumps({"ev": "start", "seq": 1, "label": "a", "t": 0}) + "\n")
            fh.write(json.dumps({"ev": "end", "seq": 1, "label": "a", "ok": True,
                                 "cached": False, "skipped": False, "nano_aiu": 200_000_000,
                                 "tok": 3, "t": 1}) + "\n")
            fh.write(json.dumps({"ev": "run_end", "agents": 1, "nano_aiu": 200_000_000,
                                 "failed": 0, "t": 2}) + "\n")
        rep = replay(path, follow=False,
                     reporter=ProgressReporter(stream=io.StringIO(), live=False, write=False))
        self.assertEqual(rep.stats["done"], 1)
        self.assertAlmostEqual(rep.stats["aic"], 0.2)

    def test_failed_line_includes_aic(self):
        line = ProgressReporter(stream=io.StringIO(), live=False, write=False)._fmt_line({
            "ev": "end", "label": "bad", "ok": False, "cached": False,
            "skipped": False, "nano_aiu": 500_000_000, "tok": 0, "error": "boom",
        })
        self.assertIn("0.5000 AIC", line)
        self.assertIn("ERROR: boom", line)


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
        self.assertTrue(os.path.isfile(os.path.join(runs, "t1", "progress.jsonl")))
        with open(os.path.join(runs, "t1", "progress.jsonl"), encoding="utf-8") as fh:
            events = [json.loads(line) for line in fh if line.strip()]
        run_end = [e for e in events if e.get("ev") == "run_end"][-1]
        self.assertEqual(run_end["run_id"], "t1")
        self.assertEqual(run_end["agents"], 3)
        self.assertEqual(run_end["launched"], 3)
        self.assertEqual(run_end["cached"], 0)
        self.assertEqual(run_end["skipped"], 0)
        self.assertEqual(run_end["nano_aiu"], 30_000_000)
        self.assertEqual(run_end["launched_nano_aiu"], 30_000_000)
        self.assertIn("elapsed", run_end)

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

    def test_runs_reports_failed_agent_spend_from_progress(self):
        runs = tempfile.mkdtemp(prefix="cwf-cli-")
        harness = os.path.join(runs, "fail-agent.py")
        with open(harness, "w", encoding="utf-8") as fh:
            fh.write('wf.agent(\'boom [[FAKE:{"_exit": 2, "_cr": 0.5}]]\')\n')

        run = subprocess.run(
            [sys.executable, CWF, "run", harness, "--copilot-bin", FAKE,
             "--runs-dir", runs, "--run-id", "failed-agent", "--quiet"],
            capture_output=True, text=True)
        self.assertEqual(run.returncode, 4, run.stderr)

        listing = subprocess.run(
            [sys.executable, CWF, "runs", "--runs-dir", runs],
            capture_output=True, text=True)
        self.assertEqual(listing.returncode, 0, listing.stderr)
        self.assertIn("failed-agent", listing.stdout)
        self.assertIn("     1", listing.stdout)
        self.assertIn("     0.5", listing.stdout)

    def test_dry_run_displays_static_meta(self):
        runs = tempfile.mkdtemp(prefix="cwf-cli-")
        harness = os.path.join(runs, "meta.py")
        with open(harness, "w", encoding="utf-8") as fh:
            fh.write("META = {'name': 'meta-demo', 'description': 'demo flow', "
                     "'phases': ['plan', 'act']}\nprint('ok')\n")

        run = subprocess.run(
            [sys.executable, CWF, "run", harness, "--dry-run"],
            capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("workflow: meta-demo", run.stderr)
        self.assertIn("phases: plan, act", run.stderr)
        self.assertIn("ok", run.stdout)

    def test_cli_restricted_blocks_imports(self):
        runs = tempfile.mkdtemp(prefix="cwf-cli-")
        harness = os.path.join(runs, "restricted.py")
        with open(harness, "w", encoding="utf-8") as fh:
            fh.write("import os\n")

        run = subprocess.run(
            [sys.executable, CWF, "run", harness, "--restricted", "--runs-dir", runs,
             "--run-id", "restricted", "--quiet"],
            capture_output=True, text=True)
        self.assertEqual(run.returncode, 2)
        self.assertIn("blocked by restricted mode", run.stderr)

    def test_loop_max_runs(self):
        runs = tempfile.mkdtemp(prefix="cwf-cli-")
        harness = os.path.join(runs, "loop.py")
        with open(harness, "w", encoding="utf-8") as fh:
            fh.write("print('tick')\n")

        run = subprocess.run(
            [sys.executable, CWF, "loop", harness, "--every", "0s", "--max-runs", "2",
             "--runs-dir", runs, "--quiet"],
            capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.stdout.count("tick"), 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
