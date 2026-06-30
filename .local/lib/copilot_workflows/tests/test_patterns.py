"""Zero-credit unit tests for the cwf runtime and patterns.

All subagent calls go to tests/fake_copilot.py instead of the real `copilot`, so
this suite costs nothing and runs offline.

    python3 -m unittest discover -s .local/lib/copilot_workflows/tests
"""
import os
import stat
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.dirname(os.path.dirname(HERE))  # .local/lib
if LIB not in sys.path:
    sys.path.insert(0, LIB)

from copilot_workflows import (  # noqa: E402
    AgentSpec,
    BudgetExceeded,
    CheckpointStore,
    Runtime,
    build_cmd,
)
from copilot_workflows.patterns import (  # noqa: E402
    Consensus,
    Structured,
    Verdict,
    _check_schema_def,
    _extract_last_json,
    _extract_last_json_object,
    _validate_shape,
)
from copilot_workflows.agent import AgentResult, _reduce, _session_nano_aiu  # noqa: E402

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
        kw.setdefault("model", "fake")
        return Runtime(**kw)


class TestAgent(Base):
    def test_basic(self):
        wf = self.rt()
        r = wf.agent("hello world")
        self.assertTrue(r.ok)
        self.assertTrue(r.content.startswith("stub reply to:"))
        self.assertAlmostEqual(r.aiu_credits, 0.01)
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

    def test_timeout_kills_hung_agent(self):
        wf = self.rt()
        r = wf.agent("slow %s" % fake('{"_sleep": 5}'), timeout=0.2)
        self.assertFalse(r.ok)
        self.assertIn("timed out", (r.error or ""))

    def test_reduce_tolerates_malformed_numbers(self):
        # A non-numeric outputTokens value must not raise (it would
        # otherwise escape run_agent, leak the timer and hang proc.wait()).
        acc = {"content": None, "tokens": 0, "session": None, "model": None}
        _reduce(acc, {"type": "assistant.message",
                      "data": {"content": "x", "outputTokens": "not-a-number"}})
        _reduce(acc, {"type": "result", "sessionId": "s",
                      "usage": {"premiumRequests": "oops"}})
        self.assertEqual(acc["tokens"], 0)
        self.assertEqual(acc["session"], "s")
        self.assertEqual(acc["content"], "x")

    def test_reduce_ignores_premium_request_cost_for_budgeting(self):
        acc = {"content": None, "tokens": 0, "session": None, "model": None}
        _reduce(acc, {"type": "result", "sessionId": "s",
                      "usage": {"premiumRequests": 999}})
        self.assertNotIn("premium", acc)

    def test_session_nano_aiu_reads_shutdown_nano_ai_units(self):
        home = tempfile.mkdtemp(prefix="cwf-home-")
        sid = "session-123"
        d = os.path.join(home, ".copilot", "session-state", sid)
        os.makedirs(d)
        with open(os.path.join(d, "events.jsonl"), "w", encoding="utf-8") as fh:
            fh.write('{"type":"session.shutdown","data":{"totalNanoAiu":5421200000}}\n')
        with mock.patch.dict(os.environ, {"HOME": home, "COPILOT_HOME": ""}, clear=False):
            self.assertEqual(_session_nano_aiu(sid), 5421200000)

    def test_session_nano_aiu_honors_copilot_home(self):
        home = tempfile.mkdtemp(prefix="cwf-copilot-home-")
        sid = "session-456"
        d = os.path.join(home, "session-state", sid)
        os.makedirs(d)
        with open(os.path.join(d, "events.jsonl"), "w", encoding="utf-8") as fh:
            fh.write('{"type":"session.shutdown","data":{"totalNanoAiu":123000000}}\n')
        with mock.patch.dict(os.environ, {"COPILOT_HOME": home}, clear=False):
            self.assertEqual(_session_nano_aiu(sid), 123000000)

    def test_session_nano_aiu_missing_data_is_zero(self):
        with mock.patch.dict(os.environ, {"COPILOT_HOME": tempfile.mkdtemp()}, clear=False):
            self.assertEqual(_session_nano_aiu("missing-session"), 0)

    def test_session_error_without_content_fails_result(self):
        wf = self.rt()
        r = wf.agent("soft fail " + fake(
            '{"_session_error": "model call failed", "_error_type": "model_call", "_content": ""}'))
        self.assertFalse(r.ok)
        self.assertIn("model_call", r.error)
        self.assertIn("model call failed", r.error)

    def test_recovered_session_error_is_warning(self):
        wf = self.rt()
        r = wf.agent("recovered " + fake(
            '{"_session_error": "retried once", "_error_type": "model_call", "_content": "done"}'))
        self.assertTrue(r.ok)
        self.assertIsNone(r.error)
        self.assertIn("model_call: retried once", r.warnings)

    def test_missing_cwd_reports_cwd_not_binary(self):
        base = tempfile.mkdtemp(prefix="cwf-missing-cwd-")
        self.addCleanup(os.rmdir, base)
        missing = os.path.join(base, "missing")
        wf = self.rt()
        r = wf.agent("hi", cwd=missing)
        self.assertFalse(r.ok)
        self.assertIn("working directory not found", r.error)
        self.assertNotIn("binary not found", r.error)


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

    def test_reraises_branch_error(self):
        wf = self.rt()

        def fn(x):
            if x == 1:
                raise ValueError("boom")
            return wf.agent("n%d" % x)

        with self.assertRaises(ValueError):
            wf.fan_out([0, 1, 2], fn)

    def test_can_drop_branch_errors(self):
        wf = self.rt()

        def fn(x):
            if x == 1:
                raise ValueError("boom")
            return x * 10

        self.assertEqual(wf.fan_out([0, 1, 2], fn, errors="drop"), [0, None, 20])

    def test_invalid_error_policy_raises(self):
        wf = self.rt()
        with self.assertRaises(ValueError):
            wf.fan_out([1], lambda x: x, errors="ignore")

    def test_branch_error_cancels_not_yet_started_work(self):
        wf = self.rt(concurrency=1)
        launched = []

        def fn(x):
            launched.append(x)
            if x == 0:
                raise ValueError("boom")
            time.sleep(0.05)
            return wf.agent("n%d" % x)

        with self.assertRaises(ValueError):
            wf.fan_out(list(range(20)), fn)
        self.assertLess(len(launched), 20)


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

    def test_string_false_not_pass(self):
        wf = self.rt()
        v = wf.verify("x " + fake('{"passed": "false", "score": 0}'), rubric="r")
        self.assertFalse(v.passed)

    def test_string_true_passes(self):
        wf = self.rt()
        v = wf.verify("x " + fake('{"passed": "true", "score": 1}'), rubric="r")
        self.assertTrue(v.passed)

    def test_agent_failure_is_fail_closed_but_observable(self):
        wf = self.rt()
        v = wf.verify("x " + fake('{"_exit": 2, "passed": true}'), rubric="r")
        self.assertFalse(v.passed)
        self.assertFalse(v.ok)
        self.assertIn("exited with code 2", v.error)
        self.assertFalse(bool(v))


