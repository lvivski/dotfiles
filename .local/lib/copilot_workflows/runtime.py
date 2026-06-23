"""The `wf` runtime: spawn and coordinate subagents with budgets, checkpoints, worktrees, progress."""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from typing import Any, Callable, List, Optional, Sequence, Union

from .agent import AgentResult, AgentSpec, run_agent
from .patterns import PatternsMixin
from .progress import format_agent_line
from .worktree import WorktreeManager, find_repo_root


def default_concurrency() -> int:
    cpu = os.cpu_count() or 4
    return min(16, max(2, cpu - 1))


class BudgetExceeded(Exception):
    """Raised (only in strict mode) when premium-request spend passes the cap."""


def _skipped_result(spec: AgentSpec) -> AgentResult:
    return AgentResult(
        content="", session_id=None, premium_requests=0.0, output_tokens=0,
        exit_code=-1, model=spec.model, label=spec.label,
        error="skipped: budget reached", ok=False,
    )


# Spec fields that define an agent's identity for checkpoint keys. Ephemeral or
# cosmetic fields (resume session id, timeout, label) are deliberately excluded.
_KEY_FIELDS = (
    "prompt", "model", "agent", "effort", "cwd", "resume", "disable_mcp", "mcp",
    "allow", "deny", "allow_url", "deny_url", "add_dir", "allow_all_tools",
    "extra_args",
)


