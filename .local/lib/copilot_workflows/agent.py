"""Spawn one `copilot -p` subagent and reduce its JSONL stream to an AgentResult."""
from __future__ import annotations

import json
import os
import signal
import subprocess
import threading
from collections.abc import Iterator
from contextlib import nullcontext
from dataclasses import dataclass


# --- live-subprocess registry --------------------------------------------------
# Timeout agents are launched in their own session (``start_new_session``) so a per-agent
# timeout can ``killpg`` the whole tree — which also detaches them from a parent-directed
# Ctrl-C. On interrupt a fan-out's worker threads sit blocked in ``proc.wait()``, unreachable
# by the main thread's KeyboardInterrupt, so the main thread reaches in through this registry
# to kill them (see ``kill_all_agents``); otherwise they orphan (reparent to init, still spending).
_LIVE_LOCK = threading.Lock()
_LIVE: dict[int, tuple[subprocess.Popen, bool]] = {}


def _register(proc: subprocess.Popen, new_session: bool) -> None:
    with _LIVE_LOCK:
        _LIVE[proc.pid] = (proc, new_session)


def _unregister(proc: subprocess.Popen) -> None:
    with _LIVE_LOCK:
        _LIVE.pop(proc.pid, None)


def kill_all_agents() -> None:
    """Kill every still-running subagent. Best-effort, idempotent.

    Called by the runtime when a parallel run is interrupted: its worker threads are blocked
    in ``proc.wait()`` and can't see the main thread's KeyboardInterrupt, so the main thread
    kills their (possibly detached) processes here — unblocking the workers and avoiding orphans.
    """
    with _LIVE_LOCK:
        live = list(_LIVE.values())
    for proc, new_session in live:
        _kill(proc, new_session)


@dataclass
class AgentSpec:
    """Everything needed to launch one subagent. Building a spec does not run it."""

    prompt: str
    model: str | None = None
    agent: str | None = None             # --agent <custom persona>
    effort: str | None = None            # --effort none|low|medium|high|xhigh|max
    context: str | None = None           # --context default|long_context (context window tier)
    cwd: str | None = None               # -C <dir> (worktree / isolation)
    allow: list[str] | None = None       # extra --allow-tool values
    deny: list[str] | None = None        # --deny-tool values (precedence over allow)
    allow_url: list[str] | None = None
    deny_url: list[str] | None = None
    add_dir: list[str] | None = None     # --add-dir
    mcp: str | None = None               # --additional-mcp-config (json or @file)
    disable_mcp: bool = False            # --disable-builtin-mcps (faster startup)
    allow_all_tools: bool = True         # blanket pre-auth; off for quarantine
    resume: str | None = None            # session id to resume (follow-up turns)
    timeout: float | None = None         # seconds; kills the process if exceeded
    label: str | None = None             # human label for logs/progress
    extra_args: list[str] | None = None

    def __post_init__(self):
        # Normalize a working dir to an absolute path so (a) the checkpoint fingerprint is
        # stable regardless of where cwf was launched, and (b) ``-C`` and the subprocess cwd
        # agree (a *relative* cwd would otherwise be applied twice — by Popen and by ``-C``).
        if self.cwd is not None:
            self.cwd = os.path.abspath(self.cwd)


@dataclass
class AgentResult:
    """Structured outcome of a subagent run."""

    content: str
    session_id: str | None
    premium_requests: float
    output_tokens: int
    exit_code: int
    model: str | None = None
    label: str | None = None
    error: str | None = None
    ok: bool = True
    cached: bool = False  # True when returned from a resumed run's checkpoint

    def __str__(self) -> str:  # convenient when a harness treats a result as text
        return self.content


def build_cmd(spec: AgentSpec, copilot_bin: str = "copilot") -> list[str]:
    """Translate an AgentSpec into a `copilot` argv (no shell)."""
    cmd = [copilot_bin, "-p", spec.prompt, "--output-format", "json", "--no-ask-user", "--no-color"]
    if spec.allow_all_tools:  # non-interactive needs tools pre-authorized
        cmd.append("--allow-all-tools")
    if spec.disable_mcp:
        cmd.append("--disable-builtin-mcps")
    for flag, value in (("--resume", spec.resume), ("--model", spec.model), ("--agent", spec.agent),
                        ("--effort", spec.effort), ("--context", spec.context),
                        ("--additional-mcp-config", spec.mcp), ("-C", spec.cwd)):
        if value:
            cmd += [flag, value]
    for flag, values in (("--allow-tool", spec.allow), ("--deny-tool", spec.deny),
                         ("--allow-url", spec.allow_url), ("--deny-url", spec.deny_url),
                         ("--add-dir", spec.add_dir)):
        for v in values or []:
            cmd += [flag, v]
    return cmd + list(spec.extra_args or [])


def _json_lines(stream) -> Iterator[dict]:
    """Yield parsed JSON objects from a stream of JSONL, skipping junk lines."""
    for line in stream:
        line = line.strip()
        if line:
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                pass


def _to_int(x) -> int:
    try:
        return int(x or 0)
    except (TypeError, ValueError):
        return 0


def _to_float(x) -> float:
    try:
        return float(x or 0)
    except (TypeError, ValueError):
        return 0.0