class TestConsensus(Base):
    def test_majority_pass_with_dissent(self):
        wf = self.rt(concurrency=1)
        queue = [
            Verdict(True, 0.9, "looks good", AgentResult("{}", "s1", 0, 1, 0)),
            Verdict(False, 0.2, "edge case", AgentResult("{}", "s2", 0, 1, 0)),
            Verdict(True, 0.8, "acceptable", AgentResult("{}", "s3", 0, 1, 0)),
        ]

        def stub(*_args, **_kw):
            return queue.pop(0)

        wf.verify = stub
        c = wf.consensus("work", rubric="rubric", reviewers=3)
        self.assertIsInstance(c, Consensus)
        self.assertTrue(c.passed)
        self.assertTrue(bool(c))
        self.assertEqual((c.passed_count, c.failed_count), (2, 1))
        self.assertIn("reviewer 2 failed: edge case", c.dissent)

    def test_verifier_failure_fails_closed(self):
        wf = self.rt(concurrency=1)
        queue = [
            Verdict(True, 0.9, "ok", AgentResult("{}", "s1", 0, 1, 0)),
            Verdict(False, None, "tool error", AgentResult("", "s2", 0, 0, 0),
                    ok=False, error="tool error"),
            Verdict(True, 0.8, "ok", AgentResult("{}", "s3", 0, 1, 0)),
        ]

        def stub(*_args, **_kw):
            return queue.pop(0)

        wf.verify = stub
        c = wf.consensus("work", rubric="rubric", reviewers=3)
        self.assertTrue(c.passed)
        self.assertTrue(c.ok)
        self.assertEqual(c.errored_count, 1)
        self.assertIn("verifier error", c.reasons)

    def test_verifier_failures_without_quorum_fail_closed(self):
        wf = self.rt(concurrency=1)
        queue = [
            Verdict(True, 0.9, "ok", AgentResult("{}", "s1", 0, 1, 0)),
            Verdict(False, None, "tool error 1", AgentResult("", "s2", 0, 0, 0),
                    ok=False, error="tool error 1"),
            Verdict(False, None, "tool error 2", AgentResult("", "s3", 0, 0, 0),
                    ok=False, error="tool error 2"),
        ]

        def stub(*_args, **_kw):
            return queue.pop(0)

        wf.verify = stub
        c = wf.consensus("work", rubric="rubric", reviewers=3)
        self.assertFalse(c.passed)
        self.assertFalse(c.ok)
        self.assertEqual(c.errored_count, 2)
        self.assertIn("quorum", c.error)

    def test_requires_reviewer(self):
        wf = self.rt()
        with self.assertRaises(ValueError):
            wf.consensus("work", rubric="rubric", reviewers=0)

    def test_models_cycle_across_reviewers(self):
        wf = self.rt(concurrency=1)
        seen = []

        def stub(*_args, **kw):
            seen.append(kw.get("model"))
            return Verdict(True, 0.9, "ok", AgentResult("{}", "s", 0, 1, 0))

        wf.verify = stub
        c = wf.consensus("work", rubric="rubric", reviewers=5, models=["gpt", "claude", "gemini"])
        self.assertTrue(c.passed)
        self.assertEqual(seen, ["gpt", "claude", "gemini", "gpt", "claude"])

    def test_model_and_models_conflict(self):
        wf = self.rt()
        with self.assertRaises(ValueError):
            wf.consensus("work", rubric="rubric", model="gpt", models=["claude"])

    def test_models_reject_empty_names(self):
        wf = self.rt()
        with self.assertRaises(ValueError):
            wf.consensus("work", rubric="rubric", models=["gpt", ""])


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

    def test_judge_failure_raises(self):
        wf = self.rt()
        with self.assertRaises(RuntimeError):
            wf.tournament(["A", "B"], criteria="quality " + fake('{"_exit": 2}'))

    def test_invalid_winner_raises(self):
        wf = self.rt()
        with self.assertRaises(ValueError):
            wf.tournament(["A", "B"], criteria="quality " + fake('{"winner": "C"}'))

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

    def test_invalid_category_raises(self):
        wf = self.rt()
        with self.assertRaises(ValueError):
            wf.classify("t " + fake('{"category": "nonsense"}'), ["alpha", "beta"])

    def test_agent_failure_raises(self):
        wf = self.rt()
        with self.assertRaises(RuntimeError):
            wf.classify("t " + fake('{"_exit": 2}'), ["bug", "feature"])

    def test_empty_classes_raise(self):
        wf = self.rt()
        with self.assertRaises(ValueError):
            wf.classify("ticket", [])


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

    def test_done_error_propagates(self):
        wf = self.rt()

        def done(_):
            raise RuntimeError("boom")

        with self.assertRaises(RuntimeError):
            wf.loop_until(lambda i: i, done)


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

    def test_default_blocks_egress_and_mcp(self):
        # Hardened default for an untrusted-content reader: no network, no MCP.
        wf = self.rt()
        spec = wf.spec("read untrusted", **wf.quarantine())
        cmd = build_cmd(spec, "copilot")
        self.assertIn("--deny-url", cmd)
        self.assertIn("*", cmd)                       # deny all URLs by default
        self.assertIn("--disable-builtin-mcps", cmd)  # drop GitHub etc.

    def test_network_reader_opt_in(self):
        # A research reader keeps the network but still loses shell/write.
        wf = self.rt()
        spec = wf.spec("research", **wf.quarantine(deny_url=[], enable_mcp=True))
        cmd = build_cmd(spec, "copilot")
        self.assertNotIn("--deny-url", cmd)
        self.assertNotIn("--disable-builtin-mcps", cmd)
        self.assertIn("write", " ".join(cmd))

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
                         context="long_context", cwd="/tmp/wt", enable_mcp=False, resume="sid-1")
        cmd = build_cmd(spec, "copilot")
        for token in ["copilot", "-p", "hi", "--output-format", "json", "--allow-all-tools",
                      "--no-ask-user", "--model", "m", "--agent", "verifier", "--effort",
                      "high", "--context", "long_context", "--disable-builtin-mcps",
                      "--resume", "sid-1", "-C", "/tmp/wt"]:
            self.assertIn(token, cmd)

    def test_context_omitted_when_unset(self):
        self.assertNotIn("--context", build_cmd(AgentSpec(prompt="hi"), "copilot"))

    def test_quarantine_no_allow_all(self):
        spec = AgentSpec(prompt="hi", allow_all_tools=False, allow=["view"])
        cmd = build_cmd(spec, "copilot")
        self.assertNotIn("--allow-all-tools", cmd)
        self.assertIn("--allow-tool", cmd)


