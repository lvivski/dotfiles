"""The `wf` runtime: spawn and coordinate subagents with budgets, checkpoints, worktrees, progress."""
from __future__ import annotations

import hashlib
import inspect
import io
import json
import os
import threading
import time
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager, redirect_stdout
from typing import Any

from .agent import AgentResult, AgentSpec, run_agent
from .checkpoint import default_workflows_dir
from .patterns import PatternsMixin
from .progress import format_agent_line
from .sandbox import SandboxError, harness_globals, lint_imports
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


def _positional_arity(fn: Callable) -> int | None:
    """How many positional args ``fn`` accepts (capped at 3), or None if unknown.

    ``*args`` counts as 3 (give it everything). Used to call pipeline stages with as
    many of ``(prev, item, index)`` as they want, mirroring JS's ignore-extra-args.
    """
    try:
        params = inspect.signature(fn).parameters.values()
    except (ValueError, TypeError):
        return None
    count = 0
    for p in params:
        if p.kind == inspect.Parameter.VAR_POSITIONAL:
            return 3
        if p.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD):
            count += 1
    return count


def _call_stage(stage: Callable, prev: Any, item: Any, index: int) -> Any:
    """Call a pipeline stage with as many of ``(prev, item, index)`` as it accepts."""
    n = _positional_arity(stage)
    if n is None:
        return stage(prev)
    return stage(*(prev, item, index)[:min(n, 3)])


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
        concurrency: int | None = None,
        copilot_bin: str = "copilot",
        default_model: str | None = None,
        default_disable_mcp: bool = False,
        budget: float | None = None,
        strict_budget: bool = False,
        logger: Callable[..., None] | None = None,
        progress: Callable[[dict], None] | None = None,
        dry_run: bool = False,
        run_dir: str | None = None,
        checkpoints: Any = None,            # CheckpointStore or None
        repo_root: str | None = None,
        restricted: bool = False,
    ):
        self.concurrency = concurrency or default_concurrency()
        self.copilot_bin = copilot_bin
        self.default_model = default_model
        self.default_disable_mcp = default_disable_mcp
        self.restricted = restricted
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
        self._phase: str | None = None
        self._phase_stack: list[str] = []
        self.dry_run = dry_run
        self.run_dir = run_dir
        self.checkpoints = checkpoints
        self.results: list[AgentResult] = []
        self._results_lock = threading.Lock()
        # checkpoint key occurrence counter (per identical-spec fingerprint)
        self._occurrence: dict = {}
        self._occ_lock = threading.Lock()
        # lazily-created worktree manager
        self._repo_root = repo_root
        self._wt_mgr: WorktreeManager | None = None
        self._wt_lock = threading.Lock()
        # inline sub-workflow state (wf.workflow): a key-scope namespaces a child's
        # checkpoint keys so they can't collide/misalign with the parent's on resume.
        self._key_scope = ""
        self._workflow_depth = 0
        self._workflow_calls = 0

    # ---- introspection -------------------------------------------------
    @property
    def spent(self) -> float:
        with self._spent_lock:
            return self._spent

    @property
    def budget_total(self) -> float | None:
        """The premium-request cap for the run, or None if uncapped."""
        return self._budget

    def remaining(self) -> float:
        """Premium credits left before the budget cap (``inf`` if uncapped).

        Advisory — for dynamic ``while wf.remaining() > N:`` loops. With no budget set
        this is ``inf``, so always pair such loops with ``wf.budget_total is not None``
        and/or a ``max_iters`` guard to avoid runaway when ``--budget`` is omitted.
        """
        if self._budget is None:
            return float("inf")
        with self._spent_lock:
            return max(0.0, self._budget - self._spent)

    @property
    def budget_hit(self) -> bool:
        return self._budget_hit.is_set()

    def budget(self, premium_requests: float | None) -> None:
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
    def agent(self, prompt_or_spec: str | AgentSpec, *, key: str | None = None,
              phase: str | None = None, **kw: Any) -> AgentResult:
        spec = prompt_or_spec if isinstance(prompt_or_spec, AgentSpec) else self.spec(prompt_or_spec, **kw)
        label = spec.label or "agent"
        # Explicit phase wins over the global phase() context — concurrent pipeline()
        # / parallel() items would otherwise race on the shared self._phase.
        eff_phase = phase if phase is not None else self._phase
        seq = self._next_seq()
        self._emit({"ev": "start", "seq": seq, "label": label, "model": spec.model,
                    "phase": eff_phase, "t": time.time()})

        if self.dry_run:
            res = AgentResult(content="[dry-run]", session_id=None, premium_requests=0.0,
                              output_tokens=0, exit_code=0, model=spec.model, label=spec.label)
            self._finish(seq, label, res, skipped=False, phase=eff_phase)
            return res

        ckpt_key = self._scoped_key(key) if key is not None else self._agent_key(spec)
        cached = self.checkpoints.get(ckpt_key) if self.checkpoints is not None else None
        if cached is not None:
            cached.cached = True
            self._finish(seq, label, cached, skipped=False, phase=eff_phase)
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
                    self._finish(seq, label, _skipped_result(spec), skipped=True, phase=eff_phase)
                    raise BudgetExceeded(f"budget {self._budget:.2f} reached (spent {self.spent:.2f})")
                res = _skipped_result(spec)
                skipped = True
            else:
                res = run_agent(spec, copilot_bin=self.copilot_bin)
                self._charge(res.premium_requests)
                if self.checkpoints is not None and res.ok:
                    self.checkpoints.put(ckpt_key, res)
                strict_stop = self.strict_budget and self._over_budget()

        self._finish(seq, label, res, skipped=skipped, phase=eff_phase)
        if strict_stop:
            raise BudgetExceeded(f"budget {self._budget:.2f} exceeded (spent {self.spent:.2f})")
        return res

    def _finish(self, seq: int, label: str, res: AgentResult, *, skipped: bool,
                phase: str | None = None) -> None:
        with self._results_lock:
            self.results.append(res)
        self._emit({"ev": "end", "seq": seq, "label": label, "ok": res.ok,
                    "cached": res.cached, "skipped": skipped, "cr": res.premium_requests,
                    "tok": res.output_tokens, "error": res.error, "model": res.model,
                    "phase": phase if phase is not None else self._phase, "t": time.time()})

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
        concurrency: int | None = None,
    ) -> list[Any]:
        """Run ``fn(item)`` for every item in parallel; return results in order."""
        items = list(items)
        if not items:
            return []
        workers = min(concurrency or self.concurrency, len(items))
        results: list[Any] = [None] * len(items)
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
                    self._log(f"  ! fan_out branch failed: {e}")
                    branch_error = branch_error or e
        if budget_error is not None:
            raise budget_error
        if branch_error is not None:
            raise branch_error
        return results

    # ---- concurrency primitive shared by pipeline()/parallel() ---------
    def _concurrent_map(
        self,
        n: int,
        work: Callable[[int], Any],
        *,
        concurrency: int | None = None,
        drop_errors: bool = False,
    ) -> list[Any]:
        """Run ``work(i)`` for ``i`` in ``range(n)`` concurrently; results in order.

        ``BudgetExceeded`` (strict mode) always aborts the whole map. Any other
        exception either drops that slot to ``None`` (``drop_errors=True``) or aborts
        by re-raising the first one (``drop_errors=False``).
        """
        if n <= 0:
            return []
        workers = min(concurrency or self.concurrency, n)
        results: list[Any] = [None] * n
        budget_error = None
        branch_error = None

        def run(i: int):
            try:
                return i, work(i)
            except BudgetExceeded:
                raise
            except Exception as e:  # noqa: BLE001 — policy decided by drop_errors
                if drop_errors:
                    self._log(f"  ! dropped item {i}: {e}")
                    return i, None
                raise

        with ThreadPoolExecutor(max_workers=workers) as ex:
            futs = [ex.submit(run, i) for i in range(n)]
            for fut in as_completed(futs):
                try:
                    i, r = fut.result()
                    results[i] = r
                except BudgetExceeded as e:  # strict mode only
                    budget_error = budget_error or e
                except Exception as e:  # surfaces only when drop_errors=False
                    branch_error = branch_error or e
        if budget_error is not None:
            raise budget_error
        if branch_error is not None:
            raise branch_error
        return results

    # ---- pipeline (streaming, NO barrier between stages) ---------------
    def pipeline(self, items: Sequence[Any], *stages: Callable[..., Any],
                 concurrency: int | None = None) -> list[Any]:
        """Stream each item through ``stages`` independently — no barrier between stages.

        Unlike ``fan_out``/``synthesize`` (which are barriers), ``pipeline`` lets item A
        reach stage 3 while item B is still in stage 1, so wall-clock is the slowest
        single-item *chain*, not the sum of the slowest item per stage. Prefer this for
        multi-stage work; use a barrier (``fan_out``/``parallel``) only when a stage
        genuinely needs every prior result at once (dedupe/merge, zero-count early-exit,
        cross-item comparison).

        Each stage is invoked as ``stage(prev, item, index)`` and may accept 1, 2, or 3
        positional args; ``prev`` is the previous stage's return (the item itself for the
        first stage). A stage that raises drops that item to ``None`` and skips its
        remaining stages. ``BudgetExceeded`` (strict mode) aborts the whole pipeline.
        Returns one result per item, in input order.
        """
        items = list(items)
        if not items:
            return []
        if not stages:
            return items

        def work(i: int) -> Any:
            prev = items[i]
            for stage in stages:
                prev = _call_stage(stage, prev, items[i], i)
            return prev

        return self._concurrent_map(len(items), work, concurrency=concurrency, drop_errors=True)

    # ---- parallel (barrier over zero-arg thunks; Claude-parity) --------
    def parallel(self, thunks: Sequence[Callable[[], Any]], *,
                 concurrency: int | None = None) -> list[Any]:
        """Run zero-arg ``thunks`` concurrently and return results in order (a BARRIER).

        Convenience mirroring Claude's ``parallel(thunks)``: a thunk that raises resolves
        to ``None`` in the result array (the call never rejects), so drop falsy entries
        before use. ``BudgetExceeded`` (strict mode) still propagates. ``fan_out(items, fn)``
        is the same barrier keyed by items; ``parallel`` takes pre-bound thunks and, unlike
        ``fan_out``, swallows per-thunk errors to ``None`` instead of re-raising.
        """
        thunks = list(thunks)
        return self._concurrent_map(
            len(thunks), lambda i: thunks[i](), concurrency=concurrency, drop_errors=True)
    @contextmanager
    def worktree(self, name: str, base_ref: str | None = None):
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
                    f"wf.worktree requires a git repository (none found at {os.getcwd()})"
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
                self._log(f"  ! worktree cleanup failed: {e}")

    # ---- inline sub-workflow composition -------------------------------
    def workflow(self, target: str, args: Any = None) -> str:
        """Run a saved harness inline as a sub-step and return what it printed.

        The child runs against THIS runtime, so budget, concurrency, checkpoints, and
        the progress view all compose; its agents appear under a ``workflow:<name>``
        phase and its spend counts toward ``wf.spent``. ``target`` is a path to a
        ``.py`` harness, or a bare name resolved from ``./<name>.cwf.py`` /
        ``~/.copilot/workflows/<name>.py``. ``args`` becomes the child's ``args``.

        cwf harnesses answer by ``print()``-ing to stdout, so the child's stdout is
        captured and returned as the result string. Because that capture is
        process-global, ``workflow()`` must be called from the **top level** (it raises
        if invoked inside a fan_out/pipeline/parallel branch) and nests only one level
        deep. Editing a child harness safely invalidates its cached agents (cache miss,
        never a wrong hit) thanks to per-call key scoping. In ``restricted`` mode the
        child runs under the same restricted, deterministic environment, and ``target``
        must be a saved-workflow *name* (no arbitrary file paths).
        """
        if threading.current_thread() is not threading.main_thread():
            raise RuntimeError(
                "wf.workflow() must be called at the top level, not inside a "
                "fan_out/pipeline/parallel branch (its stdout capture is process-global)")
        if self._workflow_depth >= 1:
            raise RuntimeError("wf.workflow() nesting is one level only")

        path = self._resolve_workflow(target)
        name = os.path.splitext(os.path.basename(path))[0]
        with open(path, "r") as fh:
            src = fh.read()
        if self.restricted:
            lint_imports(src, path)  # fail fast before the child spawns agents
        code = compile(src, path, "exec")
        g = harness_globals(self, args, path, restricted=self.restricted)

        self._workflow_calls += 1
        prev_scope = self._key_scope
        self._key_scope = f"wf{self._workflow_calls}:{name}"
        self._workflow_depth += 1
        buf = io.StringIO()
        try:
            with self.phase(f"workflow:{name}"):
                with redirect_stdout(buf):
                    exec(code, g)
        finally:
            self._workflow_depth -= 1
            self._key_scope = prev_scope
        return buf.getvalue().strip()

    def _resolve_workflow(self, target: str) -> str:
        wdir = default_workflows_dir()
        if self.restricted:
            # Defense-in-depth: a restricted harness may compose only *registered* saved
            # workflows, never an arbitrary local file path (which would re-open the
            # filesystem/exec capability the restriction is meant to close).
            t = str(target)
            if os.sep in t or t.startswith("~") or t.startswith(".") or ".." in t:
                raise SandboxError(
                    "restricted mode: wf.workflow() takes a saved-workflow name, not a path: "
                    f"{target!r}")
            for cand in (os.path.join(wdir, f"{t}.cwf.py"), os.path.join(wdir, f"{t}.py")):
                if os.path.isfile(cand):
                    return cand
            raise FileNotFoundError(
                f"restricted mode: no saved workflow named {target!r} in {wdir}")
        p = os.path.expanduser(str(target))
        if p.endswith(".py") or os.sep in p:
            ap = os.path.abspath(p)
            if os.path.isfile(ap):
                return ap
            raise FileNotFoundError(f"wf.workflow: harness not found: {target}")
        for cand in (
            os.path.join(os.getcwd(), f"{p}.cwf.py"),
            os.path.join(os.getcwd(), f"{p}.py"),
            os.path.join(wdir, f"{p}.cwf.py"),
            os.path.join(wdir, f"{p}.py"),
        ):
            if os.path.isfile(cand):
                return cand
        raise FileNotFoundError(
            f"wf.workflow: no harness named {target!r} in cwd or ~/.copilot/workflows")

    # ---- checkpoint keys -----------------------------------------------
    def _scoped_key(self, key: str) -> str:
        """Namespace an explicit checkpoint key by the active workflow scope (if any)."""
        return f"{self._key_scope}-{key}" if self._key_scope else key

    def _agent_key(self, spec: AgentSpec) -> str:
        fp = self._spec_fingerprint(spec)
        # Scope folds into the occurrence counter AND the key prefix so a child
        # workflow's agents never alias the parent's. Empty scope -> byte-identical
        # to the pre-scope key (resume compatibility preserved).
        occ_key = f"{self._key_scope}:{fp}" if self._key_scope else fp
        with self._occ_lock:
            n = self._occurrence.get(occ_key, 0)
            self._occurrence[occ_key] = n + 1
        prefix = f"{self._key_scope}-" if self._key_scope else ""
        return f"{prefix}{fp[:16]}-{n}"

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