def _reduce(acc: dict, obj: dict) -> None:
    """Fold one JSONL event into the running result accumulator.

    Numeric fields are cast defensively: a malformed (non-numeric) value must
    never raise here, or it would escape ``run_agent`` and leak the timeout
    timer / hang ``proc.wait()``.
    """
    kind = obj.get("type")
    if kind == "assistant.message":
        data = obj.get("data") or {}
        acc["content"] = data.get("content") or acc["content"]   # last non-empty wins
        acc["tokens"] += _to_int(data.get("outputTokens"))
        acc["model"] = data.get("model") or acc["model"]
    elif kind == "result":
        acc["session"] = obj.get("sessionId", acc["session"])
        acc["premium"] += _to_float((obj.get("usage") or {}).get("premiumRequests"))


def _result(spec: AgentSpec, acc: dict, exit_code: int, *,
            killed: bool = False, stderr: str = "", error: str | None = None) -> AgentResult:
    content = acc["content"]
    if error is None:
        if killed:
            error = f"timed out after {spec.timeout}s"
        elif exit_code != 0:
            error = stderr.strip() or f"exited with code {exit_code}"
        elif content is None:
            error = "no assistant message in output"
    return AgentResult(
        content=content or "", session_id=acc["session"], premium_requests=acc["premium"],
        output_tokens=acc["tokens"], exit_code=exit_code, model=acc["model"], label=spec.label,
        error=error, ok=exit_code == 0 and content is not None and not killed and error is None,
    )


def run_agent(spec: AgentSpec, *, copilot_bin: str = "copilot",
              semaphore: threading.Semaphore | None = None,
              env: dict | None = None,
              abort: "threading.Event | None" = None) -> AgentResult:
    """Run one subagent to completion and return a structured result.

    Blocking and thread-safe; ``semaphore`` bounds how many subprocesses run at once.
    ``abort`` is a shutdown flag checked immediately after the child is registered: the
    registry lock makes spawn+register and the reaper's snapshot mutually exclusive, so a
    process can never slip through an interrupt unkilled (either the reaper sees it in the
    registry, or this check sees ``abort`` set and kills it).
    """
    acc = {"content": None, "tokens": 0, "premium": 0.0, "session": None, "model": spec.model}
    killed = threading.Event()
    stderr: list[str] = []
    stream_error: str | None = None
    exit_code = 1
    proc = drain = timer = None
    # Timeout agents get their own session so one kill takes down the whole tree (Copilot plus
    # any shells/tools it spawned). That detachment also hides them from a parent-directed
    # Ctrl-C, so the registry and ``abort`` flag are what guarantee they're reaped on exit.
    new_session = bool(spec.timeout) and os.name == "posix"

    with (semaphore or nullcontext()):
        try:
            proc = subprocess.Popen(
                build_cmd(spec, copilot_bin), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                cwd=spec.cwd, env=env, text=True, encoding="utf-8", errors="replace", bufsize=1,
                start_new_session=new_session)
            _register(proc, new_session)
            if abort is not None and abort.is_set():
                _kill(proc, new_session)  # an interrupt is already underway
            # Drain stderr off-thread so a full stderr pipe can't deadlock the stdout read.
            drain = threading.Thread(target=_drain, args=(proc.stderr, stderr), daemon=True)
            drain.start()
            if spec.timeout:
                timer = threading.Timer(spec.timeout, _on_timeout, args=(proc, killed, new_session))
                timer.daemon = True
                timer.start()
            for obj in _json_lines(proc.stdout):
                _reduce(acc, obj)
        except FileNotFoundError:
            if proc is None:  # the copilot binary itself is missing
                return _result(spec, acc, 127, error=f"copilot binary not found: {copilot_bin!r}")
            raise
        except Exception as e:  # a read/parse error (other spawn failures re-raise below)
            if proc is None:
                raise
            stream_error = f"error reading subagent output: {e}"
        finally:
            # One reaper for every abnormal exit: a read error, the timeout firing, an
            # interrupt, or ``abort`` all leave the child still running, so kill it before
            # waiting (so wait() can't hang) and always unregister.
            if proc is not None:
                if proc.poll() is None:
                    _kill(proc, new_session)
                exit_code = proc.wait()
                if timer is not None:
                    timer.cancel()
                if drain is not None:
                    drain.join(1.0)
                proc.stdout.close()
                proc.stderr.close()
                _unregister(proc)

    return _result(spec, acc, exit_code, killed=killed.is_set(),
                   stderr="".join(stderr), error=stream_error)


def _drain(pipe, sink: list[str]) -> None:
    try:
        sink.extend(pipe)
    except Exception:
        pass


def _kill(proc, new_session: bool) -> None:
    """Kill the subprocess — its whole process group when it has its own session."""
    try:
        if new_session:
            # A session leader's PGID equals its PID; kill the group by PID directly rather
            # than via os.getpgid(), which could read a reused PID's group after it exits.
            os.killpg(proc.pid, signal.SIGKILL)
        else:
            proc.kill()
    except Exception:  # already exited / no such group
        pass


def _on_timeout(proc, killed: threading.Event, new_session: bool) -> None:
    killed.set()
    _kill(proc, new_session)