class TestRunSettings(Base):
    def test_launcher_value_fills_unset_agent(self):
        # The session default is inherited by an agent that doesn't pin its own.
        wf = self.rt(model="session", effort="high", context="long_context")
        spec = wf.spec("hi")
        self.assertEqual((spec.model, spec.effort, spec.context),
                         ("session", "high", "long_context"))

    def test_harness_choice_wins_over_launcher(self):
        # A per-agent model/effort/context pinned by the harness overrides the session default.
        wf = self.rt(model="session", effort="high", context="long_context")
        spec = wf.spec("hi", model="claude-haiku-4.5", effort="low", context="default")
        self.assertEqual((spec.model, spec.effort, spec.context),
                         ("claude-haiku-4.5", "low", "default"))

    def test_unset_when_neither_side_sets(self):
        wf = self.rt(model=None)
        spec = wf.spec("hi")
        self.assertEqual((spec.model, spec.effort, spec.context), (None, None, None))

    def test_runtime_disables_mcp_by_default(self):
        wf = self.rt()
        cmd = build_cmd(wf.spec("hi"), "copilot")
        self.assertIn("--disable-builtin-mcps", cmd)

    def test_enable_mcp_opt_in(self):
        wf = self.rt()
        cmd = build_cmd(wf.spec("hi", enable_mcp=True), "copilot")
        self.assertNotIn("--disable-builtin-mcps", cmd)

    def test_disable_mcp_is_not_a_public_agent_kwarg(self):
        wf = self.rt()
        with self.assertRaises(TypeError):
            wf.spec("hi", disable_mcp=False)

    def test_xtreme_preset_fills_unset_defaults(self):
        wf = self.rt(model=None, effort=None, context=None, budget=None, preset="xtreme")
        self.assertEqual((wf.model, wf.effort, wf.context),
                         ("auto", "xhigh", "long_context"))
        self.assertEqual(wf.budget_total, 1000000.0)
        spec = wf.spec("hi")
        self.assertEqual((spec.model, spec.effort, spec.context),
                         ("auto", "xhigh", "long_context"))

    def test_xtreme_preset_preserves_explicit_values(self):
        wf = self.rt(model="manual", effort="low", context="default", budget=7,
                     preset="xtreme")
        self.assertEqual((wf.model, wf.effort, wf.context),
                         ("manual", "low", "default"))
        self.assertEqual(wf.budget_total, 7)

    def test_inherit_reaches_directly_built_spec(self):
        # A harness may construct AgentSpec itself and hand it to wf.agent(); the session
        # default must reach its unset fields (applied at the agent() launch chokepoint),
        # while a field it pinned is preserved.
        wf = self.rt(model="session", effort="high")
        spec = AgentSpec(prompt="hi", model="claude-haiku-4.5")
        wf._apply_run_settings(spec)
        self.assertEqual((spec.model, spec.effort), ("claude-haiku-4.5", "high"))

    def test_agent_chokepoint_resolves_directly_built_spec(self):
        # Drive the real agent() chokepoint (not the private helper): an unpinned model
        # inherits the session, a pinned one wins. dry_run surfaces the resolved spec.model.
        wf = self.rt(model="session", dry_run=True)
        self.assertEqual(wf.agent(AgentSpec(prompt="x")).model, "session")
        self.assertEqual(wf.agent(AgentSpec(prompt="x", model="claude-haiku-4.5")).model,
                         "claude-haiku-4.5")

    def test_agent_does_not_mutate_caller_spec(self):
        # agent() resolves into a copy, so the harness's own AgentSpec stays "inherit".
        wf = self.rt(model="session", dry_run=True)
        spec = AgentSpec(prompt="x")
        wf.agent(spec)
        self.assertIsNone(spec.model)

    def test_inherited_model_changes_checkpoint_key(self):
        # An agent that inherits a different session model must not reuse a stale cached result.
        a, b = self.rt(model="A"), self.rt(model="B")
        key_a = a._agent_key(a._apply_run_settings(AgentSpec(prompt="hi")))
        key_b = b._agent_key(b._apply_run_settings(AgentSpec(prompt="hi")))
        self.assertNotEqual(key_a, key_b)


