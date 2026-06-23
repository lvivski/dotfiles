"""Phase 3 durability & cost tests: checkpoint/resume, worktrees, graceful budget.

Zero credits — subagents use tests/fake_copilot.py; worktree tests use a throwaway
git repo and the real `git` CLI only.

    python3 -m unittest discover -s .local/lib/copilot_workflows/tests
"""
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.dirname(os.path.dirname(HERE))  # .local/lib
if LIB not in sys.path:
    sys.path.insert(0, LIB)

from copilot_workflows import (  # noqa: E402
    AgentResult,
    CheckpointStore,
    Runtime,
    WorktreeManager,
    find_repo_root,
)

FAKE = os.path.join(HERE, "fake_copilot.py")


def _ensure_exec(path):
    st = os.stat(path)
    os.chmod(path, st.st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        _ensure_exec(FAKE)

    def tmpdir(self):
        d = tempfile.mkdtemp(prefix="cwf-test-")
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        return d

    def rt(self, run_dir, store, **kw):
        kw.setdefault("copilot_bin", FAKE)
        kw.setdefault("default_model", "fake")
        return Runtime(run_dir=run_dir, checkpoints=store, **kw)


class TestCheckpointStore(Base):
    def test_roundtrip_and_resume(self):
        d = self.tmpdir()
        s = CheckpointStore(d, resume=False)
        r = AgentResult(content="hi", session_id="s1", premium_requests=0.5,
                        output_tokens=3, exit_code=0, model="m")
        s.put("k1", r)
        self.assertEqual(s.count, 1)
        self.assertEqual(s.get("k1").content, "hi")

        # a fresh instance over the same dir, resuming, sees the cached result
        s2 = CheckpointStore(d, resume=True)
        got = s2.get("k1")
        self.assertIsNotNone(got)
        self.assertEqual(got.content, "hi")
        self.assertTrue(got.cached)
        self.assertAlmostEqual(s2.prior_spent, 0.5)

    def test_no_resume_starts_empty(self):
        d = self.tmpdir()
        CheckpointStore(d, resume=False).put("k", AgentResult(
            content="x", session_id=None, premium_requests=0.1, output_tokens=1, exit_code=0))
        fresh = CheckpointStore(d, resume=False)  # resume=False ignores prior file
        self.assertIsNone(fresh.get("k"))
        self.assertEqual(fresh.prior_spent, 0.0)


class TestResume(Base):
    def test_completed_agent_is_cached(self):
        d = self.tmpdir()
        wf1 = self.rt(d, CheckpointStore(d, resume=False))
        r1 = wf1.agent("hello unique-A")
        self.assertFalse(r1.cached)
        self.assertAlmostEqual(wf1.spent, 0.01)

        wf2 = self.rt(d, CheckpointStore(d, resume=True))
        r2 = wf2.agent("hello unique-A")
        self.assertTrue(r2.cached)
        # prior spend carried over; cache hit adds no new charge
        self.assertAlmostEqual(wf2.spent, 0.01)
        self.assertEqual([r for r in wf2.results if not r.cached], [])

    def test_occurrence_indexing(self):
        d = self.tmpdir()
        wf1 = self.rt(d, CheckpointStore(d, resume=False))
        wf1.agent("same prompt")
        wf1.agent("same prompt")  # identical -> distinct slot
        store1 = wf1.checkpoints
        self.assertEqual(store1.count, 2)

        wf2 = self.rt(d, CheckpointStore(d, resume=True))
        a = wf2.agent("same prompt")
        b = wf2.agent("same prompt")
        self.assertTrue(a.cached and b.cached)
        c = wf2.agent("same prompt")  # third slot never stored -> runs fresh
        self.assertFalse(c.cached)

    def test_failed_agent_not_cached(self):
        d = self.tmpdir()
        wf = self.rt(d, CheckpointStore(d, resume=False))
        wf.agent("boom [[FAKE:{\"_exit\": 2}]]")
        self.assertEqual(wf.checkpoints.count, 0)  # only successful results persist


class TestGracefulBudget(Base):
    def test_skips_after_budget(self):
        d = self.tmpdir()
        # concurrency=1 makes the drain deterministic: 0,1,2 run (0.03), rest skip
        wf = self.rt(d, CheckpointStore(d, resume=False), budget=0.025, concurrency=1)
        out = wf.fan_out(list(range(10)), lambda x: wf.agent("n%d" % x))
        ok = [r for r in out if r.ok]
        skipped = [r for r in out if not r.ok]
        self.assertEqual(len(ok), 3)
        self.assertEqual(len(skipped), 7)
        self.assertTrue(wf.budget_hit)
        self.assertLessEqual(wf.spent, 0.031)
        self.assertIn("budget", skipped[0].error)


class TestWorktree(Base):
    def _make_repo(self):
        d = self.tmpdir()
        subprocess.run(["git", "init", "-q", d], check=True)
        with open(os.path.join(d, "f.txt"), "w") as fh:
            fh.write("hello\n")
        subprocess.run(["git", "-C", d, "add", "."], check=True)
        subprocess.run(
            ["git", "-C", d, "-c", "user.email=t@t", "-c", "user.name=t",
             "commit", "-q", "-m", "init"], check=True)
        return d

    def test_create_idempotent_remove(self):
        repo = self._make_repo()
        root = find_repo_root(repo)
        self.assertEqual(os.path.realpath(root), os.path.realpath(repo))
        mgr = WorktreeManager(root, self.tmpdir())  # base dir outside the repo
        p = mgr.create("branch-1")
        self.assertTrue(os.path.isdir(p))
        self.assertTrue(os.path.isfile(os.path.join(p, "f.txt")))
        self.assertEqual(mgr.create("branch-1"), p)  # idempotent
        mgr.remove(p)
        self.assertFalse(os.path.exists(p))
        mgr.cleanup_all()

    def test_runtime_worktree_context(self):
        repo = self._make_repo()
        root = find_repo_root(repo)
        wf = Runtime(copilot_bin=FAKE, default_model="fake",
                     run_dir=self.tmpdir(), repo_root=root)
        with wf.worktree("ctx-1") as path:
            self.assertTrue(os.path.isdir(path))
            captured = path
        self.assertFalse(os.path.exists(captured))  # removed on block exit
        wf.cleanup()

    def test_worktree_requires_git(self):
        d = self.tmpdir()  # not a git repo
        wf = Runtime(copilot_bin=FAKE, default_model="fake", run_dir=d, repo_root=None)
        # force detection from a non-repo dir
        cwd = os.getcwd()
        os.chdir(d)
        try:
            with self.assertRaises(RuntimeError):
                wf.worktree("x").__enter__()
        finally:
            os.chdir(cwd)


if __name__ == "__main__":
    unittest.main(verbosity=2)
