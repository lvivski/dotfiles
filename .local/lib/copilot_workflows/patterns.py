"""Composable orchestration patterns (synthesize/verify/tournament/...) mixed into Runtime."""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable, List, Optional, Sequence, Union

from .agent import AgentResult


def as_text(x: Any) -> str:
    """Best-effort text view of an item (AgentResult -> its content)."""
    if isinstance(x, AgentResult):
        return x.content
    return str(x)


def _norm(s: str) -> str:
    return " ".join((s or "").split()).lower()


def _as_float(x: Any) -> Optional[float]:
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def _extract_json(text: str) -> Optional[dict]:
    """Last top-level JSON object embedded in ``text`` (via the real parser), or None."""
    if not text:
        return None
    decoder = json.JSONDecoder()
    found: Optional[dict] = None
    i = 0
    while (i := text.find("{", i)) != -1:
        try:
            obj, i = decoder.raw_decode(text, i)
            if isinstance(obj, dict):
                found = obj
        except json.JSONDecodeError:
            i += 1
    return found


@dataclass
class Verdict:
    """Outcome of an adversarial verification."""

    passed: bool
    score: Optional[float]
    reasons: str
    raw: AgentResult

    def __bool__(self) -> bool:
        return self.passed


class PatternsMixin:
    # These are provided by Runtime; declared here for readers/type-checkers.
    agent: Callable[..., AgentResult]
    fan_out: Callable[..., List[Any]]
    log: Callable[..., None]

    # ---- fan-out -> barrier merge --------------------------------------
    def synthesize(
        self,
        results: Sequence[Any],
        *,
        prompt: str = "Synthesize the following inputs into one coherent, de-duplicated result.",
        model: Optional[str] = None,
        label: str = "synthesize",
        **kw: Any,
    ) -> AgentResult:
        """Merge many results/items into a single answer via one agent call."""
        blocks = []
        for idx, r in enumerate(results, 1):
            blocks.append("=== Input %d ===\n%s" % (idx, as_text(r)))
        full = "%s\n\n%s" % (prompt, "\n\n".join(blocks))
        return self.agent(full, model=model, label=label, **kw)

    # ---- adversarial verification --------------------------------------
    def verify(
        self,
        subject: Any,
        *,
        rubric: Any,
        refute: bool = True,
        model: Optional[str] = None,
        label: str = "verify",
        **kw: Any,
    ) -> Verdict:
        """Check ``subject`` against ``rubric``; return a structured Verdict."""
        persona = (
            "You are a skeptical, adversarial reviewer. Actively hunt for flaws, "
            "unsupported claims, missing cases, or any way the work fails the rubric."
            if refute else
            "You are a careful, fair reviewer."
        )
        prompt = (
            "%s\n\nRUBRIC / CRITERIA:\n%s\n\nWORK UNDER REVIEW:\n%s\n\n"
            "Decide whether the work satisfies the rubric. Give brief reasoning, then on the "
            'FINAL line output ONLY a JSON object: '
            '{"passed": true|false, "score": 0..1, "reasons": "..."}'
        ) % (persona, as_text(rubric), as_text(subject))
        res = self.agent(prompt, model=model, label=label, **kw)
        data = _extract_json(res.content) or {}
        return Verdict(
            passed=bool(data.get("passed", False)),
            score=_as_float(data.get("score")),
            reasons=str(data.get("reasons", res.content.strip())),
            raw=res,
        )

    # ---- pairwise comparative judgment ---------------------------------
    def tournament(
        self,
        candidates: Sequence[Any],
        *,
        criteria: str = "overall quality",
        model: Optional[str] = None,
        label: str = "judge",
    ) -> Any:
        """Single-elimination bracket; comparative judgment picks one winner."""
        items = list(candidates)
        if not items:
            return None
        round_no = 0
        while len(items) > 1:
            round_no += 1
            pairs = [(items[i], items[i + 1]) for i in range(0, len(items) - 1, 2)]
            byes = items[-1:] if len(items) % 2 else []
            self.log("  tournament round %d: %d pair(s), %d bye(s)" % (round_no, len(pairs), len(byes)))
            winners = self.fan_out(
                pairs, lambda pr: self._judge_pair(pr[0], pr[1], criteria, model, label))
            items = list(winners) + byes
        return items[0]

    def _judge_pair(self, a: Any, b: Any, criteria: str, model: Optional[str], label: str) -> Any:
        prompt = (
            "Compare two candidates on: %s.\n\n"
            "=== Candidate A ===\n%s\n\n=== Candidate B ===\n%s\n\n"
            "Pick the single better candidate. Give brief reasoning, then on the FINAL line "
            'output ONLY JSON: {"winner": "A"|"B", "why": "..."}'
        ) % (criteria, as_text(a), as_text(b))
        res = self.agent(prompt, model=model, label=label)
        data = _extract_json(res.content) or {}
        winner = str(data.get("winner", "A")).strip().upper()
        return b if winner.startswith("B") else a

    # ---- generate -> dedupe -> filter ----------------------------------
    def generate_and_filter(
        self,
        generate: Union[str, Sequence[str]],
        *,
        n: int = 5,
        keep: Optional[Callable[[AgentResult], bool]] = None,
        rubric: Optional[Any] = None,
        dedupe: bool = True,
        model: Optional[str] = None,
        label: str = "generate",
    ) -> List[AgentResult]:
        """Generate candidates, drop duplicates, keep those passing a filter."""
        prompts = [generate] * n if isinstance(generate, str) else list(generate)
        cands: List[AgentResult] = self.fan_out(
            prompts, lambda p: self.agent(p, model=model, label=label)
        )
        cands = [c for c in cands if isinstance(c, AgentResult) and c.ok]

        if dedupe:
            seen = set()
            uniq = []
            for c in cands:
                key = _norm(c.content)
                if key and key not in seen:
                    seen.add(key)
                    uniq.append(c)
            cands = uniq

        if keep is not None:
            cands = [c for c in cands if keep(c)]
        elif rubric is not None:
            pairs = self.fan_out(
                cands, lambda c: (c, self.verify(c, rubric=rubric, refute=True, model=model))
            )
            cands = [c for (c, v) in pairs if v.passed]
        return cands

    # ---- classify / route ----------------------------------------------
    def classify(
        self,
        text: Any,
        classes: Sequence[str],
        *,
        model: Optional[str] = None,
        label: str = "classify",
        instructions: Optional[str] = None,
    ) -> str:
        """Return exactly one of ``classes`` for ``text`` (snapped to a valid label)."""
        classes = list(classes)
        prompt = (
            "Classify the input into exactly one of these categories: %s.\n%sINPUT:\n%s\n\n"
            'FINAL line: ONLY JSON {"category": "<one of the categories>"}'
        ) % (", ".join(classes), (instructions + "\n") if instructions else "", as_text(text))
        res = self.agent(prompt, model=model, label=label)
        data = _extract_json(res.content) or {}
        cat = str(data.get("category", "")).strip()
        for c in classes:
            if cat.lower() == c.lower():
                return c
        low = res.content.lower()
        for c in classes:
            if c.lower() in low:
                return c
        return classes[0]

    # ---- loop until a stop condition -----------------------------------
    def loop_until(
        self,
        step: Callable[[int], Any],
        done: Callable[[Any], bool],
        *,
        max_iters: int = 10,
    ) -> List[Any]:
        """Call ``step(i)`` until ``done(result)`` is true or ``max_iters`` reached."""
        history: List[Any] = []
        for i in range(max_iters):
            r = step(i)
            history.append(r)
            try:
                if done(r):
                    break
            except Exception:
                pass
        return history

    # ---- quarantine (security) -----------------------------------------
    def quarantine(
        self,
        *,
        deny: Optional[Sequence[str]] = None,
        deny_url: Optional[Sequence[str]] = None,
        **extra: Any,
    ) -> dict:
        """kwargs for ``agent(...)`` that deny shell/write to an untrusted-content reader."""
        out = dict(
            allow_all_tools=True,  # keep non-interactive happy; deny wins anyway
            deny=list(deny) if deny is not None else ["shell", "write"],
        )
        if deny_url is not None:
            out["deny_url"] = list(deny_url)
        out.update(extra)
        return out
