"""Composable orchestration patterns (synthesize/verify/tournament/...) mixed into Runtime."""
from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from .agent import AgentResult


def as_text(x: Any) -> str:
    """Best-effort text view of an item (AgentResult -> its content)."""
    if isinstance(x, AgentResult):
        return x.content
    return str(x)


def _norm(s: str) -> str:
    return " ".join((s or "").split()).lower()


def _as_float(x: Any) -> float | None:
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def _json_values(text: str, starts: str):
    """Yield embedded top-level JSON values whose first char is in ``starts``."""
    decoder = json.JSONDecoder()
    i = 0
    n = len(text)
    while i < n:
        if text[i] in starts:
            try:
                obj, j = decoder.raw_decode(text, i)
                yield obj
                i = j
                continue
            except json.JSONDecodeError:
                pass
            except RecursionError:  # pathologically deep braces: stop scanning
                return
        i += 1


_JSON_NOT_FOUND = object()


def _extract_last_json(text: str, *, default: Any = None) -> Any:
    """Last top-level JSON value (object OR array) in ``text``, or ``default``.

    Prefers the final non-empty line parsed whole (the model's actual answer, not a
    restated schema earlier in the reply); falls back to scanning embedded ``{``/``[``
    and keeping the last that decodes (handles pretty-printed multi-line JSON).
    """
    if not text:
        return default
    # 1) Prefer the final non-empty line parsed whole — the model's actual answer, and the
    #    only place a top-level SCALAR (number/string/bool/null) answer can be recovered.
    for line in reversed(text.splitlines()):
        s = line.strip().strip("`").strip()
        if not s:
            continue
        try:
            return json.loads(s)
        except (ValueError, RecursionError):  # JSONDecodeError is a ValueError
            break  # last content line isn't a clean value -> scan for embedded JSON
    found: Any = _JSON_NOT_FOUND
    for obj in _json_values(text, "{["):
        found = obj
    return default if found is _JSON_NOT_FOUND else found


_SHAPE_KEYWORDS = {"type", "properties", "required", "enum", "items",
                   "additionalProperties", "description"}
_SHAPE_TYPES = {"object", "array", "string", "number", "integer", "boolean", "null"}


def _check_schema_def(schema: Any, path: str = "$") -> None:
    """Validate a shape-schema *definition* up front, raising on unsupported keywords.

    A "shape schema" is a small documented subset of JSON Schema (type, properties,
    required, enum, items, additionalProperties). Anything else is rejected loudly so an
    author never assumes unsupported keywords (anyOf, patternProperties, ...) are enforced.
    """
    if not isinstance(schema, dict):
        raise ValueError(f"shape schema at {path} must be a dict, got {type(schema).__name__}")
    unknown = set(schema) - _SHAPE_KEYWORDS
    if unknown:
        raise ValueError(f"unsupported shape-schema keyword(s) at {path}: {', '.join(sorted(unknown))}")
    t = schema.get("type")
    if t is not None and t not in _SHAPE_TYPES:
        raise ValueError(f"unknown type {t!r} at {path}")
    for k, sub in (schema.get("properties") or {}).items():
        _check_schema_def(sub, f"{path}.{k}")
    if "items" in schema:
        _check_schema_def(schema["items"], f"{path}[]")


def _type_ok(obj: Any, t: str) -> bool:
    if t == "object":
        return isinstance(obj, dict)
    if t == "array":
        return isinstance(obj, list)
    if t == "string":
        return isinstance(obj, str)
    if t == "integer":
        return isinstance(obj, int) and not isinstance(obj, bool)
    if t == "number":
        return isinstance(obj, (int, float)) and not isinstance(obj, bool)
    if t == "boolean":
        return isinstance(obj, bool)
    if t == "null":
        return obj is None
    return True


