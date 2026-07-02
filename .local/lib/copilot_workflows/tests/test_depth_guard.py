"""CWF_DEPTH bounds nested workflow execution. Zero AIC — the CLI refuses before spawning.

    python3 -m unittest discover -s .local/lib/copilot_workflows/tests
"""
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.dirname(os.path.dirname(HERE))  # .local/lib
if LIB not in sys.path:
    sys.path.insert(0, LIB)

from copilot_workflows import agent as agent_mod  # noqa: E402

CWF = os.path.join(os.path.dirname(LIB), "bin", "cwf")
HARNESS = 'META = {"name": "guard-probe", "phases": ["x"]}\nprint("HARNESS RAN")\n'


def _run(depth=None, max_depth=None, dry=False):
    env = dict(os.environ)
    env.pop("CWF_DEPTH", None)
    env.pop("CWF_MAX_DEPTH", None)
    if depth is not None:
        env["CWF_DEPTH"] = str(depth)
    if max_depth is not None:
        env["CWF_MAX_DEPTH"] = str(max_depth)
    with tempfile.NamedTemporaryFile("w", suffix=".cwf.py", delete=False) as fh:
        fh.write(HARNESS)
        path = fh.name
    try:
        argv = [sys.executable, CWF, "run", path, "--budget", "10", "--quiet"]
        if dry:
            argv.append("--dry-run")
        return subprocess.run(argv, env=env, capture_output=True, text=True, timeout=60)
    finally:
        os.unlink(path)


class ChildEnvDepth(unittest.TestCase):
    def test_increments_from_unset(self):
        e = dict(os.environ)
        e.pop("CWF_DEPTH", None)
        self.assertEqual(agent_mod._child_env(e)["CWF_DEPTH"], "1")

    def test_increments_existing(self):
        self.assertEqual(agent_mod._child_env({"CWF_DEPTH": "2"})["CWF_DEPTH"], "3")

    def test_non_integer_resets(self):
        self.assertEqual(agent_mod._child_env({"CWF_DEPTH": "x"})["CWF_DEPTH"], "1")

    def test_preserves_other_vars(self):
        self.assertEqual(agent_mod._child_env({"FOO": "bar"}).get("FOO"), "bar")


class CliDepthGuard(unittest.TestCase):
    def test_top_level_runs(self):
        self.assertEqual(_run(depth=None).returncode, 0)

    def test_nested_real_run_refused(self):
        r = _run(depth=1)
        self.assertEqual(r.returncode, 3)
        self.assertIn("refusing to run inside a running workflow", r.stderr)

    def test_nested_dry_run_allowed(self):
        self.assertEqual(_run(depth=1, dry=True).returncode, 0)

    def test_max_depth_override(self):
        self.assertEqual(_run(depth=1, max_depth=2).returncode, 0)


if __name__ == "__main__":
    unittest.main()
