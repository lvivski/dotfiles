"""Phase 3 durability & cost tests: checkpoint/resume, worktrees, graceful budget.

Zero AIC — subagents use tests/fake_copilot.py; worktree tests use a throwaway
git repo and the real `git` CLI only.

    python3 -m unittest discover -s .local/lib/copilot_workflows/tests
"""
import json
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
    AgentSpec,
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
        kw.setdefault("model", "fake")
        return Runtime(run_dir=run_dir, checkpoints=store, **kw)


class TestCheckpointStore(Base):
    def test_roundtrip_and_resume(self):
        d = self.tmpdir()
        s = CheckpointStore(d, resume=False)
        r = AgentResult(content="hi", session_id="s1", nano_aiu=500_000_000,
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
            content="x", session_id=None, nano_aiu=100_000_000, output_tokens=1, exit_code=0))
        fresh = CheckpointStore(d, resume=False)  # resume=False ignores prior file
        self.assertIsNone(fresh.get("k"))
        self.assertEqual(fresh.prior_spent, 0.0)

    def test_fresh_run_truncates_stale(self):
        d = self.tmpdir()
        old = AgentResult(content="old", session_id=None, nano_aiu=100_000_000,
                          output_tokens=1, exit_code=0)
        new = AgentResult(content="new", session_id=None, nano_aiu=200_000_000,
                          output_tokens=1, exit_code=0)
        CheckpointStore(d, resume=False).put("k1", old)
        s2 = CheckpointStore(d, resume=False)   # fresh run reusing the dir drops stale
        self.assertEqual(s2.count, 0)
        s2.put("k2", new)
        s3 = CheckpointStore(d, resume=True)    # resume sees only the fresh run's data
        self.assertIsNone(s3.get("k1"))
        self.assertIsNotNone(s3.get("k2"))

    def test_repairs_torn_trailing_line(self):
        # A crash mid-write leaves a newline-less partial final line. On resume the
        # store must drop it, or the next append fuses onto it and both records are
        # lost on the following resume (AIC spend undercounted -> double-charge).
        d = self.tmpdir()
        s = CheckpointStore(d, resume=False)
        s.put("k1", AgentResult(content="good", session_id=None, nano_aiu=500_000_000,
                                output_tokens=1, exit_code=0))
        with open(os.path.join(d, "results.jsonl"), "a") as fh:
            fh.write('{"key": "k2", "result": {"content": "torn"')  # no brace, no newline

        s2 = CheckpointStore(d, resume=True)       # repairs the torn tail
        self.assertEqual(s2.get("k1").content, "good")
        self.assertAlmostEqual(s2.prior_spent, 0.5)
        s2.put("k3", AgentResult(content="new", session_id=None, nano_aiu=200_000_000,
                                 output_tokens=1, exit_code=0))

        s3 = CheckpointStore(d, resume=True)       # both committed records survive
        self.assertEqual(s3.get("k1").content, "good")
        self.assertEqual(s3.get("k3").content, "new")
        self.assertAlmostEqual(s3.prior_spent, 0.7)


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

    def test_failed_spend_is_not_budget_gating_on_resume(self):
        d = self.tmpdir()
        wf1 = Runtime(copilot_bin=FAKE, model="fake", run_dir=d,
                      checkpoints=CheckpointStore(d, resume=False), budget=0.005)
        r1 = wf1.agent("boom [[FAKE:{\"_exit\": 2}]]")
        self.assertFalse(r1.ok)
        self.assertAlmostEqual(wf1.spent, 0.01)
        self.assertEqual(wf1.checkpoints.count, 0)

        wf2 = Runtime(copilot_bin=FAKE, model="fake", run_dir=d,
                      checkpoints=CheckpointStore(d, resume=True), budget=0.005)
        # Budget gating still uses committed successful checkpoints, not failed attempts.
        self.assertAlmostEqual(wf2.spent, 0.0)
        r2 = wf2.agent("retry")
        self.assertTrue(r2.ok)

    def test_resume_field_distinguishes_followups(self):
        # follow_ups with the same prompt but different parent sessions must not collide.
        a = AgentSpec(prompt="reply", model="m", resume="session-A")
        b = AgentSpec(prompt="reply", model="m", resume="session-B")
        self.assertNotEqual(Runtime._spec_fingerprint(a), Runtime._spec_fingerprint(b))


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

    def test_budget_enforced_under_concurrency(self):
        d = self.tmpdir()
        # concurrency>1: before the post-semaphore re-check, all 40 ran (spent 0.40).
        wf = self.rt(d, CheckpointStore(d, resume=False), budget=0.05, concurrency=4)
        out = wf.fan_out(list(range(40)), lambda x: wf.agent("u%d" % x))
        ran = sum(1 for r in out if r.ok)
        self.assertLess(wf.spent, 0.20)        # far below the 0.40 unconstrained total
        self.assertLess(ran, 40)
        self.assertGreater(sum(1 for r in out if not r.ok), 0)
        self.assertTrue(wf.budget_hit)


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

    def test_create_collision_and_reuse(self):
        repo = self._make_repo()
        root = find_repo_root(repo)
        self.assertEqual(os.path.realpath(root), os.path.realpath(repo))
        mgr = WorktreeManager(root, self.tmpdir())  # base dir outside the repo
        p = mgr.create("branch-1")
        self.assertTrue(os.path.isfile(os.path.join(p, "f.txt")))
        self.assertNotEqual(mgr.create("branch-2"), p)   # distinct names are fine
        with self.assertRaises(RuntimeError):            # same *active* name fails loud
            mgr.create("branch-1")
        mgr.remove(p)
        self.assertFalse(os.path.exists(p))
        self.assertEqual(mgr.create("branch-1"), p)      # reusable once removed
        mgr.cleanup_all()

    def test_dot_only_name_kept_inside_base(self):
        # "." / ".." used to resolve to the base dir (or its parent), silently
        # destroying isolation. They must now map to a real subdir under base.
        repo = self._make_repo()
        root = find_repo_root(repo)
        base = self.tmpdir()
        mgr = WorktreeManager(root, base)
        rb = os.path.realpath(base)
        for name in (".", ".."):
            p = mgr.create(name)
            self.assertNotEqual(os.path.realpath(p), rb)
            self.assertTrue(os.path.realpath(p).startswith(rb + os.sep))
            self.assertTrue(os.path.isfile(os.path.join(p, "f.txt")))
            mgr.remove(p)
        mgr.cleanup_all()

    def test_runtime_worktree_context(self):
        repo = self._make_repo()
        root = find_repo_root(repo)
        wf = Runtime(copilot_bin=FAKE, model="fake",
                     run_dir=self.tmpdir(), repo_root=root)
        with wf.worktree("ctx-1") as path:
            self.assertTrue(os.path.isdir(path))
            captured = path
        self.assertFalse(os.path.exists(captured))  # removed on block exit
        wf.cleanup()

    def test_runtime_removes_owned_temp_worktree_base(self):
        repo = self._make_repo()
        root = find_repo_root(repo)
        wf = Runtime(copilot_bin=FAKE, model="fake", repo_root=root)
        with wf.worktree("ctx-1") as path:
            self.assertTrue(os.path.isdir(path))
        base = wf._wt_mgr.base_dir
        self.assertTrue(os.path.isdir(base))

        wf.cleanup()

        self.assertFalse(os.path.exists(base))

    def test_worktree_requires_git(self):
        d = self.tmpdir()  # not a git repo
        wf = Runtime(copilot_bin=FAKE, model="fake", run_dir=d, repo_root=None)
        # force detection from a non-repo dir
        cwd = os.getcwd()
        os.chdir(d)
        try:
            with self.assertRaises(RuntimeError):
                wf.worktree("x").__enter__()
        finally:
            os.chdir(cwd)


    def test_runtime_worktree_other_repo(self):
        remote = self._make_repo()  # acts as a separate "remote" repo
        subprocess.run(["git", "-C", remote, "checkout", "-q", "-b", "feat"], check=True)
        with open(os.path.join(remote, "g.txt"), "w") as fh:
            fh.write("pr\n")
        subprocess.run(["git", "-C", remote, "add", "."], check=True)
        subprocess.run(["git", "-C", remote, "-c", "user.email=t@t", "-c", "user.name=t",
                        "commit", "-q", "-m", "feat"], check=True)
        wf = Runtime(copilot_bin=FAKE, model="fake", run_dir=self.tmpdir())
        with wf.worktree("pr-1", repo=remote, ref="feat") as path:
            self.assertTrue(os.path.isfile(os.path.join(path, "g.txt")))  # fetched PR ref
            captured = path
        self.assertFalse(os.path.exists(captured))
        wf.cleanup()


if __name__ == "__main__":
    unittest.main(verbosity=2)
