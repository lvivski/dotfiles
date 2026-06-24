"""Restricted, determinism-assisting execution environment for workflow harnesses.

This is **footgun prevention + determinism**, layered as defense-in-depth on top of an
OS/agent sandbox — it is **NOT a security jail**. In-process Python ``exec`` is escapable
(e.g. via object introspection such as ``().__class__.__mro__`` or ``wf.__class__``), just
as Node/Bun's ``vm`` is. To run genuinely untrusted *authors* safely, run cwf itself inside
an OS-level sandbox (Copilot ``--cloud`` / ``/sandbox``, a container, seccomp/landlock).

What restricted mode DOES buy:

* **Determinism** — the harness can't ``import`` time/random/datetime/uuid/os, and the
  nondeterministic builtins ``id``/``hash`` are removed, so a harness is far less likely to
  change its agent call-graph between a run and its ``--resume``. (cwf checkpoints by a
  spec *fingerprint*, so nondeterminism mostly costs extra re-runs rather than producing
  wrong results — but staying deterministic avoids that waste.) Authors pass timestamps via
  ``args`` and vary randomness by item index.
* **Orchestration-only** — no ``open``/``exec``/``eval``/``compile`` and no fs/proc/net
  imports, so a harness can't accidentally read or write files, spawn processes, or reach
  the network. The privileged work happens inside subagents, already gated per-agent by
  ``--allow/deny-tool`` and ``wf.quarantine()``.
"""
from __future__ import annotations

import ast
from typing import Any, Dict

# Pure, deterministic standard-library modules a harness may import. Deliberately EXCLUDES
# anything nondeterministic (time, datetime, random, uuid, secrets, os) or capability-bearing
# (io/open, subprocess, socket, shutil, pathlib, urllib, http, importlib, ctypes, inspect, ...).
SAFE_MODULES = frozenset({
    "__future__",
    "json", "re", "math", "cmath", "decimal", "fractions", "statistics", "numbers",
    "itertools", "functools", "operator",
    "collections", "heapq", "bisect", "array", "enum", "dataclasses", "typing", "types",
    "string", "textwrap", "unicodedata", "difflib", "pprint", "reprlib", "keyword",
    "copy", "contextlib",
    "hashlib", "hmac", "base64", "binascii", "struct",
})

# Builtins removed in restricted mode: dynamic code (exec/eval/compile), I/O (open),
# interactivity (input/breakpoint/help/exit/quit/...), and the two nondeterministic builtins
# (``id`` is address-derived; str/bytes ``hash`` is per-process salted). ``__import__`` is
# replaced (not removed) by ``guarded_import``.
_REMOVED_BUILTINS = (
    "open", "exec", "eval", "compile", "input", "breakpoint",
    "help", "exit", "quit", "license", "credits", "copyright",
    "id", "hash",
)

# The real importer, captured once so guarded_import can delegate to it.
_real_import = __import__


class SandboxError(ImportError):
    """Raised when a restricted harness imports a non-allowlisted (or relative) module."""


def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    """``__import__`` replacement that permits only allowlisted top-level packages."""
    if level and level != 0:
        raise SandboxError("relative imports are not allowed in a restricted harness")
    top = (name or "").split(".")[0]
    if top not in SAFE_MODULES:
        raise SandboxError(
            "import of %r is blocked in restricted mode (allowed: %s)"
            % (name or "?", ", ".join(sorted(SAFE_MODULES))))
    return _real_import(name, globals, locals, fromlist, level)


def restricted_builtins() -> Dict[str, Any]:
    """A copy of the real builtins minus dangerous/nondeterministic entries.

    A denylist (not an allowlist) so ``__build_class__``, the exception hierarchy, ``print``,
    ``super``, comprehensions, etc. keep working — valid harnesses don't break. This stops
    *accidental* harm; it is not a jail (introspection escapes exist).
    """
    import builtins as _b
    bi = dict(vars(_b))
    for name in _REMOVED_BUILTINS:
        bi.pop(name, None)
    bi["__import__"] = guarded_import
    return bi


def harness_globals(wf: Any, args: Any, file: str, *, restricted: bool) -> Dict[str, Any]:
    """Build the exec globals for a harness — the single source of truth for both exec sites
    (the ``cwf`` CLI and ``wf.workflow``). In restricted mode, installs restricted builtins;
    otherwise leaves ``__builtins__`` unset so ``exec`` injects the real ones (unchanged)."""
    from .agent import AgentResult, AgentSpec
    g: Dict[str, Any] = {
        "wf": wf, "args": args,
        "AgentSpec": AgentSpec, "AgentResult": AgentResult,
        "__name__": "__main__", "__file__": file, "__package__": None,
    }
    if restricted:
        g["__builtins__"] = restricted_builtins()
    return g


def lint_imports(source: str, path: str) -> None:
    """Fail fast (before any agent spends credits) on a non-allowlisted import.

    A conservative preflight: it flags every ``import``/``from`` statement that names a
    blocked top-level module, **including** ones under ``if TYPE_CHECKING:`` or in
    ``try/except ImportError`` fallbacks (it does not evaluate reachability). Dynamic
    ``__import__`` calls and object-graph escapes are out of scope — the runtime
    ``guarded_import`` is the backstop. Raises ``SandboxError`` on the first violation.
    """
    try:
        tree = ast.parse(source, filename=path)
    except SyntaxError:
        return  # let the real compile() report the syntax error with a clearer message
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split(".")[0] not in SAFE_MODULES:
                    raise SandboxError(
                        "%s: import of %r is blocked in restricted mode" % (path, alias.name))
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                raise SandboxError(
                    "%s: relative imports are not allowed in restricted mode" % path)
            if (node.module or "").split(".")[0] not in SAFE_MODULES:
                raise SandboxError(
                    "%s: import from %r is blocked in restricted mode" % (path, node.module))