class TestPipeline(Base):
    def test_chain_order_and_stage_signature(self):
        wf = self.rt()
        # stage1 is 1-arg; stage2 is 3-arg (prev, item, index) — arity adapts.
        out = wf.pipeline(
            [1, 2, 3],
            lambda it: it * 10,
            lambda prev, it, i: (prev, it, i),
        )
        self.assertEqual(out, [(10, 1, 0), (20, 2, 1), (30, 3, 2)])

    def test_with_agents_order(self):
        wf = self.rt()
        out = wf.pipeline(
            ["x", "y", "z"],
            lambda it: wf.agent("g %s" % fake('{"_content": "%s1"}' % it)),
            lambda r, it, i: wf.agent("v %s" % fake('{"_content": "%s2"}' % it)),
        )
        self.assertEqual([r.content for r in out], ["x2", "y2", "z2"])
        self.assertEqual(len(wf.results), 6)  # 3 items x 2 stages

    def test_empty_items(self):
        wf = self.rt()
        self.assertEqual(wf.pipeline([], lambda it: it), [])

    def test_no_stages_returns_items(self):
        wf = self.rt()
        self.assertEqual(wf.pipeline([1, 2, 3]), [1, 2, 3])

    def test_stage_error_drops_item_to_none(self):
        wf = self.rt()

        def stage1(it):
            if it == 2:
                raise ValueError("boom")
            return it * 10

        out = wf.pipeline([1, 2, 3], stage1, lambda prev: prev + 1)
        self.assertEqual(out, [11, None, 31])  # item 2 dropped, others flow on

    def test_stage_error_can_raise(self):
        wf = self.rt()

        def stage1(it):
            if it == 2:
                raise ValueError("boom")
            return it

        with self.assertRaises(ValueError):
            wf.pipeline([1, 2, 3], stage1, errors="raise")

    def test_stage_arity_fallback_for_builtin(self):
        wf = self.rt()
        out = wf.pipeline([1, 2], str)  # str has no introspectable signature -> 1 arg
        self.assertEqual(out, ["1", "2"])

    def test_strict_budget_propagates(self):
        wf = self.rt(budget=0.025, strict_budget=True, concurrency=1)
        with self.assertRaises(BudgetExceeded):
            wf.pipeline(list(range(10)), lambda it: wf.agent("n%d" % it))


