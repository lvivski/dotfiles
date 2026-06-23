"""Spawn one `copilot -p` subagent and reduce its JSONL stream to an AgentResult."""
from __future__ import annotations

import json
import subprocess
import threading
from contextlib import nullcontext
from dataclasses import dataclass
from typing import Iterator, List, Optional


@dataclass
class AgentSpec:
    """Everything needed to launch one subagent. Building a spec does not run it."""

    prompt: str
    model: Optional[str] = None
    agent: Optional[str] = None          # --agent <custom persona>
    effort: Optional[str] = None         # --effort none|low|medium|high|xhigh|max
    cwd: Optional[str] = None            # -C <dir> (worktree / isolation)
    allow: Optional[List[str]] = None    # extra --allow-tool values
    deny: Optional[List[str]] = None     # --deny-tool values (precedence over allow)
    allow_url: Optional[List[str]] = None
    deny_url: Optional[List[str]] = None
    add_dir: Optional[List[str]] = None  # --add-dir
    mcp: Optional[str] = None            # --additional-mcp-config (json or @file)
    disable_mcp: bool = False            # --disable-builtin-mcps (faster startup)
    allow_all_tools: bool = True         # blanket pre-auth; off for quarantine
    resume: Optional[str] = None         # session id to resume (follow-up turns)
    timeout: Optional[float] = None      # seconds; kills the process if exceeded
    label: Optional[str] = None          # human label for logs/progress
    extra_args: Optional[List[str]] = None


@dataclass
class AgentResult:
    """Structured outcome of a subagent run."""

    content: str
    session_id: Optional[str]
    premium_requests: float
    output_tokens: int
    exit_code: int
    model: Optional[str] = None
    label: Optional[str] = None
    error: Optional[str] = None
    ok: bool = True
    cached: bool = False  # True when returned from a resumed run's checkpoint

    def __str__(self) -> str:  # convenient when a harness treats a result as text
        return self.content


def build_cmd(spec: AgentSpec, copilot_bin: str = "copilot") -> List[str]:
    """Translate an AgentSpec into a `copilot` argv (no shell)."""
    cmd = [copilot_bin, "-p", spec.prompt, "--output-format", "json", "--no-ask-user", "--no-color"]
    if spec.allow_all_tools:  # non-interactive needs tools pre-authorized
        cmd.append("--allow-all-tools")
    if spec.disable_mcp:
        cmd.append("--disable-builtin-mcps")
    for flag, value in (("--resume", spec.resume), ("--model", spec.model), ("--agent", spec.agent),
                        ("--effort", spec.effort), ("--additional-mcp-config", spec.mcp), ("-C", spec.cwd)):
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
            killed: bool = False, stderr: str = "", error: Optional[str] = None) -> AgentResult:
    content = acc["content"]
    if error is None:
        if killed:
            error = "timed out after %ss" % spec.timeout
        elif exit_code != 0:
            error = stderr.strip() or "exited with code %s" % exit_code
        elif content is None:
            error = "no assistant message in output"
    return AgentResult(
        content=content or "", session_id=acc["session"], premium_requests=acc["premium"],
        output_tokens=acc["tokens"], exit_code=exit_code, model=acc["model"], label=spec.label,
        error=error, ok=exit_code == 0 and content is not None and not killed and error is None,
    )


def run_agent(spec: AgentSpec, *, copilot_bin: str = "copilot",
              semaphore: "Optional[threading.Semaphore]" = None,
              env: Optional[dict] = None) -> AgentResult:
    """Run one subagent to completion and return a structured result.

    Blocking and thread-safe; ``semaphore`` bounds how many subprocesses run at once.
    """
    acc = {"content": None, "tokens": 0, "premium": 0.0, "session": None, "model": spec.model}
    killed = threading.Event()
    stderr: List[str] = []

    with (semaphore or nullcontext()):
        try:
            proc = subprocess.Popen(
                build_cmd(spec, copilot_bin), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                cwd=spec.cwd, env=env, text=True, encoding="utf-8", errors="replace", bufsize=1)
        except FileNotFoundError:
            return _result(spec, acc, 127, error="copilot binary not found: %r" % copilot_bin)

        stream_error: Optional[str] = None
        with proc:  # context manager closes the pipes (and waits) on exit
            # Drain stderr off-thread so a full stderr pipe can't deadlock the stdout read.
            drain = threading.Thread(target=_drain, args=(proc.stderr, stderr), daemon=True)
            drain.start()
            timer = None
            if spec.timeout:
                timer = threading.Timer(spec.timeout, _on_timeout, args=(proc, killed))
                timer.daemon = True
                timer.start()
            try:
                for obj in _json_lines(proc.stdout):
                    _reduce(acc, obj)
            except Exception as e:  # a read/parse error must not leak the timer or hang wait()
                stream_error = "error reading subagent output: %s" % e
                try:
                    proc.kill()
                except Exception:
                    pass
            finally:
                exit_code = proc.wait()
                if timer:
                    timer.cancel()
                drain.join(1.0)

    return _result(spec, acc, exit_code, killed=killed.is_set(),
                   stderr="".join(stderr), error=stream_error)


def _drain(pipe, sink: List[str]) -> None:
    try:
        sink.extend(pipe)
    except Exception:
        pass


def _on_timeout(proc, killed: threading.Event) -> None:
    killed.set()
    try:
        proc.kill()
    except Exception:
        pass
