"""Zero-credit unit tests for the cwf runtime and patterns.

All subagent calls go to tests/fake_copilot.py instead of the real `copilot`, so
this suite costs nothing and runs offline.

    python3 -m unittest discover -s .local/lib/copilot_workflows/tests
"""
import os
import stat
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.dirname(os.path.dirname(HERE))  # .local/lib
if LIB not in sys.path:
    sys.path.insert(0, LIB)

from copilot_workflows import (  # noqa: E402
    AgentSpec,
    BudgetExceeded,
    Runtime,
    build_cmd,
)
from copilot_workflows.patterns import Verdict, _extract_json  # noqa: E402

FAKE = os.path.join(HERE, "fake_copilot.py")


def _ensure_exec(path):
    st = os.stat(path)
    os.chmod(path, st.st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def fake(spec: str) -> str:
    """Embed a directive that steers the fake copilot."""
    return "[[FAKE:%s]]" % spec


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        _ensure_exec(FAKE)

    def rt(self, **kw):
        kw.setdefault("copilot_bin", FAKE)
        kw.setdefault("default_model", "fake")
        return Runtime(**kw)


class TestAgent(Base):
    def test_basic(self):
        wf = self.rt()
        r = wf.agent("hello world")
        self.assertTrue(r.ok)
        self.assertTrue(r.content.startswith("stub reply to:"))
        self.assertAlmostEqual(r.premium_requests, 0.01)
        self.assertGreater(r.output_tokens, 0)
        self.assertIsNotNone(r.session_id)
        self.assertEqual(wf.spent, 0.01)

    def test_content_directive(self):
        wf = self.rt()
        r = wf.agent("say %s" % fake('{"_content": "exact-answer"}'))
        self.assertEqual(r.content, "exact-answer")

    def test_failure_exit_code(self):
        wf = self.rt()
        r = wf.agent("boom %s" % fake('{"_exit": 2}'))
        self.assertFalse(r.ok)
        self.assertEqual(r.exit_code, 2)

    def test_missing_binary(self):
        wf = self.rt(copilot_bin="/nonexistent/copilot-xyz")
        r = wf.agent("hi")
        self.assertFalse(r.ok)
        self.assertEqual(r.exit_code, 127)


class TestFanOut(Base):
    def test_order_preserved(self):
        wf = self.rt()
        items = [1, 2, 3, 4, 5]
        out = wf.fan_out(items, lambda x: wf.agent("n %d %s" % (x, fake('{"_content": "%d"}' % x))))
        self.assertEqual([r.content for r in out], ["1", "2", "3", "4", "5"])
        self.assertEqual(len(wf.results), 5)

    def test_empty(self):
        wf = self.rt()
        self.assertEqual(wf.fan_out([], lambda x: wf.agent("x")), [])

    def test_nested_fan_out(self):
        wf = self.rt(concurrency=2)
        def outer(g):
            inner = wf.fan_out([1, 2], lambda x: wf.agent("g%d-%d %s" % (g, x, fake('{"_content": "%d%d"}' % (g, x)))))
            return [r.content for r in inner]
        out = wf.fan_out([1, 2], outer)
        self.assertEqual(out, [["11", "12"], ["21", "22"]])


class TestSynthesize(Base):
    def test_merge(self):
        wf = self.rt()
        parts = wf.fan_out(["a", "b", "c"], lambda p: wf.agent(p))
        r = wf.synthesize(parts, prompt="merge %s" % fake('{"_content": "MERGED"}'))
        self.assertEqual(r.content, "MERGED")
        # 3 fan-out agents + 1 synthesize = 4 calls
        self.assertEqual(len(wf.results), 4)


class TestVerify(Base):
    def test_pass(self):
        wf = self.rt()
        v = wf.verify("the work " + fake('{"passed": true, "score": 0.9, "reasons": "great"}'),
                      rubric="must be great")
        self.assertIsInstance(v, Verdict)
        self.assertTrue(v.passed)
        self.assertTrue(bool(v))
        self.assertAlmostEqual(v.score, 0.9)
        self.assertEqual(v.reasons, "great")

    def test_fail(self):
        wf = self.rt()
        v = wf.verify("bad " + fake('{"passed": false, "score": 0.1, "reasons": "nope"}'),
                      rubric="x")
        self.assertFalse(v.passed)
        self.assertFalse(bool(v))


class TestTournament(Base):
    def test_single(self):
        wf = self.rt()
        self.assertEqual(wf.tournament(["only"]), "only")

    def test_empty(self):
        wf = self.rt()
        self.assertIsNone(wf.tournament([]))

    def test_winner_b(self):
        wf = self.rt()
        # criteria carries the directive seen in every judge prompt -> B always wins
        winner = wf.tournament(["A", "B"], criteria="quality " + fake('{"winner": "B"}'))
        self.assertEqual(winner, "B")

    def test_bracket_with_bye(self):
        wf = self.rt()
        # 3 candidates -> round1: (c0,c1) judged + c2 bye; winner side = A
        winner = wf.tournament(["x", "y", "z"], criteria="q " + fake('{"winner": "A"}'))
        self.assertIn(winner, ["x", "y", "z"])


class TestGenerateAndFilter(Base):
    def test_keep_predicate(self):
        wf = self.rt()
        prompts = [
            "idea1 " + fake('{"_content": "keep me"}'),
            "idea2 " + fake('{"_content": "drop"}'),
            "idea3 " + fake('{"_content": "keep you"}'),
        ]
        out = wf.generate_and_filter(prompts, keep=lambda r: "keep" in r.content)
        self.assertEqual([r.content for r in out], ["keep me", "keep you"])

    def test_dedupe(self):
        wf = self.rt()
        prompts = [
            "a " + fake('{"_content": "same"}'),
            "b " + fake('{"_content": "same"}'),
            "c " + fake('{"_content": "unique"}'),
        ]
        out = wf.generate_and_filter(prompts, dedupe=True)
        self.assertEqual(sorted(r.content for r in out), ["same", "unique"])


class TestClassify(Base):
    def test_exact(self):
        wf = self.rt()
        cat = wf.classify("ticket " + fake('{"category": "bug"}'), ["bug", "feature", "question"])
        self.assertEqual(cat, "bug")

    def test_snap_case_insensitive(self):
        wf = self.rt()
        cat = wf.classify("t " + fake('{"category": "BUG"}'), ["bug", "feature"])
        self.assertEqual(cat, "bug")

    def test_fallback_first(self):
        wf = self.rt()
        cat = wf.classify("t " + fake('{"category": "nonsense"}'), ["alpha", "beta"])
        self.assertEqual(cat, "alpha")


class TestLoopUntil(Base):
    def test_stops_on_condition(self):
        wf = self.rt()
        calls = {"n": 0}
        def step(i):
            calls["n"] += 1
            return i
        hist = wf.loop_until(step, lambda r: r >= 3, max_iters=10)
        self.assertEqual(hist, [0, 1, 2, 3])
        self.assertEqual(calls["n"], 4)

    def test_max_iters(self):
        wf = self.rt()
        hist = wf.loop_until(lambda i: i, lambda r: False, max_iters=5)
        self.assertEqual(len(hist), 5)


class TestQuarantine(Base):
    def test_default_denies(self):
        wf = self.rt()
        q = wf.quarantine()
        spec = wf.spec("read untrusted", **q)
        cmd = build_cmd(spec, "copilot")
        self.assertIn("--deny-tool", cmd)
        joined = " ".join(cmd)
        self.assertIn("shell", joined)
        self.assertIn("write", joined)

    def test_custom_deny_url(self):
        wf = self.rt()
        q = wf.quarantine(deny=["shell"], deny_url=["*"])
        spec = wf.spec("x", **q)
        cmd = build_cmd(spec, "copilot")
        self.assertIn("--deny-url", cmd)


class TestBudget(Base):
    def test_strict_exceeds_raises(self):
        wf = self.rt(budget=0.025, strict_budget=True)  # each fake agent costs 0.01
        wf.agent("one")
        wf.agent("two")  # spent 0.02
        with self.assertRaises(BudgetExceeded):
            wf.agent("three")  # crosses 0.025 -> raises in strict mode

    def test_strict_fan_out_propagates(self):
        wf = self.rt(budget=0.025, strict_budget=True, concurrency=1)
        with self.assertRaises(BudgetExceeded):
            wf.fan_out(list(range(10)), lambda x: wf.agent("n%d" % x))


class TestBuildCmd(Base):
    def test_flags(self):
        spec = AgentSpec(prompt="hi", model="m", agent="verifier", effort="high",
                         cwd="/tmp/wt", disable_mcp=True, resume="sid-1")
        cmd = build_cmd(spec, "copilot")
        for token in ["copilot", "-p", "hi", "--output-format", "json", "--allow-all-tools",
                      "--no-ask-user", "--model", "m", "--agent", "verifier", "--effort",
                      "high", "--disable-builtin-mcps", "--resume", "sid-1", "-C", "/tmp/wt"]:
            self.assertIn(token, cmd)

    def test_quarantine_no_allow_all(self):
        spec = AgentSpec(prompt="hi", allow_all_tools=False, allow=["view"])
        cmd = build_cmd(spec, "copilot")
        self.assertNotIn("--allow-all-tools", cmd)
        self.assertIn("--allow-tool", cmd)


class TestExtractJson(Base):
    def test_trailing(self):
        self.assertEqual(_extract_json('blah\n{"a": 1}')["a"], 1)

    def test_brace_in_string(self):
        obj = _extract_json('reason\n{"why": "use a } brace", "ok": true}')
        self.assertEqual(obj["why"], "use a } brace")
        self.assertTrue(obj["ok"])

    def test_last_object_wins(self):
        obj = _extract_json('{"x": 1} middle {"x": 2}')
        self.assertEqual(obj["x"], 2)

    def test_fenced(self):
        obj = _extract_json('```json\n{"k": "v"}\n```')
        self.assertEqual(obj["k"], "v")

    def test_none(self):
        self.assertIsNone(_extract_json("no json here"))
        self.assertIsNone(_extract_json(""))


if __name__ == "__main__":
    unittest.main(verbosity=2)
