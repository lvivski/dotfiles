"""cwf — dynamic workflows on top of the GitHub Copilot CLI.

Public API:
    from copilot_workflows import Runtime, AgentSpec, AgentResult, BudgetExceeded
"""
from __future__ import annotations

from .agent import AgentResult, AgentSpec, build_cmd, run_agent
from .checkpoint import CheckpointStore, default_runs_dir
from .patterns import PatternsMixin, Verdict
from .progress import ProgressReporter, replay
from .runtime import BudgetExceeded, Runtime, default_concurrency
from .worktree import WorktreeManager, find_repo_root

__all__ = [
    "Runtime",
    "AgentSpec",
    "AgentResult",
    "BudgetExceeded",
    "Verdict",
    "PatternsMixin",
    "CheckpointStore",
    "WorktreeManager",
    "ProgressReporter",
    "replay",
    "default_runs_dir",
    "find_repo_root",
    "build_cmd",
    "run_agent",
    "default_concurrency",
]

__version__ = "0.3.0"