class Runtime(PatternsMixin):
    def __init__(
        self,
        *,
        concurrency: Optional[int] = None,
        copilot_bin: str = "copilot",
        default_model: Optional[str] = None,
        default_disable_mcp: bool = False,
        budget: Optional[float] = None,
        strict_budget: bool = False,
        logger: Optional[Callable[..., None]] = None,
        progress: Optional[Callable[[dict], None]] = None,
        dry_run: bool = False,
        run_dir: Optional[str] = None,
        checkpoints: Any = None,            # CheckpointStore or None
        repo_root: Optional[str] = None,
    ):
        self.concurrency = concurrency or default_concurrency()
        self.copilot_bin = copilot_bin
        self.default_model = default_model
        self.default_disable_mcp = default_disable_mcp
        self._budget = budget
        self.strict_budget = strict_budget
        self._spent_lock = threading.Lock()
        self._spent = checkpoints.prior_spent if checkpoints is not None else 0.0
        self._budget_hit = threading.Event()
        self._sem = threading.BoundedSemaphore(self.concurrency)
        self._log = logger or (lambda *a, **k: None)
        self._progress = progress
        self._seq = 0
        self._seq_lock = threading.Lock()
        self._phase: Optional[str] = None
        self._phase_stack: List[str] = []
        self.dry_run = dry_run
        self.run_dir = run_dir
        self.checkpoints = checkpoints
        self.results: List[AgentResult] = []
        self._results_lock = threading.Lock()
        # checkpoint key occurrence counter (per identical-spec fingerprint)
        self._occurrence: dict = {}
        self._occ_lock = threading.Lock()
        # lazily-created worktree manager
        self._repo_root = repo_root
        self._wt_mgr: Optional[WorktreeManager] = None
        self._wt_lock = threading.Lock()

    # ---- introspection -------------------------------------------------
    @property
    def spent(self) -> float:
        with self._spent_lock:
            return self._spent

    @property
    def budget_hit(self) -> bool:
        return self._budget_hit.is_set()

    def budget(self, premium_requests: Optional[float]) -> None:
        """Set (or clear) the premium-request budget for the run."""
        self._budget = premium_requests

    def log(self, *args: Any) -> None:
        self._log(*args)

    @contextmanager
    def phase(self, name: str):
        """Group the agents launched inside this block under a phase label."""
        self._phase_stack.append(name)
        self._phase = name
        try:
            yield
        finally:
            self._phase_stack.pop()
            self._phase = self._phase_stack[-1] if self._phase_stack else None

    # ---- spec building (no execution) ----------------------------------
    def spec(self, prompt: str, **kw: Any) -> AgentSpec:
        if kw.get("model") is None:
            kw["model"] = self.default_model
        kw.setdefault("disable_mcp", self.default_disable_mcp)
        return AgentSpec(prompt=prompt, **kw)

    # ---- single agent --------------------------------------------------
    def agent(self, prompt_or_spec: Union[str, AgentSpec], *, key: Optional[str] = None, **kw: Any) -> AgentResult:
        spec = prompt_or_spec if isinstance(prompt_or_spec, AgentSpec) else self.spec(prompt_or_spec, **kw)
        label = spec.label or "agent"
        seq = self._next_seq()
        self._emit({"ev": "start", "seq": seq, "label": label, "model": spec.model,
                    "phase": self._phase, "t": time.time()})

        if self.dry_run:
            res = AgentResult(content="[dry-run]", session_id=None, premium_requests=0.0,
                              output_tokens=0, exit_code=0, model=spec.model, label=spec.label)
            self._finish(seq, label, res, skipped=False)
            return res

        ckpt_key = key or self._agent_key(spec)
        cached = self.checkpoints.get(ckpt_key) if self.checkpoints is not None else None
        if cached is not None:
            cached.cached = True
            self._finish(seq, label, cached, skipped=False)
            return cached

        # Acquire the concurrency slot, THEN gate on budget: an agent that waited
        # behind the cap re-checks here, so a budget drained by in-flight agents
        # stops it (bounding overspend to ~concurrency, not the whole batch).
        skipped = False
        strict_stop = False
        with self._sem:
            if self._over_budget():
                self._budget_hit.set()
                if self.strict_budget:
                    self._finish(seq, label, _skipped_result(spec), skipped=True)
                    raise BudgetExceeded("budget %.2f reached (spent %.2f)" % (self._budget, self.spent))
                res = _skipped_result(spec)
                skipped = True
            else:
                res = run_agent(spec, copilot_bin=self.copilot_bin)
                self._charge(res.premium_requests)
                if self.checkpoints is not None and res.ok:
                    self.checkpoints.put(ckpt_key, res)
                strict_stop = self.strict_budget and self._over_budget()

        self._finish(seq, label, res, skipped=skipped)
        if strict_stop:
            raise BudgetExceeded("budget %.2f exceeded (spent %.2f)" % (self._budget, self.spent))
        return res

    def _finish(self, seq: int, label: str, res: AgentResult, *, skipped: bool) -> None:
        with self._results_lock:
            self.results.append(res)
        self._emit({"ev": "end", "seq": seq, "label": label, "ok": res.ok,
                    "cached": res.cached, "skipped": skipped, "cr": res.premium_requests,
                    "tok": res.output_tokens, "error": res.error, "model": res.model,
                    "phase": self._phase, "t": time.time()})

    def follow_up(self, result: AgentResult, prompt: str, **kw: Any) -> AgentResult:
        """Send another turn to the same session (multi-turn via --resume)."""
        if not result.session_id:
            raise ValueError("cannot follow up: result has no session_id")
        kw["resume"] = result.session_id
        return self.agent(prompt, **kw)

    # ---- fan-out (map + barrier) ---------------------------------------
    def fan_out(
        self,
        items: Sequence[Any],
        fn: Callable[[Any], Any],
        *,
        concurrency: Optional[int] = None,
    ) -> List[Any]:
        """Run ``fn(item)`` for every item in parallel; return results in order."""
        items = list(items)
        if not items:
            return []
        workers = min(concurrency or self.concurrency, len(items))
        results: List[Any] = [None] * len(items)
        budget_error = None
        branch_error = None

        def task(i: int, item: Any):
            return i, fn(item)

        with ThreadPoolExecutor(max_workers=workers) as ex:
            futs = [ex.submit(task, i, it) for i, it in enumerate(items)]
            for fut in as_completed(futs):
                try:
                    i, r = fut.result()
                    results[i] = r
                except BudgetExceeded as e:  # strict mode only
                    budget_error = budget_error or e
                except Exception as e:  # surface real branch bugs instead of leaving None
                    self._log("  ! fan_out branch failed: %s" % e)
                    branch_error = branch_error or e
        if budget_error is not None:
            raise budget_error
        if branch_error is not None:
            raise branch_error
        return results

    # ---- worktrees -----------------------------------------------------
    @contextmanager
    def worktree(self, name: str, base_ref: Optional[str] = None):
        """Give an agent its own git worktree for the duration of the block."""
        self._ensure_worktree_manager()
        path = self._wt_mgr.create(name, base_ref)
        try:
            yield path
        finally:
            self._wt_mgr.remove(path)

    def _ensure_worktree_manager(self) -> None:
        with self._wt_lock:
            if self._wt_mgr is not None:
                return
            root = self._repo_root or find_repo_root(os.getcwd())
            if not root:
                raise RuntimeError(
                    "wf.worktree requires a git repository (none found at %s)" % os.getcwd()
                )
            if self.run_dir:
                base = os.path.join(self.run_dir, "worktrees")
            else:
                import tempfile
                base = tempfile.mkdtemp(prefix="cwf-wt-")
            self._wt_mgr = WorktreeManager(root, base, logger=self._log)

    def cleanup(self) -> None:
        """Remove any worktrees created during the run. Safe to call always."""
        if self._wt_mgr is not None:
            try:
                self._wt_mgr.cleanup_all()
            except Exception as e:
                self._log("  ! worktree cleanup failed: %s" % e)

    # ---- checkpoint keys -----------------------------------------------
    def _agent_key(self, spec: AgentSpec) -> str:
        base = self._spec_fingerprint(spec)
        with self._occ_lock:
            n = self._occurrence.get(base, 0)
            self._occurrence[base] = n + 1
        return "%s-%d" % (base[:16], n)

    @staticmethod
    def _spec_fingerprint(spec: AgentSpec) -> str:
        payload = {f: getattr(spec, f) for f in _KEY_FIELDS}
        blob = json.dumps(payload, sort_keys=True, default=str)
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()

    # ---- budget accounting ---------------------------------------------
    def _over_budget(self) -> bool:
        if self._budget is None:
            return False
        with self._spent_lock:
            return self._spent >= self._budget

    def _charge(self, amount: float) -> None:
        with self._spent_lock:
            self._spent += amount
            over = self._budget is not None and self._spent >= self._budget
        if over:
            self._budget_hit.set()

    # ---- progress emission ---------------------------------------------
    def _next_seq(self) -> int:
        with self._seq_lock:
            self._seq += 1
            return self._seq

    def _emit(self, rec: dict) -> None:
        prog = self._progress
        if prog is not None:
            try:
                prog(rec)
            except Exception:
                pass
            return
        # Fallback when no reporter is installed (library use / tests): one tidy
        # line per finished agent.
        if rec.get("ev") == "end":
            self._log(format_agent_line(rec))
