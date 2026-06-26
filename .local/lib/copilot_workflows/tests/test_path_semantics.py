"""Guard/characterization tests for behavior-sensitive path & boundary semantics.

These lock invariants that a pathlib/idiom modernization could SILENTLY break, so any
drift fails loudly. They must pass on the current code and keep passing after the refactor:

  * ``AgentSpec.cwd`` uses ``abspath`` (NOT ``resolve``) — ``cwd`` is part of the checkpoint
    fingerprint, so following symlinks would change keys and break ``--resume``.
  * the ``cwf`` bootstrap follows a symlinked script back to its real ``.local/lib``.
  * empty ``CWF_WORKFLOWS_DIR`` / ``CWF_RUNS_DIR`` env vars behave as UNSET (``or`` semantics).
  * restricted ``wf.workflow()`` rejects path-like names (``~``/``..``/leading dot) and
    accepts a bare registered name.
  * ``WorktreeManager.create`` returns a path under the GIVEN base (symlink retained).
  * ``build_cmd`` emits an all-``str`` argv (no ``Path`` leakage), exact leading shape.
  * the ``cwf`` CLI keeps answer->stdout / diagnostics->stderr and the failure exit code.

    python3 -m unittest discover -s .local/lib/copilot_workflows/tests
"""
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.dirname(os.path.dirname(HERE))  # .local/lib
if LIB not in sys.path:
    sys.path.insert(0, LIB)

from copilot_workflows import (  # noqa: E402
    AgentSpec,
    Runtime,
    SandboxError,
    WorktreeManager,
    build_cmd,
    default_runs_dir,
    default_workflows_dir,
    find_repo_root,
)

FAKE = os.path.join(HERE, "fake_copilot.py")
CWF = os.path.join(os.path.dirname(LIB), "bin", "cwf")  # .local/bin/cwf