def _validate_shape(obj: Any, schema: dict, path: str = "$") -> list[str]:
    """Return a (deterministically ordered) list of human-readable shape violations."""
    errors: list[str] = []
    if "enum" in schema and obj not in schema["enum"]:
        errors.append(f"{path}: {obj!r} is not one of {schema['enum']!r}")
    t = schema.get("type")
    if t is not None and not _type_ok(obj, t):
        errors.append(f"{path}: expected {t}")
        return errors  # type wrong -> deeper checks would be noise
    if t == "object" or (t is None and isinstance(obj, dict)):
        if isinstance(obj, dict):
            props = schema.get("properties") or {}
            for req in schema.get("required") or []:
                if req not in obj:
                    errors.append(f"{path}.{req}: required property missing")
            if schema.get("additionalProperties") is False:
                for k in sorted(obj):
                    if k not in props:
                        errors.append(f"{path}.{k}: unexpected property")
            for k in sorted(props):
                if k in obj:
                    errors.extend(_validate_shape(obj[k], props[k], f"{path}.{k}"))
    elif t == "array" or (t is None and isinstance(obj, list)):
        item_schema = schema.get("items")
        if item_schema and isinstance(obj, list):
            for idx, el in enumerate(obj):
                errors.extend(_validate_shape(el, item_schema, f"{path}[{idx}]"))
    return errors


@dataclass
class Structured:
    """Outcome of a schema-validated, retried structured-output call."""

    value: Any
    ok: bool
    error: str
    raw: AgentResult
    attempts: int

    def __bool__(self) -> bool:
        return self.ok


@dataclass
class Verdict:
    """Outcome of an adversarial verification."""

    passed: bool
    score: float | None
    reasons: str
    raw: AgentResult
    ok: bool = True
    error: str = ""

    def __bool__(self) -> bool:
        return self.passed


@dataclass
class Consensus:
    """Outcome of independent verification by multiple reviewers."""

    passed: bool
    passed_count: int
    failed_count: int
    errored_count: int
    reviewers: int
    reasons: str
    dissent: str
    verdicts: list[Verdict]
    ok: bool = True
    error: str = ""

    def __bool__(self) -> bool:
        return self.passed


