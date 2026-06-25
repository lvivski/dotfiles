"""Zero-credit tests for durable cross-run memory (memory.py / wf.memory / --memory).

    python3 -m unittest discover -s .local/lib/copilot_workflows/tests
"""
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.dirname(os.path.dirname(HERE))  # .local/lib
if LIB not in sys.path:
    sys.path.insert(0, LIB)

from copilot_workflows import Memory, Runtime  # noqa: E402
from copilot_workflows.sandbox import harness_globals  # noqa: E402

FAKE = os.path.join(HERE, "fake_copilot.py")
CLI = os.path.join(os.path.dirname(LIB), "bin", "cwf")  # .local/bin/cwf


def _ensure_exec(path):
    st = os.stat(path)
    os.chmod(path, st.st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _slurp(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


class Base(unittest.TestCase):
    def tmpdir(self):
        d = tempfile.mkdtemp(prefix="cwf-mem-test-")
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        return d


class TestMemoryUnit(Base):
    def test_disabled_is_noop(self):
        m = Memory(None)
        self.assertFalse(m.enabled)
        self.assertFalse(bool(m))
        self.assertEqual(m.read(), "")
        m.append("ignored")   # must not raise
        m.write("ignored")
        m.clear()
        self.assertEqual(m.read(), "")

    def test_write_read_roundtrip_and_overwrite(self):
        p = os.path.join(self.tmpdir(), "notes.md")
        m = Memory(p)
        self.assertTrue(m.enabled)
        m.write("hello")
        self.assertEqual(m.read(), "hello")
        m.write("replaced")
        self.assertEqual(m.read(), "replaced")

    def test_append_adds_trailing_newline_and_accumulates(self):
        p = os.path.join(self.tmpdir(), "notes.md")
        m = Memory(p)
        m.append("a")
        m.append("b\n")   # already terminated -> no double newline
        m.append("c")
        self.assertEqual(m.read(), "a\nb\nc\n")

    def test_clear(self):
        p = os.path.join(self.tmpdir(), "notes.md")
        m = Memory(p)
        m.append("x")
        m.clear()
        self.assertEqual(m.read(), "")

    def test_creates_parent_dirs(self):
        p = os.path.join(self.tmpdir(), "deep", "nested", "state.md")
        m = Memory(p)
        m.append("here")
        self.assertTrue(os.path.isfile(p))
        self.assertEqual(m.read(), "here\n")

    def test_read_missing_file_is_empty(self):
        p = os.path.join(self.tmpdir(), "absent.md")
        self.assertEqual(Memory(p).read(), "")

    def test_dry_run_is_read_only(self):
        p = os.path.join(self.tmpdir(), "notes.md")
        Memory(p).write("seed")              # real writer seeds content
        ro = Memory(p, read_only=True)
        self.assertEqual(ro.read(), "seed")  # reads still reflect real content
        ro.append("nope")
        ro.write("nope")
        ro.clear()
        self.assertEqual(ro.read(), "seed")  # writes suppressed

    def test_persists_across_instances_like_loop_ticks(self):
        # Two Memory objects over the same path simulate two `cwf loop` ticks (each a
        # fresh run with its own checkpoints, but the SAME memory file).
        p = os.path.join(self.tmpdir(), "sweep.md")
        Memory(p).append("tick-1 finding")
        tick2 = Memory(p)
        self.assertIn("tick-1 finding", tick2.read())
        tick2.append("tick-2 finding")
        self.assertEqual(Memory(p).read(), "tick-1 finding\ntick-2 finding\n")

    def test_concurrent_appends_do_not_corrupt(self):
        p = os.path.join(self.tmpdir(), "notes.md")
        m = Memory(p)
        n = 50

        def worker(i):
            m.append("line-%02d" % i)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        lines = [ln for ln in m.read().splitlines() if ln]
        self.assertEqual(len(lines), n)
        self.assertEqual(sorted(lines), sorted("line-%02d" % i for i in range(n)))


class TestMemoryViaRuntime(Base):
    def test_runtime_exposes_wf_memory(self):
        p = os.path.join(self.tmpdir(), "m.md")
        rt = Runtime(copilot_bin="x", memory_path=p)
        rt.memory.append("from harness")
        self.assertEqual(rt.memory.read(), "from harness\n")

    def test_runtime_without_memory_is_disabled(self):
        rt = Runtime(copilot_bin="x")
        self.assertFalse(rt.memory.enabled)
        self.assertEqual(rt.memory.read(), "")

    def test_dry_run_runtime_memory_is_read_only(self):
        p = os.path.join(self.tmpdir(), "m.md")
        Memory(p).write("seed")
        rt = Runtime(copilot_bin="x", memory_path=p, dry_run=True)
        rt.memory.append("nope")
        self.assertEqual(rt.memory.read(), "seed")

    def test_restricted_harness_can_use_memory(self):
        # A restricted harness has no open()/os, but wf.memory still works because the
        # runtime owns the file I/O.
        p = os.path.join(self.tmpdir(), "m.md")
        Memory(p).append("prior tick")
        rt = Runtime(copilot_bin="x", memory_path=p, restricted=True)
        g = harness_globals(rt, args=None, file="h.py", restricted=True)
        src = (
            "prior = wf.memory.read()\n"
            "assert 'prior tick' in prior\n"
            "wf.memory.append('new note')\n"
        )
        exec(compile(src, "h.py", "exec"), g)
        self.assertEqual(rt.memory.read(), "prior tick\nnew note\n")


class TestMemoryCLI(Base):
    @classmethod
    def setUpClass(cls):
        _ensure_exec(FAKE)

    def test_cli_loop_accumulates_memory_across_ticks(self):
        if not os.path.isfile(CLI):
            self.skipTest("cwf CLI not found at %s" % CLI)
        d = self.tmpdir()
        mem = os.path.join(d, "state.md")
        harness = os.path.join(d, "h.cwf.py")
        # Each tick reads memory, then appends one line tagged with the prior count, so the
        # file must grow by exactly one line per tick if --memory persists across ticks.
        with open(harness, "w") as fh:
            fh.write(
                "prior = wf.memory.read()\n"
                "n = len([l for l in prior.splitlines() if l])\n"
                "r = wf.agent('[[FAKE:{\"_content\": \"ok\"}]]')\n"
                "wf.memory.append('tick after %d prior' % n)\n"
                "print('count', n)\n"
            )
        env = dict(os.environ, CWF_RUNS_DIR=os.path.join(d, "runs"))
        proc = subprocess.run(
            [sys.executable, CLI, "loop", harness, "--every", "0s", "--max-runs", "3",
             "--memory", mem, "--copilot-bin", FAKE, "--disable-mcp"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, timeout=120,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = [l for l in _slurp(mem).splitlines() if l]
        self.assertEqual(lines, [
            "tick after 0 prior",
            "tick after 1 prior",
            "tick after 2 prior",
        ], "memory should accumulate one line per loop tick; got:\n%s\nstderr:\n%s"
            % (lines, proc.stderr))

    def test_cli_dry_run_does_not_mutate_memory(self):
        if not os.path.isfile(CLI):
            self.skipTest("cwf CLI not found at %s" % CLI)
        d = self.tmpdir()
        mem = os.path.join(d, "state.md")
        Memory(mem).write("seed\n")
        harness = os.path.join(d, "h.cwf.py")
        with open(harness, "w") as fh:
            fh.write("wf.memory.append('should not persist')\nprint('planned')\n")
        proc = subprocess.run(
            [sys.executable, CLI, "run", harness, "--dry-run", "--memory", mem,
             "--copilot-bin", FAKE],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=60,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(_slurp(mem), "seed\n")


if __name__ == "__main__":
    unittest.main()
