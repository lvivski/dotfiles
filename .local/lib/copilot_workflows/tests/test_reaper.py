"""Shutdown reaper tests: in-flight subagents must be killed, not orphaned.

Zero credits — subagents use tests/fake_copilot.py (its ``_sleep`` directive simulates
a hung agent). A timeout-bearing agent is launched in its own session, so without the
``kill_all_agents`` registry an interrupted run would orphan it (reparented to init).

    python3 -m unittest discover -s .local/lib/copilot_workflows/tests
"""
import os
import stat
import sys
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.dirname(os.path.dirname(HERE))  # .local/lib
if LIB not in sys.path:
    sys.path.insert(0, LIB)

from copilot_workflows import AgentSpec, kill_all_agents, run_agent  # noqa: E402
from copilot_workflows import Runtime  # noqa: E402
from copilot_workflows import agent as agent_mod  # noqa: E402

FAKE = os.path.join(HERE, "fake_copilot.py")


def _ensure_exec(path):
    st = os.stat(path)
    os.chmod(path, st.st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _live():
    with agent_mod._LIVE_LOCK:
        return dict(agent_mod._LIVE)


class TestReaper(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        _ensure_exec(FAKE)

    def tearDown(self):
        kill_all_agents()  # reap any straggler so a failure can't leak into the next test
        with agent_mod._LIVE_LOCK:
            agent_mod._LIVE.clear()

    def test_completed_agent_is_unregistered(self):
        # A normal run must leave the registry empty — no false "live" entry to kill later.
        res = run_agent(AgentSpec(prompt="hello", model="fake"), copilot_bin=FAKE)
        self.assertTrue(res.ok)
        self.assertEqual(_live(), {})

    def test_kill_all_agents_is_a_safe_noop_when_idle(self):
        self.assertEqual(_live(), {})
        kill_all_agents()  # must never raise even with nothing in flight
        self.assertEqual(_live(), {})

    def test_kill_all_agents_reaps_a_detached_in_flight_agent(self):
        # A timeout agent runs in its own session (start_new_session) so a parent-directed
        # signal never reaches it. Start one that hangs, then prove kill_all_agents reaps it.
        spec = AgentSpec(prompt='hang [[FAKE:{"_sleep": 10}]]', model="fake", timeout=60)
        box = {}

        def run():
            box["res"] = run_agent(spec, copilot_bin=FAKE)

        t = threading.Thread(target=run)
        t.start()

        live = {}
        deadline = time.time() + 5
        while time.time() < deadline and not live:
            time.sleep(0.02)
            live = _live()
        self.assertEqual(len(live), 1, "agent should have registered while running")

        _pid, (proc, new_session) = next(iter(live.items()))
        self.assertEqual(new_session, os.name == "posix")  # timeout agent => own session

        kill_all_agents()

        t.join(8)
        self.assertFalse(t.is_alive(), "run_agent should return promptly once reaped")
        self.assertIsNotNone(proc.poll(), "subprocess should be dead after kill_all_agents")
        self.assertEqual(_live(), {}, "registry must drain once the agent exits")
        self.assertFalse(box["res"].ok)  # a reaped agent is not a success

    def test_interrupt_stops_queued_launches_and_reaps(self):
        # The real-world case: a fan-out with many more items than workers. An interrupt on
        # the main thread mid-flight must NOT keep launching the queued agents (which would
        # re-hang the pool and re-orphan them); it must stop the queue and reap what's live.
        import threading
        launched = []
        lock = threading.Lock()
        wf = Runtime(copilot_bin=FAKE, model="fake", concurrency=2)

        def work(i):
            with lock:
                launched.append(i)
            if i == 0:
                time.sleep(0.3)        # let the first wave start, then simulate Ctrl-C
                raise KeyboardInterrupt
            return wf.agent('Q [[FAKE:{"_sleep": 5}]]', timeout=60)

        with self.assertRaises(KeyboardInterrupt):
            wf.fan_out(list(range(12)), work)

        self.assertLess(len(launched), 12, "queued items must not all launch after interrupt")
        self.assertEqual(_live(), {}, "every spawned agent must be reaped on interrupt")

    def test_toplevel_agent_interrupt_kills_and_unregisters(self):
        # A sequential (main-thread) agent — no fan-out — interrupted mid-run must kill its
        # subprocess and unregister it, not orphan it. Inject a real SIGINT into this process
        # while run_agent is blocked reading a hung agent.
        import signal as sig
        spec = AgentSpec(prompt='hang [[FAKE:{"_sleep": 10}]]', model="fake", timeout=60)
        captured = {}

        def fire():
            with agent_mod._LIVE_LOCK:
                captured["procs"] = [p for p, _ in agent_mod._LIVE.values()]
            os.kill(os.getpid(), sig.SIGINT)

        prev = sig.getsignal(sig.SIGINT)
        sig.signal(sig.SIGINT, sig.default_int_handler)  # ensure SIGINT -> KeyboardInterrupt
        timer = threading.Timer(0.6, fire)
        timer.daemon = True
        timer.start()
        try:
            with self.assertRaises(KeyboardInterrupt):
                run_agent(spec, copilot_bin=FAKE)
        finally:
            timer.cancel()
            sig.signal(sig.SIGINT, prev)

        self.assertTrue(captured.get("procs"), "agent should have been live when interrupted")
        for p in captured["procs"]:
            self.assertIsNotNone(p.poll(), "interrupted agent's subprocess must be killed")
        self.assertEqual(_live(), {}, "interrupted agent must be unregistered")


if __name__ == "__main__":
    unittest.main(verbosity=2)