class TestParallel(Base):
    def test_order_and_values(self):
        wf = self.rt()
        self.assertEqual(wf.parallel([lambda: 1, lambda: 2, lambda: 3]), [1, 2, 3])

    def test_with_agents(self):
        wf = self.rt()
        out = wf.parallel([
            lambda: wf.agent("a %s" % fake('{"_content": "A"}')),
            lambda: wf.agent("b %s" % fake('{"_content": "B"}')),
        ])
        self.assertEqual([r.content for r in out], ["A", "B"])

    def test_error_becomes_none(self):
        wf = self.rt()

        def boom():
            raise RuntimeError("x")

        self.assertEqual(wf.parallel([lambda: 1, boom, lambda: 3]), [1, None, 3])

    def test_error_can_raise(self):
        wf = self.rt()

        def boom():
            raise RuntimeError("x")

        with self.assertRaises(RuntimeError):
            wf.parallel([lambda: 1, boom, lambda: 3], errors="raise")

    def test_empty(self):
        wf = self.rt()
        self.assertEqual(wf.parallel([]), [])

    def test_strict_budget_propagates(self):
        wf = self.rt(budget=0.025, strict_budget=True, concurrency=1)
        with self.assertRaises(BudgetExceeded):
            wf.parallel([lambda: wf.agent("n") for _ in range(10)])


