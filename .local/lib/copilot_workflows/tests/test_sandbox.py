"""Zero-credit tests for restricted/deterministic harness execution (sandbox.py).

    python3 -m unittest discover -s .local/lib/copilot_workflows/tests
"""
import io
import os
import sys
import unittest
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.dirname(os.path.dirname(HERE))  # .local/lib
if LIB not in sys.path:
    sys.path.insert(0, LIB)

from copilot_workflows.sandbox import (  # noqa: E402
    SAFE_MODULES,
    SandboxError,
    guarded_import,
    harness_globals,
    lint_imports,
    restricted_builtins,
)


def _exec_restricted(src, *, wf=None, args=None):
    g = harness_globals(wf=wf, args=args, file="h.py", restricted=True)
    exec(compile(src, "h.py", "exec"), g)
    return g


class TestRestrictedBuiltins(unittest.TestCase):
    def test_dangerous_and_nondeterministic_removed(self):
        b = restricted_builtins()
        for name in ("open", "exec", "eval", "compile", "input", "breakpoint",
                     "help", "exit", "quit", "id", "hash"):
            self.assertNotIn(name, b, "%s should be removed" % name)

    def test_safe_builtins_kept(self):
        b = restricted_builtins()
        for name in ("print", "len", "range", "isinstance", "sorted", "dict", "list",
                     "enumerate", "zip", "super", "ValueError", "Exception", "__build_class__"):
            self.assertIn(name, b, "%s should be kept" % name)

    def test_import_is_guarded(self):
        self.assertIs(restricted_builtins()["__import__"], guarded_import)


class TestGuardedImport(unittest.TestCase):
    def test_allows_safe_modules(self):
        self.assertIsNotNone(guarded_import("json"))
        self.assertIsNotNone(guarded_import("re"))
        self.assertIsNotNone(guarded_import("collections.abc", fromlist=["Mapping"]))

    def test_blocks_dangerous_and_nondeterministic(self):
        for name in ("os", "sys", "io", "subprocess", "socket", "shutil", "pathlib",
                     "time", "datetime", "random", "uuid", "secrets", "importlib", "ctypes"):
            with self.assertRaises(SandboxError, msg="%s should be blocked" % name):
                guarded_import(name)

    def test_blocks_submodule_of_blocked(self):
        with self.assertRaises(SandboxError):
            guarded_import("os.path")

    def test_blocks_relative_import(self):
        with self.assertRaises(SandboxError):
            guarded_import("anything", level=1)

    def test_future_is_allowed(self):
        self.assertIsNotNone(guarded_import("__future__", fromlist=["annotations"]))


class TestLintImports(unittest.TestCase):
    def test_blocks_top_level_import(self):
        with self.assertRaises(SandboxError):
            lint_imports("import os\n", "h.py")

    def test_blocks_from_import(self):
        with self.assertRaises(SandboxError):
            lint_imports("from subprocess import run\n", "h.py")

    def test_blocks_lazy_import_inside_function(self):
        # The whole point of the preflight: catch imports that would only fire mid-run.
        with self.assertRaises(SandboxError):
            lint_imports("def go():\n    import socket\n    return socket\n", "h.py")

    def test_blocks_relative_import(self):
        with self.assertRaises(SandboxError):
            lint_imports("from . import sibling\n", "h.py")

    def test_allows_safe_imports(self):
        lint_imports("import json, re\nfrom collections import OrderedDict\n", "h.py")

    def test_allows_future_import(self):
        lint_imports("from __future__ import annotations\nimport json\n", "h.py")

    def test_tolerates_syntax_error(self):
        lint_imports("def (:\n", "h.py")  # defers to the real compiler; must not raise here

    def test_every_safe_module_passes_its_own_import(self):
        for mod in SAFE_MODULES:
            if mod == "__future__":
                continue
            lint_imports("import %s\n" % mod, "h.py")


class TestExecInRestricted(unittest.TestCase):
    def test_normal_orchestration_patterns_work(self):
        # class/func defs, comprehensions, exceptions, print — none should be blocked.
        src = (
            "class C:\n    def m(self):\n        return 1\n"
            "def f(n):\n    return [i * 2 for i in range(n)]\n"
            "try:\n    raise ValueError('x')\nexcept ValueError as e:\n    pass\n"
            "print('ok', args['x'], f(3), C().m())\n"
        )
        with redirect_stdout(io.StringIO()):
            g = _exec_restricted(src, args={"x": 7})
        self.assertIn("f", g)

    def test_open_is_not_available(self):
        with self.assertRaises(NameError):
            _exec_restricted("open('/etc/hosts')\n")

    def test_eval_is_not_available(self):
        with self.assertRaises(NameError):
            _exec_restricted("eval('1+1')\n")

    def test_import_os_blocked_at_runtime(self):
        with self.assertRaises(SandboxError):
            _exec_restricted("import os\n")

    def test_safe_import_works_at_runtime(self):
        g = _exec_restricted("import json\nout = json.dumps({'a': 1})\n")
        self.assertEqual(g["out"], '{"a": 1}')

    def test_unrestricted_globals_unchanged(self):
        g = harness_globals(wf=None, args=None, file="h.py", restricted=False)
        self.assertNotIn("__builtins__", g)  # exec injects the real builtins
        exec(compile("import os\nhas_open = callable(open)\n", "h.py", "exec"), g)
        self.assertTrue(g["has_open"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
