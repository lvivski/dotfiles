"""The `wf` runtime: spawn and coordinate subagents with budgets, checkpoints, worktrees, progress."""
from __future__ import annotations

import hashlib
import inspect
import json
import os
import shutil
import tempfile
import threading
import time
from collections.abc import Callable, Sequence
from concurrent.futures import CancelledError, ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from dataclasses import replace
from typing import Any

from ._util import noop
from .agent import AgentResult, AgentSpec, kill_all_agents, run_agent
from .checkpoint import CheckpointStore
from .memory import Memory
from .patterns import PatternsMixin
from .progress import ProgressEvent, format_agent_line
from .worktree import WorktreeManager, _SAFE, clone_path, ensure_clone, find_repo_root


def default_concurrency() -> int:
    cpu = os.cpu_count() or 4
    return min(16, max(2, cpu - 1))


XTREME_DEFAULT_BUDGET = 1_000_000.0


def _normalize_concurrency(value: int | None) -> int:
    """Return a concrete positive concurrency value."""
    concurrency = default_concurrency() if value is None else value
    if concurrency < 1:
        raise ValueError("concurrency must be >= 1")
    return concurrency


class BudgetExceeded(Exception):
    """Raised (only in strict mode) when observed AIC spend passes the cap."""


def _skipped_result(spec: AgentSpec, error: str = "skipped: budget reached") -> AgentResult:
    return AgentResult(
        content="", session_id=None, nano_aiu=0, output_tokens=0,
        exit_code=-1, model=spec.model, label=spec.label,
        error=error, ok=False,
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


# Spec fields that define an agent's identity for checkpoint keys. Cosmetic/operational
# fields (timeout, label) are deliberately excluded; resume is included so follow-up
# turns in different sessions never collide.
_KEY_FIELDS = (
    "prompt", "model", "agent", "effort", "context", "cwd", "resume", "enable_mcp", "mcp",
    "allow", "deny", "allow_url", "deny_url", "add_dir", "allow_all_tools",
    "extra_args",
)


class Runtime(PatternsMixin):
    def __init__(
        self,
        *,
        concurrency: int | None = None,
        copilot_bin: str = "copilot",
        model: str | None = None,
        effort: str | None = None,
        context: str | None = None,
        default_enable_mcp: bool = False,
        budget: float | None = None,
        strict_budget: bool = False,
        preset: str | None = None,
        logger: Callable[..., None] | None = None,
        progress: Callable[[ProgressEvent], None] | None = None,
        dry_run: bool = False,
        run_dir: str | None = None,
        checkpoints: CheckpointStore | None = None,
        repo_root: str | None = None,
        restricted: bool = False,
        memory_path: str | None = None,
    ):
        self.concurrency = _normalize_concurrency(concurrency)
        self.copilot_bin = copilot_bin
        self.model = model
        self.effort = effort
        self.context = context
        self.default_enable_mcp = default_enable_mcp
        self.restricted = restricted
        self._budget = budget
        self.strict_budget = strict_budget
        self._spent_lock = threading.Lock()
        self._spent = checkpoints.prior_spent if checkpoints is not None else 0.0
        self._budget_hit = threading.Event()
        self._aborting = threading.Event()  # set on interrupt; gates new agent launches
        self._sem = threading.BoundedSemaphore(self.concurrency)
        self._log = logger or noop
        # Durable text shared ACROSS runs / loop ticks (vs per-run checkpoints). Exposed as
        # wf.memory; usable from restricted harnesses since the runtime owns the file I/O.
        self.memory = Memory(memory_path, read_only=dry_run, logger=self._log)
        self._progress = progress
        self._seq = 0
        self._seq_lock = threading.Lock()
        self._phase_local = threading.local()
        self._key_local = threading.local()
        self.dry_run = dry_run
        self.run_dir = run_dir
        self.checkpoints = checkpoints
        self.results: list[AgentResult] = []
        self._results_lock = threading.Lock()
        # checkpoint key occurrence counter (per identical-spec fingerprint)
        self._occurrence: dict[str, int] = {}
        self._occ_lock = threading.Lock()
        # lazily-created worktree managers (one per repo root; remotes cloned into a cache)
        self._repo_root = repo_root
        self._wt_mgr: WorktreeManager | None = None       # default-repo manager (back-compat)
        self._wt_mgrs: dict[str, WorktreeManager] = {}     # one per repo root; remotes cloned in
        self._wt_base: str | None = None
        self._wt_lock = threading.Lock()
        if preset:
            self.apply_preset(preset)

    # ---- introspection -------------------------------------------------
    @property
    def spent(self) -> float:
        with self._spent_lock:
            return self._spent

    @property
    def budget_total(self) -> float | None:
        """The observed AIC soft cap for the run, or None if uncapped."""
        return self._budget

    def remaining(self) -> float:
        """AIC left before the observed-spend soft cap (``inf`` if uncapped).

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

    def budget(self, aic: float | None) -> None:
        """Set (or clear) the observed-spend soft budget for the run."""
        self._budget = aic

    def apply_preset(self, name: str) -> "Runtime":
        """Apply a named run preset without overriding explicit harness/launcher choices."""
        if name == "xtreme":
            return self.xtreme()
        raise ValueError(f"unknown preset: {name}")

    def xtreme(
        self,
        *,
        model: str = "auto",
        effort: str = "xhigh",
        context: str = "long_context",
        budget: float | None = XTREME_DEFAULT_BUDGET,
    ) -> "Runtime":
        """Bias this run toward broad, high-confidence workflow execution."""
        if self.model is None:
            self.model = model
        if self.effort is None:
            self.effort = effort
        if self.context is None:
            self.context = context
        if self._budget is None and budget is not None:
            self._budget = budget
        return self

    def log(self, *args: Any) -> None:
        self._log(*args)

    @contextmanager
    def phase(self, name: str):
        """Group the agents launched inside this block under a phase label."""
        stack = self._phase_stack()
        stack.append(name)
        try:
            yield
        finally:
            stack.pop()

    def _phase_stack(self) -> list[str]:
        stack = getattr(self._phase_local, "stack", None)
        if stack is None:
            stack = []
            self._phase_local.stack = stack
        return stack

    def _current_phase(self) -> str | None:
        stack = self._phase_stack()
        return stack[-1] if stack else None

    @contextmanager
    def _use_phase_stack(self, stack: tuple[str, ...]):
        """Temporarily install the caller's phase context in a worker thread."""
        local_stack = self._phase_stack()
        previous = tuple(local_stack)
        local_stack[:] = stack
        try:
            yield
        finally:
            local_stack[:] = previous

    def _branch_path(self) -> tuple[int, ...]:
        return getattr(self._key_local, "branch_path", ())

    @contextmanager
    def _use_branch_path(self, path: tuple[int, ...]):
        previous = self._branch_path()
        self._key_local.branch_path = path
        try:
            yield
        finally:
            self._key_local.branch_path = previous

    # ---- spec building (no execution) ----------------------------------
    def spec(self, prompt: str, **kw: Any) -> AgentSpec:
        kw.setdefault("enable_mcp", self.default_enable_mcp)
        return self._apply_run_settings(AgentSpec(prompt=prompt, **kw))

    def _apply_run_settings(self, spec: AgentSpec) -> AgentSpec:
        """Fill a spec's model/effort/context from the run-level (session) settings, but only
        where the harness left them unset — mirroring Claude Code dynamic workflows.

        In Claude an ``agent()`` *inherits the session* model/effort and a per-agent value
        *overrides* it ("omit to inherit the session effort"; "if omitted or 'inherit', uses
        the main model"). So the harness's explicit per-agent choice always WINS; the
        launch-time ``--model``/``--effort``/``--context`` is just the inherited default for
        agents that don't pin their own. (``context`` is a Copilot-only window tier with no
        Claude equivalent; it follows the same inherit rule for consistency.) Applied at every
        launch (see ``agent``) so it reaches a directly-constructed ``AgentSpec`` too. Mutates
        and returns the spec; idempotent.
        """
        if spec.model is None:
            spec.model = self.model
        if spec.effort is None:
            spec.effort = self.effort
        if spec.context is None:
            spec.context = self.context
        return spec

    # ---- single agent --------------------------------------------------
    def agent(self, prompt_or_spec: str | AgentSpec, *, key: str | None = None,
              phase: str | None = None, **kw: Any) -> AgentResult:
        # For a caller-supplied AgentSpec, resolve run settings into a COPY so we never mutate
        # the harness's object (it may reuse/inspect it, or hand it to another runtime).
        spec = (
            self._apply_run_settings(replace(prompt_or_spec))
            if isinstance(prompt_or_spec, AgentSpec)
            else self.spec(prompt_or_spec, **kw)
        )
        label = spec.label or "agent"
        # Explicit phase wins over the inherited phase context.
        eff_phase = phase if phase is not None else self._current_phase()
        seq = self._next_seq()
        self._emit({"ev": "start", "seq": seq, "label": label, "model": spec.model,
                    "phase": eff_phase, "t": time.time()})

        if self.dry_run:
            res = AgentResult(content="[dry-run]", session_id=None, nano_aiu=0,
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
            if self._aborting.is_set():
                # An interrupt is tearing the run down; don't launch a new subprocess.
                res = _skipped_result(spec)
                skipped = True
            elif self._over_budget():
                self._budget_hit.set()
                if self.strict_budget:
                    self._finish(seq, label, _skipped_result(spec), skipped=True, phase=eff_phase)
                    raise BudgetExceeded(
                        f"budget {self._budget:.2f} reached (spent {self.spent:.2f})")
                res = _skipped_result(spec)
                skipped = True
            else:
                res = run_agent(spec, copilot_bin=self.copilot_bin, abort=self._aborting)
                self._charge(res.aiu_credits)
                if self.checkpoints is not None and res.ok:
                    self.checkpoints.put(ckpt_key, res)
                strict_stop = self.strict_budget and self._over_budget()

        self._finish(seq, label, res, skipped=skipped, phase=eff_phase)
        if strict_stop:
            raise BudgetExceeded(
                f"budget {self._budget:.2f} exceeded (spent {self.spent:.2f})")
        return res

    def _finish(self, seq: int, label: str, res: AgentResult, *, skipped: bool,
                phase: str | None = None) -> None:
        with self._results_lock:
            self.results.append(res)
        self._emit({"ev": "end", "seq": seq, "label": label, "ok": res.ok,
                    "cached": res.cached, "skipped": skipped, "nano_aiu": res.nano_aiu,
                    "tok": res.output_tokens, "error": res.error, "model": res.model,
                    "phase": phase if phase is not None else self._current_phase(),
                    "t": time.time()})

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
        return self._concurrent_map(
            len(items),
            lambda i: fn(items[i]),
            concurrency=concurrency,
            drop_errors=False,
        )

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
        requested = self.concurrency if concurrency is None else concurrency
        workers = min(_normalize_concurrency(requested), n)
        results: list[Any] = [None] * n
        budget_error = None
        branch_error = None
        parent_phase_stack = tuple(self._phase_stack())
        parent_branch_path = self._branch_path()

        def run(i: int):
            with self._use_phase_stack(parent_phase_stack):
                with self._use_branch_path(parent_branch_path + (i,)):
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
            try:
                for fut in as_completed(futs):
                    try:
                        i, r = fut.result()
                        results[i] = r
                    except BudgetExceeded as e:  # strict mode only
                        budget_error = budget_error or e
                        for pending in futs:
                            pending.cancel()
                    except CancelledError:
                        pass
                    except Exception as e:  # surfaces only when drop_errors=False
                        branch_error = branch_error or e
                        for pending in futs:
                            pending.cancel()
            except BaseException:
                # Ctrl-C / SIGTERM unwinding on the main thread. Stop launching queued agents,
                # cancel the not-yet-started ones, and kill those already running so the
                # executor's shutdown(wait=True) drains immediately instead of blocking on
                # detached subprocesses (which would otherwise re-hang and re-orphan them).
                self._aborting.set()
                for f in futs:
                    f.cancel()
                kill_all_agents()
                raise
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
    def worktree(self, name: str, base_ref: str | None = None,
                 repo: str | None = None, ref: str | None = None,
                 clone_dir: str | None = None):
        """Give an agent its own git worktree for the duration of the block.

        ``repo`` worktrees a repo *other* than the launch repo (a local path or clone URL).
        By default, non-launch repos are cloned once into a per-run cache. Pass ``clone_dir`` to
        clone/reuse them persistently under that directory (for example ``~/Developer``). ``ref`` is
        a fetchable ref (e.g. ``pull/7/head``) materialized into the worktree, so a multi-repo
        workflow can check out many PRs across remotes in isolation.
        """
        mgr = self._manager_for(repo, clone_dir)
        path = mgr.create(name, base_ref, fetch_ref=ref)
        try:
            yield path
        finally:
            mgr.remove(path)

    def _manager_for(self, repo: str | None, clone_dir: str | None = None) -> WorktreeManager:
        with self._wt_lock:
            if self._wt_base is None:
                self._wt_base = tempfile.mkdtemp(prefix="cwf-wt-")
            if repo is None:
                root = self._repo_root or find_repo_root(os.getcwd())
                if not root:
                    raise RuntimeError(
                        f"wf.worktree requires a git repository (none found at {os.getcwd()})")
            else:
                if os.path.exists(repo):
                    root = repo
                else:
                    dest = clone_path(repo, clone_dir) if clone_dir else os.path.join(
                        self._wt_base, "_repos", _SAFE.sub("-", repo).strip("-."))
                    root = ensure_clone(repo, dest, self._log)
            if root not in self._wt_mgrs:
                safe = _SAFE.sub("-", root).strip("-.")
                sub = self._wt_base if repo is None else os.path.join(self._wt_base, safe)
                self._wt_mgrs[root] = WorktreeManager(
                    root, sub, logger=self._log, fetch_remote=not (repo and os.path.exists(repo)))
                if repo is None:
                    self._wt_mgr = self._wt_mgrs[root]  # back-compat handle
            return self._wt_mgrs[root]

    def cleanup(self) -> None:
        """Remove every worktree + clone cache created during the run. Safe to call always."""
        if not self._wt_mgrs:
            return
        ok = True
        for mgr in list(self._wt_mgrs.values()):
            try:
                mgr.cleanup_all()
            except Exception as e:
                ok = False
                self._log(f"  ! worktree cleanup failed: {e}")
        if ok:
            shutil.rmtree(self._wt_base, ignore_errors=True)
            self._wt_mgrs.clear()
            self._wt_mgr = None
            self._wt_base = None

    # ---- checkpoint keys -----------------------------------------------
    def _scoped_key(self, key: str) -> str:
        """Namespace an explicit checkpoint key by concurrent branch scope, if any."""
        prefix = self._key_prefix()
        return f"{prefix}-{key}" if prefix else key

    def _agent_key(self, spec: AgentSpec) -> str:
        fp = self._spec_fingerprint(spec)
        # Branch scope folds into the occurrence counter AND the key prefix so
        # concurrent branches never alias each other. Empty scope
        # remains byte-identical to the pre-scope key (resume compatibility).
        prefix = self._key_prefix()
        occ_key = f"{prefix}:{fp}" if prefix else fp
        with self._occ_lock:
            n = self._occurrence.get(occ_key, 0)
            self._occurrence[occ_key] = n + 1
        return f"{prefix + '-' if prefix else ''}{fp[:16]}-{n}"

    def _key_prefix(self) -> str:
        parts = []
        branch = self._branch_path()
        if branch:
            parts.append("b" + ".".join(str(i) for i in branch))
        return "-".join(parts)

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

    def _emit(self, rec: ProgressEvent) -> None:
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