class TestPhaseOverride(Base):
    def _recs(self, **kw):
        recs = []
        wf = self.rt(progress=lambda r: recs.append(dict(r)), **kw)
        return wf, recs

    def test_explicit_phase_in_events(self):
        wf, recs = self._recs()
        wf.agent("x", phase="Verify")
        phases = {r["phase"] for r in recs if r.get("ev") in ("start", "end")}
        self.assertEqual(phases, {"Verify"})

    def test_explicit_phase_overrides_context(self):
        wf, recs = self._recs()
        with wf.phase("Outer"):
            wf.agent("inherits")
            wf.agent("override", phase="Inner")
        starts = [r for r in recs if r.get("ev") == "start"]
        self.assertEqual(starts[0]["phase"], "Outer")
        self.assertEqual(starts[1]["phase"], "Inner")

    def test_parallel_phase_context_is_isolated_per_branch(self):
        wf, recs = self._recs(concurrency=2)

        def branch(name):
            wf.agent("before-%s" % name, label="before-%s" % name)
            with wf.phase("Inner-%s" % name):
                wf.agent("inner-%s" % name, label="inner-%s" % name)
            wf.agent("after-%s" % name, label="after-%s" % name)

        with wf.phase("Outer"):
            wf.fan_out(["A", "B"], branch, concurrency=2)

        phases = {
            r["label"]: r["phase"]
            for r in recs
            if r.get("ev") == "start"
        }
        self.assertEqual(phases["before-A"], "Outer")
        self.assertEqual(phases["before-B"], "Outer")
        self.assertEqual(phases["inner-A"], "Inner-A")
        self.assertEqual(phases["inner-B"], "Inner-B")
        self.assertEqual(phases["after-A"], "Outer")
        self.assertEqual(phases["after-B"], "Outer")


class TestCheckpointKeys(Base):
    def test_concurrent_branch_keys_are_scoped_by_index(self):
        with tempfile.TemporaryDirectory(prefix="cwf-keys-") as d:
            store = CheckpointStore(d, resume=False)
            wf = self.rt(checkpoints=store, concurrency=2)

            wf.fan_out([0, 1], lambda _: wf.agent("same prompt"), concurrency=2)

            keys = sorted(store._cache)
            self.assertEqual(len(keys), 2)
            self.assertTrue(any("-b0-" in key or key.startswith("b0-") for key in keys))
            self.assertTrue(any("-b1-" in key or key.startswith("b1-") for key in keys))
            self.assertTrue(all(key.endswith("-0") for key in keys))


class TestRemaining(Base):
    def test_inf_without_budget(self):
        wf = self.rt()
        self.assertEqual(wf.remaining(), float("inf"))
        self.assertIsNone(wf.budget_total)

    def test_value_and_clamp(self):
        wf = self.rt(budget=0.025)  # each fake agent costs 0.01
        self.assertAlmostEqual(wf.remaining(), 0.025)
        wf.agent("a")
        wf.agent("b")  # spent 0.02
        self.assertAlmostEqual(wf.remaining(), 0.005)
        wf.agent("c")  # spent 0.03 -> clamp at 0
        self.assertEqual(wf.remaining(), 0.0)
        self.assertEqual(wf.budget_total, 0.025)

    def test_reflects_budget_setter(self):
        wf = self.rt()
        self.assertEqual(wf.remaining(), float("inf"))
        wf.budget(1.0)
        self.assertAlmostEqual(wf.remaining(), 1.0)