class PatternsMixin:
    # These are provided by Runtime; declared here for readers/type-checkers.
    agent: Callable[..., AgentResult]
    fan_out: Callable[..., list[Any]]
    log: Callable[..., None]

    # ---- schema-validated structured output ----------------------------
    def structured(
        self,
        prompt: str,
        schema: dict | Callable[[Any], Any],
        *,
        validate: Callable[[Any], Any] | None = None,
        retries: int = 2,
        model: str | None = None,
        label: str = "structured",
        **kw: Any,
    ) -> Structured:
        """Get a JSON value matching ``schema``, retrying with the error fed back.

        ``schema`` is either a **shape schema** dict (a documented JSON-Schema subset:
        ``type``/``properties``/``required``/``enum``/``items``/``additionalProperties``)
        or a callable ``validate(obj)`` returning a falsy value when valid, or an error
        string / list of strings (or raising) when not. ``validate`` is an optional
        semantic validator that runs after the shape schema and participates in retries.

        Up to ``retries`` extra attempts are made; each attempt is a fresh ``agent()``
        call with a distinct prompt (so it checkpoints/resumes cleanly). If the agent
        itself fails (or is budget-skipped), returns immediately without burning retries.
        Returns a ``Structured`` (truthy when ``ok``).
        """
        if retries < 0:
            raise ValueError("retries must be >= 0")
        is_callable = callable(schema)
        if not is_callable:
            _check_schema_def(schema)  # raise on unsupported keywords before spending AIC
            schema_text = json.dumps(schema, sort_keys=True)
            shape = ("\n\nThe JSON must satisfy this shape (a documented subset of JSON "
                     f"Schema):\n{schema_text}")
        else:
            shape = ""
        base = (f"{prompt}\n\nReason briefly if needed, then on the FINAL line output ONLY one "
                f"JSON value (no code fences, nothing after it).{shape}")

        last_error = ""
        value: Any = None
        res: AgentResult | None = None
        attempts = 0
        for attempt in range(retries + 1):
            attempts = attempt + 1
            ask = base if not last_error else (
                f"{base}\n\nYour previous answer was rejected: {last_error}\n"
                "Return corrected JSON only.")
            res = self.agent(ask, model=model, label=label, **kw)
            if not res.ok:  # process failure / budget skip — retrying won't help
                return Structured(value=None, ok=False,
                                  error=res.error or "agent failed", raw=res, attempts=attempts)
            value = _extract_last_json(res.content, default=_JSON_NOT_FOUND)
            if value is _JSON_NOT_FOUND:
                last_error = "no JSON value found in the response"
                continue
            errs = self._validate_value(value, schema, is_callable)
            if not errs and validate is not None:
                errs = self._validate_value(value, validate, True)
            if not errs:
                return Structured(value=value, ok=True, error="", raw=res, attempts=attempts)
            last_error = "; ".join(errs)[:500]
        return Structured(value=value, ok=False, error=last_error or "invalid",
                          raw=res, attempts=attempts)

    @staticmethod
    def _validate_value(value: Any, schema: Any, is_callable: bool) -> list[str]:
        if is_callable:
            try:
                errs = schema(value)
            except Exception as e:  # a raising validator means "invalid"
                return [str(e)]
            if not errs:
                return []
            if isinstance(errs, str):
                return [errs]
            try:
                return [str(e) for e in errs]
            except TypeError:  # truthy non-iterable (e.g. a bare True) -> one error
                return [str(errs)]
        return _validate_shape(value, schema)

    def _structured_object(
        self,
        prompt: str,
        *,
        model: str | None,
        label: str,
        retries: int = 0,
        **kw: Any,
    ) -> Structured:
        def validate(obj):
            return "" if isinstance(obj, dict) else "expected JSON object"

        return self.structured(
            prompt, validate, retries=retries, model=model, label=label, **kw)

    # ---- fan-out -> barrier merge --------------------------------------
    def synthesize(
        self,
        results: Sequence[Any],
        *,
        prompt: str = "Synthesize the following inputs into one coherent, de-duplicated result.",
        model: str | None = None,
        label: str = "synthesize",
        **kw: Any,
    ) -> AgentResult:
        """Merge many results/items into a single answer via one agent call."""
        blocks = [f"=== Input {idx} ===\n{as_text(r)}" for idx, r in enumerate(results, 1)]
        body = "\n\n".join(blocks)
        full = f"{prompt}\n\n{body}"
        return self.agent(full, model=model, label=label, **kw)

    # ---- adversarial verification --------------------------------------
    def verify(
        self,
        subject: Any,
        *,
        rubric: Any,
        refute: bool = True,
        model: str | None = None,
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
            f"{persona}\n\nRUBRIC / CRITERIA:\n{as_text(rubric)}\n\n"
            f"WORK UNDER REVIEW:\n{as_text(subject)}\n\n"
            "Decide whether the work satisfies the rubric. Give brief reasoning, then on the "
            'FINAL line output ONLY a JSON object: '
            '{"passed": true|false, "score": 0..1, "reasons": "..."}'
        )
        structured = self._structured_object(prompt, model=model, label=label, retries=0, **kw)
        if not structured.raw.ok:
            error = structured.raw.error or "verifier agent failed"
            return Verdict(
                passed=False, score=None, reasons=error, raw=structured.raw,
                ok=False, error=error)
        data = structured.value if structured.ok else {}
        raw = data.get("passed", False)
        passed = raw.strip().lower() == "true" if isinstance(raw, str) else bool(raw)
        return Verdict(
            passed=passed,
            score=_as_float(data.get("score")),
            reasons=str(data.get("reasons", structured.raw.content.strip())),
            raw=structured.raw,
        )

    def consensus(
        self,
        subject: Any,
        *,
        rubric: Any,
        reviewers: int = 3,
        refute: bool = True,
        model: str | None = None,
        models: Sequence[str] | None = None,
        label: str = "consensus",
        **kw: Any,
    ) -> Consensus:
        """Run multiple independent verifiers and return a quorum-backed majority verdict."""
        if reviewers < 1:
            raise ValueError("reviewers must be >= 1")
        model_cycle = list(models or [])
        if model is not None and model_cycle:
            raise ValueError("pass either model or models, not both")
        if not all(str(m).strip() for m in model_cycle):
            raise ValueError("models must contain non-empty model names")

        def review(i: int) -> Verdict:
            reviewer_model = model_cycle[i % len(model_cycle)] if model_cycle else model
            return self.verify(
                subject, rubric=rubric, refute=refute, model=reviewer_model,
                label=f"{label}-{i + 1}", **kw)

        verdicts = self.fan_out(list(range(reviewers)), review)
        quorum = reviewers // 2 + 1
        failed_verifiers = [v for v in verdicts if not v.ok]
        good = [v for v in verdicts if v.ok]
        passed_count = sum(1 for v in good if v.passed)
        failed_count = len(good) - passed_count
        errored_count = len(failed_verifiers)
        if len(good) < quorum:
            error = "%d/%d successful reviewers; quorum is %d" % (
                len(good), reviewers, quorum)
            if failed_verifiers:
                error += "; " + "; ".join(v.error or v.reasons for v in failed_verifiers)
            return Consensus(
                passed=False, passed_count=passed_count, failed_count=failed_count,
                errored_count=errored_count, reviewers=reviewers, reasons=error,
                dissent="", verdicts=verdicts, ok=False, error=error)

        threshold = len(good) // 2 + 1
        majority_passed = passed_count >= threshold
        dissenting = [
            (i, v) for i, v in enumerate(verdicts, 1)
            if v.ok and v.passed != majority_passed
        ]
        dissent = "\n".join(
            "reviewer %d %s: %s" % (i, "passed" if v.passed else "failed", v.reasons)
            for i, v in dissenting
        )
        reasons = "%d/%d successful reviewers passed" % (passed_count, len(good))
        if failed_verifiers:
            reasons += "; %d verifier error(s) ignored after quorum" % errored_count
        if dissent:
            reasons += "; dissent:\n" + dissent
        else:
            reasons += "; unanimous"
        return Consensus(
            passed=majority_passed, passed_count=passed_count, failed_count=failed_count,
            errored_count=errored_count, reviewers=reviewers, reasons=reasons,
            dissent=dissent, verdicts=verdicts)

    # ---- pairwise comparative judgment ---------------------------------
    def tournament(
        self,
        candidates: Sequence[Any],
        *,
        criteria: str = "overall quality",
        model: str | None = None,
        label: str = "judge",
        **kw: Any,
    ) -> Any:
        """Single-elimination bracket; comparative judgment picks one winner.

        Raises if a judge agent fails or does not return a valid winner.
        """
        items = list(candidates)
        if not items:
            return None
        round_no = 0
        while len(items) > 1:
            round_no += 1
            pairs = [(items[i], items[i + 1]) for i in range(0, len(items) - 1, 2)]
            byes = items[-1:] if len(items) % 2 else []
            self.log(f"  tournament round {round_no}: {len(pairs)} pair(s), {len(byes)} bye(s)")
            winners = self.fan_out(
                pairs, lambda pr: self._judge_pair(pr[0], pr[1], criteria, model, label, kw))
            items = list(winners) + byes
        return items[0]

    def _judge_pair(self, a: Any, b: Any, criteria: str, model: str | None,
                    label: str, kw: dict[str, Any]) -> Any:
        prompt = (
            f"Compare two candidates on: {criteria}.\n\n"
            f"=== Candidate A ===\n{as_text(a)}\n\n=== Candidate B ===\n{as_text(b)}\n\n"
            "Pick the single better candidate. Give brief reasoning, then on the FINAL line "
            'output ONLY JSON: {"winner": "A"|"B", "why": "..."}'
        )
        structured = self._structured_object(prompt, model=model, label=label, retries=0, **kw)
        if not structured.raw.ok:
            raise RuntimeError(
                f"judge agent failed: {structured.raw.error or 'unknown error'}")
        if not structured.ok:
            raise ValueError("judge did not return a JSON object")
        data = structured.value
        winner = str(data.get("winner", "A")).strip().upper()
        if winner.startswith("A"):
            return a
        if winner.startswith("B"):
            return b
        raise ValueError("judge did not return winner A or B")

    # ---- generate -> dedupe -> filter ----------------------------------
    def generate_and_filter(
        self,
        generate: str | Sequence[str],
        *,
        n: int = 5,
        keep: Callable[[AgentResult], bool] | None = None,
        rubric: Any | None = None,
        dedupe: bool = True,
        model: str | None = None,
        label: str = "generate",
    ) -> list[AgentResult]:
        """Generate candidates, drop duplicates, keep those passing a filter."""
        prompts = [generate] * n if isinstance(generate, str) else list(generate)
        cands: list[AgentResult] = self.fan_out(
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
        model: str | None = None,
        label: str = "classify",
        instructions: str | None = None,
        **kw: Any,
    ) -> str:
        """Return exactly one of ``classes`` for ``text``; raise if no valid label is returned."""
        classes = list(classes)
        if not classes:
            raise ValueError("classes must contain at least one category")
        cats = ", ".join(classes)
        instr = f"{instructions}\n" if instructions else ""
        prompt = (
            f"Classify the input into exactly one of these categories: {cats}.\n{instr}"
            f"INPUT:\n{as_text(text)}\n\n"
            'FINAL line: ONLY JSON {"category": "<one of the categories>"}'
        )
        structured = self._structured_object(prompt, model=model, label=label, retries=0, **kw)
        if not structured.raw.ok:
            raise RuntimeError(
                f"classifier agent failed: {structured.raw.error or 'unknown error'}")
        if not structured.ok:
            raise ValueError(f"classifier did not return valid JSON category: {classes!r}")
        data = structured.value
        cat = str(data.get("category", "")).strip()
        for c in classes:
            if cat.lower() == c.lower():
                return c
        raise ValueError(f"classifier did not return exactly one valid category: {classes!r}")

    # ---- loop until a stop condition -----------------------------------
    def loop_until(
        self,
        step: Callable[[int], Any],
        done: Callable[[Any], bool],
        *,
        max_iters: int = 10,
    ) -> list[Any]:
        """Call ``step(i)`` until ``done(result)`` is true or ``max_iters`` reached."""
        history: list[Any] = []
        for i in range(max_iters):
            r = step(i)
            history.append(r)
            if done(r):
                break
        return history

    # ---- quarantine (security) -----------------------------------------
    def quarantine(
        self,
        *,
        deny: Sequence[str] | None = None,
        deny_url: Sequence[str] | None = None,
        enable_mcp: bool = False,
        **extra: Any,
    ) -> dict:
        """kwargs for ``agent(...)`` that lock down an untrusted-content reader.

        Defaults are read-only with no egress: deny shell + write, deny all URLs
        (``["*"]``), and disable built-in MCP servers (e.g. GitHub). Local file
        reads still work. For a reader that legitimately needs the network
        (e.g. web research), pass ``deny_url=[]`` and/or ``enable_mcp=True``.
        """
        out = dict(
            allow_all_tools=True,  # keep non-interactive happy; deny wins anyway
            deny=list(deny) if deny is not None else ["shell", "write"],
            deny_url=list(deny_url) if deny_url is not None else ["*"],
            enable_mcp=enable_mcp,
        )
        out.update(extra)
        return out
