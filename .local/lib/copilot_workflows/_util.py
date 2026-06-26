"""Tiny internal helpers shared across the package (not part of the public API)."""
from __future__ import annotations


def noop(*_args: object, **_kwargs: object) -> None:
    """A do-nothing default for optional ``logger`` callbacks (avoids per-call lambdas)."""