class TestExtractLastJson(Base):
    def test_object_and_array(self):
        self.assertEqual(_extract_last_json('x\n{"a": 1}'), {"a": 1})
        self.assertEqual(_extract_last_json('x\n[1, 2, 3]'), [1, 2, 3])

    def test_final_line_beats_restated_schema(self):
        text = 'schema {"type":"object"}\nFinal answer:\n{"a": 2}'
        self.assertEqual(_extract_last_json(text), {"a": 2})

    def test_multiline_pretty(self):
        self.assertEqual(_extract_last_json('Here:\n{\n  "k": 1\n}'), {"k": 1})

    def test_multiline_pretty_array_not_inner_element(self):
        # The whole array must win, not the inner object on its own line.
        self.assertEqual(_extract_last_json('[\n  {"a": 1}\n]'), [{"a": 1}])

    def test_top_level_scalars(self):
        # number / bool / string / null answers on the final line are recoverable.
        self.assertEqual(_extract_last_json("reasoning...\n42"), 42)
        self.assertEqual(_extract_last_json("done\ntrue"), True)
        self.assertEqual(_extract_last_json('answer:\n"ok"'), "ok")
        self.assertIsNone(_extract_last_json("x\nnull"))  # JSON null is a real value

    def test_fenced(self):
        self.assertEqual(_extract_last_json('```\n{"k": "v"}\n```'), {"k": "v"})

    def test_none(self):
        self.assertIsNone(_extract_last_json("no json here"))
        self.assertIsNone(_extract_last_json(""))

    def test_deeply_nested_single_line_no_crash(self):
        # A pathologically deep single-line value must not let RecursionError escape.
        self.assertIsNone(_extract_last_json("here:\n" + "[" * 20000 + "]" * 20000))


class TestShapeSchema(Base):
    def test_required_and_type(self):
        errs = _validate_shape(
            {"a": "x"},
            {"type": "object", "required": ["a", "b"], "properties": {"a": {"type": "integer"}}})
        self.assertTrue(any("b" in e for e in errs))
        self.assertTrue(any("a" in e for e in errs))

    def test_additional_properties_false(self):
        errs = _validate_shape(
            {"a": 1, "x": 2},
            {"type": "object", "additionalProperties": False, "properties": {"a": {"type": "integer"}}})
        self.assertTrue(any("x" in e for e in errs))

    def test_enum(self):
        self.assertTrue(_validate_shape("z", {"enum": ["a", "b"]}))
        self.assertEqual(_validate_shape("a", {"enum": ["a", "b"]}), [])

    def test_array_items(self):
        errs = _validate_shape([1, "x"], {"type": "array", "items": {"type": "integer"}})
        self.assertEqual(len(errs), 1)

    def test_check_rejects_unknown_keyword(self):
        with self.assertRaises(ValueError):
            _check_schema_def({"type": "object", "anyOf": []})

    def test_check_rejects_unknown_type(self):
        with self.assertRaises(ValueError):
            _check_schema_def({"type": "frobnicate"})