def _ensure_exec(path):
    st = os.stat(path)
    os.chmod(path, st.st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _have_git():
    try:
        subprocess.run(["git", "--version"], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, check=True)
        return True
    except Exception:
        return False


class TestAgentSpecCwdFingerprint(unittest.TestCase):
    """``cwd`` normalization must keep symlinks (abspath), not collapse them (resolve)."""

    def _symlinked_dir(self):
        d = tempfile.mkdtemp(prefix="cwf-sym-")
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        real = os.path.join(d, "real")
        os.mkdir(real)
        link = os.path.join(d, "link")
        os.symlink(real, link)
        return real, link

    def test_cwd_uses_abspath_not_resolve(self):
        real, link = self._symlinked_dir()
        spec = AgentSpec(prompt="x", cwd=link)
        # abspath keeps the "link" component; resolve() would rewrite it to "real".
        self.assertEqual(spec.cwd, os.path.abspath(link))
        self.assertEqual(os.path.basename(spec.cwd), "link")

    def test_symlink_and_target_cwd_have_distinct_fingerprints(self):
        real, link = self._symlinked_dir()
        fp_link = Runtime._spec_fingerprint(AgentSpec(prompt="x", cwd=link))
        fp_real = Runtime._spec_fingerprint(AgentSpec(prompt="x", cwd=real))
        # If cwd were resolved, these would alias and resume would reuse the wrong result.
        self.assertNotEqual(fp_link, fp_real)


class TestBootstrapSymlink(unittest.TestCase):
    def test_cwf_runs_via_symlinked_script(self):
        if not os.path.isfile(CWF):
            self.skipTest("cwf CLI not present")
        d = tempfile.mkdtemp(prefix="cwf-link-")
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        link = os.path.join(d, "cwf-link")
        os.symlink(CWF, link)
        env = dict(os.environ, CWF_RUNS_DIR=os.path.join(d, "runs"))
        # `runs` only needs a successful import + argparse; realpath(__file__) must follow
        # the symlink back to .local/lib to import copilot_workflows (exit 2 if it cannot).
        proc = subprocess.run([sys.executable, link, "runs"], env=env,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(proc.returncode, 0, msg=proc.stderr.decode(errors="replace"))


class TestEnvDirDefaults(unittest.TestCase):
    def test_empty_workflows_dir_env_is_unset(self):
        with mock.patch.dict(os.environ, {"CWF_WORKFLOWS_DIR": ""}, clear=False):
            self.assertEqual(default_workflows_dir(),
                             os.path.expanduser("~/.copilot/workflows"))

    def test_empty_runs_dir_env_is_unset(self):
        with mock.patch.dict(os.environ,
                             {"CWF_RUNS_DIR": "", "CWF_WORKFLOWS_DIR": ""}, clear=False):
            self.assertEqual(
                default_runs_dir(),
                os.path.join(os.path.expanduser("~/.copilot/workflows"), "runs"))


class TestRestrictedWorkflowNamePolicy(unittest.TestCase):
    """Complements test_sandbox.TestWorkflowRestricted: tilde / dotdot-substring / dot."""

    @classmethod
    def setUpClass(cls):
        _ensure_exec(FAKE)

    def rt(self):
        return Runtime(copilot_bin=FAKE, model="fake", restricted=True)

    def test_rejects_tilde_prefixed_name(self):
        with self.assertRaises(SandboxError):
            self.rt().workflow("~secret")

    def test_rejects_dotdot_substring_without_slash(self):
        with self.assertRaises(SandboxError):
            self.rt().workflow("foo..bar")

    def test_rejects_leading_dot_name(self):
        with self.assertRaises(SandboxError):
            self.rt().workflow(".hidden")

    def test_accepts_registered_name(self):
        d = tempfile.mkdtemp(prefix="cwf-wf-")
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        with open(os.path.join(d, "good.cwf.py"), "w") as fh:
            fh.write("print('ok', args)\n")
        with mock.patch.dict(os.environ, {"CWF_WORKFLOWS_DIR": d}, clear=False):
            self.assertEqual(self.rt().workflow("good", 7), "ok 7")


@unittest.skipUnless(_have_git(), "git required")
class TestWorktreeContainment(unittest.TestCase):
    def _make_repo(self):
        d = tempfile.mkdtemp(prefix="cwf-wt-repo-")
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        subprocess.run(["git", "init", "-q", d], check=True)
        with open(os.path.join(d, "f.txt"), "w") as fh:
            fh.write("hi\n")
        subprocess.run(["git", "-C", d, "add", "."], check=True)
        subprocess.run(["git", "-C", d, "-c", "user.email=t@t", "-c", "user.name=t",
                        "commit", "-q", "-m", "init"], check=True)
        return d

    def test_returned_path_keeps_given_symlinked_base(self):
        root = find_repo_root(self._make_repo())
        real_base = tempfile.mkdtemp(prefix="cwf-wt-real-")
        self.addCleanup(shutil.rmtree, real_base, ignore_errors=True)
        holder = tempfile.mkdtemp(prefix="cwf-wt-link-")
        self.addCleanup(shutil.rmtree, holder, ignore_errors=True)
        base = os.path.join(holder, "base")
        os.symlink(real_base, base)
        mgr = WorktreeManager(root, base)
        path = mgr.create("br-1")
        try:
            # The returned path is built from the GIVEN base (symlink retained); a
            # resolve()-based rewrite would expose real_base here instead.
            self.assertEqual(os.path.dirname(path), base)
            self.assertTrue(os.path.isfile(os.path.join(path, "f.txt")))
        finally:
            mgr.cleanup_all()


class TestBuildCmdArgv(unittest.TestCase):
    def test_argv_is_all_strings(self):
        spec = AgentSpec(
            prompt="hi", model="m", cwd="/tmp", agent="verifier", effort="high",
            context="long_context", mcp="@/cfg.json", allow=["view"], deny=["shell"],
            allow_url=["http://x"], deny_url=["*"], add_dir=["/x"],
            extra_args=["--foo", "bar"])
        cmd = build_cmd(spec, "copilot")
        non_str = [a for a in cmd if not isinstance(a, str)]
        self.assertEqual(non_str, [], msg=f"non-str argv elements: {non_str!r}")
        self.assertEqual(cmd[:3], ["copilot", "-p", "hi"])


class TestCliFailurePath(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        _ensure_exec(FAKE)

    def test_failed_agent_exit_code_and_stream_split(self):
        if not os.path.isfile(CWF):
            self.skipTest("cwf CLI not present")
        d = tempfile.mkdtemp(prefix="cwf-cli-")
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        harness = os.path.join(d, "h.cwf.py")
        with open(harness, "w") as fh:
            fh.write('r = wf.agent("boom [[FAKE:{\\"_exit\\": 2}]]")\n'
                     'print("ANSWER", r.ok)\n')
        env = dict(os.environ, CWF_COPILOT_BIN=FAKE,
                   CWF_RUNS_DIR=os.path.join(d, "runs"))
        proc = subprocess.run([sys.executable, CWF, "run", harness, "--model", "fake"],
                              env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        out, err = proc.stdout.decode(), proc.stderr.decode(errors="replace")
        # A single failed agent maps to exit code 4 (see cwf cmd_run).
        self.assertEqual(proc.returncode, 4, msg=err)
        self.assertIn("ANSWER", out)          # harness answer -> stdout
        self.assertNotIn("ANSWER", err)       # never leaks onto stderr
        self.assertIn("cwf", err)             # diagnostics -> stderr


if __name__ == "__main__":
    unittest.main(verbosity=2)
