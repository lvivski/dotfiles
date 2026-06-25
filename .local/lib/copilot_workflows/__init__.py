"""cwf — dynamic workflows on top of the GitHub Copilot CLI.

Public API:
    from copilot_workflows import Runtime, AgentSpec, AgentResult, BudgetExceeded
"""
from __future__ import annotations

from .agent import AgentResult, AgentSpec, build_cmd, run_agent
from .checkpoint import CheckpointStore, default_runs_dir, default_workflows_dir
from .patterns import PatternsMixin, Structured, Verdict
from .progress import ProgressReporter, replay
from .runtime import BudgetExceeded, Runtime, default_concurrency
from .sandbox import SandboxError, harness_globals, lint_imports, restricted_builtins
from .worktree import WorktreeManager, find_repo_root

__all__ = [
    "Runtime",
    "AgentSpec",
    "AgentResult",
    "BudgetExceeded",
    "Verdict",
    "Structured",
    "PatternsMixin",
    "CheckpointStore",
    "WorktreeManager",
    "ProgressReporter",
    "replay",
    "default_runs_dir",
    "default_workflows_dir",
    "find_repo_root",
    "build_cmd",
    "run_agent",
    "default_concurrency",
    "SandboxError",
    "harness_globals",
    "lint_imports",
    "restricted_builtins",
]

__version__ = "0.6.0"