class TestStructured(Base):
    SCHEMA = {"type": "object", "required": ["ok"], "properties": {"ok": {"type": "boolean"}}}

    def test_valid_first_try(self):
        wf = self.rt()
        s = wf.structured("give me " + fake('{"_content": "{\\"ok\\": true}"}'), self.SCHEMA)
        self.assertIsInstance(s, Structured)
        self.assertTrue(s.ok)
        self.assertEqual(s.value, {"ok": True})
        self.assertEqual(s.attempts, 1)

    def test_json_null_is_valid_value(self):
        wf = self.rt()
        s = wf.structured("give me " + fake('{"_content": "null"}'), {"type": "null"})
        self.assertTrue(s.ok)
        self.assertIsNone(s.value)

    def test_negative_retries_raise(self):
        wf = self.rt()
        with self.assertRaises(ValueError):
            wf.structured("x", {"type": "object"}, retries=-1)

    def test_never_valid_exhausts_retries(self):
        wf = self.rt()
        s = wf.structured("x " + fake('{"_content": "{\\"nope\\": 1}"}'),
                          {"type": "object", "required": ["ok"]}, retries=2)
        self.assertFalse(s.ok)
        self.assertEqual(s.attempts, 3)
        self.assertEqual(s.value, {"nope": 1})  # last parsed value retained

    def test_agent_failure_short_circuits(self):
        wf = self.rt()
        s = wf.structured("x " + fake('{"_exit": 2}'), {"type": "object"}, retries=3)
        self.assertFalse(s.ok)
        self.assertEqual(s.attempts, 1)  # no retries on a process failure

    def test_retry_then_success_via_stub(self):
        # The static fake can't vary by attempt, so stub wf.agent with queued results.
        wf = self.rt()
        queue = [
            AgentResult(content='{"nope": 1}', session_id="s", nano_aiu=0,
                        output_tokens=1, exit_code=0),
            AgentResult(content='{"ok": true}', session_id="s", nano_aiu=0,
                        output_tokens=1, exit_code=0),
        ]
        calls = {"n": 0}

        def stub(prompt, **kw):
            r = queue[calls["n"]]
            calls["n"] += 1
            return r

        wf.agent = stub
        s = wf.structured("anything", self.SCHEMA, retries=2)
        self.assertTrue(s.ok)
        self.assertEqual(s.value, {"ok": True})
        self.assertEqual(s.attempts, 2)
        self.assertEqual(calls["n"], 2)

    def test_callable_validator(self):
        wf = self.rt()

        def validate(obj):
            return "" if isinstance(obj, dict) and obj.get("n", 0) > 0 else "n must be > 0"

        s = wf.structured("x " + fake('{"_content": "{\\"n\\": 5}"}'), validate)
        self.assertTrue(s.ok)
        self.assertEqual(s.value, {"n": 5})

    def test_shape_plus_semantic_validator(self):
        wf = self.rt()

        def validate(obj):
            return "" if obj.get("n", 0) > 0 else "n must be > 0"

        s = wf.structured(
            "x " + fake('{"_content": "{\\"n\\": 5}"}'),
            {"type": "object", "required": ["n"], "properties": {"n": {"type": "integer"}}},
            validate=validate,
        )
        self.assertTrue(s.ok)
        self.assertEqual(s.value, {"n": 5})

    def test_shape_plus_semantic_validator_retries(self):
        wf = self.rt()
        queue = [
            AgentResult(content='{"n": 0}', session_id="s", nano_aiu=0,
                        output_tokens=1, exit_code=0),
            AgentResult(content='{"n": 2}', session_id="s", nano_aiu=0,
                        output_tokens=1, exit_code=0),
        ]
        calls = {"n": 0}

        def stub(prompt, **kw):
            r = queue[calls["n"]]
            calls["n"] += 1
            return r

        def validate(obj):
            return "" if obj.get("n", 0) > 0 else "n must be > 0"

        wf.agent = stub
        s = wf.structured(
            "anything",
            {"type": "object", "required": ["n"], "properties": {"n": {"type": "integer"}}},
            validate=validate,
            retries=2,
        )
        self.assertTrue(s.ok)
        self.assertEqual(s.value, {"n": 2})
        self.assertEqual(s.attempts, 2)
        self.assertEqual(calls["n"], 2)

    def test_callable_validator_boolean_reject_does_not_crash(self):
        # A predicate that returns a bare True for "invalid" must not raise (was a TypeError
        # from iterating a non-iterable error value); it should just fail validation.
        wf = self.rt()
        s = wf.structured("x " + fake('{"_content": "{\\"n\\": 5}"}'),
                          lambda obj: True, retries=0)
        self.assertFalse(s.ok)
        self.assertEqual(s.attempts, 1)

    def test_unsupported_keyword_raises_before_spending(self):
        wf = self.rt()
        with self.assertRaises(ValueError):
            wf.structured("x", {"type": "object", "patternProperties": {}})
        self.assertEqual(len(wf.results), 0)  # rejected before any agent ran


class TestExtractLastJsonObject(Base):
    def test_trailing(self):
        self.assertEqual(_extract_last_json_object('blah\n{"a": 1}')["a"], 1)

    def test_brace_in_string(self):
        obj = _extract_last_json_object('reason\n{"why": "use a } brace", "ok": true}')
        self.assertEqual(obj["why"], "use a } brace")
        self.assertTrue(obj["ok"])

    def test_last_object_wins(self):
        obj = _extract_last_json_object('{"x": 1} middle {"x": 2}')
        self.assertEqual(obj["x"], 2)

    def test_last_object_wins_even_when_final_line_is_scalar(self):
        obj = _extract_last_json_object('schema {"x": 1}\nfinal:\ntrue')
        self.assertEqual(obj["x"], 1)

    def test_fenced(self):
        obj = _extract_last_json_object('```json\n{"k": "v"}\n```')
        self.assertEqual(obj["k"], "v")

    def test_none(self):
        self.assertIsNone(_extract_last_json_object("no json here"))
        self.assertIsNone(_extract_last_json_object(""))

    def test_deeply_nested_no_crash(self):
        self.assertIsNone(_extract_last_json_object('{"a":' * 1500))  # RecursionError must not escape


if __name__ == "__main__":
    unittest.main(verbosity=2)
