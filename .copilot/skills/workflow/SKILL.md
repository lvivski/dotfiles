---
name: workflow
description: >-
    Author and run a dynamic workflow with cwf — an orchestration harness that fans work out to
    many Copilot subagents in parallel (fan-out/synthesize, adversarial verification, tournaments,
    generate-and-filter, classify-and-route, loop-until-done), with checkpoint/resume, a
    premium-request budget, and a live progress view. Use this when the user says "ultrawork",
    "use a workflow", "run a workflow", or asks to parallelize, fan out, cross-check, adversarially
    verify, audit/migrate at scale across many files, deeply research a question, rank/triage a
    large list, or otherwise do work that one conversation context cannot reliably hold.
user-invocable: true
---

# Dynamic workflows on the Copilot CLI (cwf)

A **dynamic workflow** is a small synchronous Python script (a *harness*) that you write for the
task at hand. It orchestrates many `copilot` subagents through the `wf` runtime: the loop,
branching, and intermediate results live in the script, so your conversation context only holds
the final synthesized answer. This defeats the failure modes of long single-context runs —
*agentic laziness*, *self-preferential bias*, and *goal drift* — by giving each subagent its own
clean context and an isolated, verifiable goal.

Run a harness with `cwf run harness.py`. The harness prints its final answer to **stdout**; cwf
prints progress and stats to stderr. Read stdout back and present it to the user.

## When to use a workflow

Reach for a workflow when a task needs more agents than one conversation can coordinate, or wants
a repeatable quality pattern (independent agents cross-checking each other). Good fits:

* Codebase-wide audits/sweeps; migrations or refactors across many files.
* Deep research that fans out sources and cross-checks claims.
* Ranking/sorting/triage of large lists (use comparative judgment, not absolute scoring).
* Hard plans worth drafting from several independent angles before committing.
* Anything where you'd otherwise paste 50+ items into one prompt and quality would degrade.

**Do NOT** use a workflow for ordinary single-file edits or quick questions — it costs
meaningfully more. Ask yourself: does this really need more compute? Most coding tasks do not need
a panel of five reviewers.

## Procedure (follow this)

1. **Decompose** the task into phases and pick patterns (see *Patterns* below). Decide which model
   each stage needs — a small model (e.g. `claude-haiku-4.5`) for wide fan-out workers, a stronger
   one (e.g. `claude-sonnet-4.5`) for synthesis/judging.
2. **Write the harness** to a file: `./<name>.cwf.py` for one-offs, or
   `~/.copilot/workflows/<name>.py` to reuse it later. Use the `wf` API (reference below). Keep the
   harness plain synchronous Python — never use `async`/`await`; concurrency lives inside `wf`.
3. **Present the plan and confirm.** Before running anything that will spend real credits, show the
   user: the phases, the approximate number of subagents, the models, and a **budget** in premium
   credits. Ask them to confirm or adjust (use the AskUserQuestion / ask_user tool). Skip the
   prompt only if the user already said to go ahead or is running you autonomously. You can preview
   the plan cost-free with `cwf run harness.py --dry-run`.
4. **Run it:** `cwf run harness.py --budget <N> [--model <default>] [--disable-mcp] [--args <json>]`.
   Always pass a `--budget`. Add `--disable-mcp` for agents that don't need GitHub/MCP (faster,
   cheaper). For a big job, run a small slice first (one directory, a narrow question) to gauge cost.
5. **Return the result.** Read stdout (the synthesis) and present it. If the run was interrupted or
   hit budget, tell the user how to continue: `cwf run harness.py --resume <runId>`.

## The `wf` API

The harness is executed with two names injected: `wf` (the runtime) and `args` (the parsed
`--args` value, or `None`). Everything is synchronous.

```python
# --- one subagent -----------------------------------------------------------
r = wf.agent(prompt, *, model=None, agent=None, effort=None, cwd=None, phase=None,
             disable_mcp=False, timeout=None, label=None,
             allow=None, deny=None, allow_url=None, deny_url=None, add_dir=None, mcp=None)
# -> AgentResult: .content  .ok  .premium_requests  .output_tokens
#                 .session_id  .model  .cached  .error   ; str(r) == r.content
# phase= assigns this agent's progress group explicitly — use it inside pipeline()/
# parallel() so concurrent items don't race on the wf.phase() context.

wf.follow_up(r, prompt, **kw)            # another turn in the same session (multi-turn)

# --- pipeline (streaming) — THE DEFAULT for multi-stage work -----------------
rows = wf.pipeline(items, stage1, stage2, ...)
# Each item streams through ALL stages independently — NO barrier between stages, so
# item A can be in stage 3 while item B is still in stage 1 (wall-clock = slowest single
# item *chain*, not sum-of-slowest-per-stage). A stage is called stage(prev, item, idx)
# and may take 1–3 args; prev is the previous stage's return (the item itself for stage 1).
# A stage that raises drops that item to None (others continue). Tag inner agents with
# phase=/label= so the progress view groups them correctly. Example:
#   rows = wf.pipeline(files,
#       lambda f: wf.agent(f"review {f}", phase="review", label=f, model="claude-haiku-4.5"),
#       lambda rev, f, i: wf.verify(rev, rubric="exploitable, with evidence"))

# --- barriers: parallel(thunks) and fan_out(items, fn) ----------------------
results = wf.fan_out(items, lambda x: wf.agent(make_prompt(x), label=str(x)))
# fan_out is a BARRIER: it waits for every branch; fn may nest wf.agent/wf.fan_out.
both = wf.parallel([lambda: wf.agent(a), lambda: wf.agent(b)])  # barrier over zero-arg thunks
# Reach for a barrier ONLY when a stage needs ALL prior results at once (dedupe/merge,
# zero-count early-exit, cross-item comparison). Otherwise prefer pipeline().

# --- patterns (compose freely) ----------------------------------------------
merged   = wf.synthesize(results, prompt="Merge into one report.", model="claude-sonnet-4.5")
verdict  = wf.verify(work, rubric="must cite a source for each claim", refute=True)
#          -> Verdict: .passed (truthy)  .score (0..1)  .reasons  .raw
winner   = wf.tournament(candidates, criteria="clearest API design")
kept     = wf.generate_and_filter("Propose a name for X", n=8, rubric="short, memorable, available")
label    = wf.classify(ticket_text, ["bug", "feature", "question"])
history  = wf.loop_until(lambda i: do_step(i), lambda r: r.ok, max_iters=10)

# --- guaranteed-shape output (validated, with retry) ------------------------
s = wf.structured("List the failing tests as JSON.",
                  {"type": "object", "required": ["tests"],
                   "properties": {"tests": {"type": "array", "items": {"type": "string"}}}},
                  retries=2)
# -> Structured: .value (the validated object/array)  .ok (truthy)  .error  .attempts  .raw
# schema is a shape-schema dict (type/properties/required/enum/items/additionalProperties)
# OR a callable validate(obj) -> "" when ok else an error string. On a bad shape it feeds
# the error back and retries; if the agent itself fails it stops immediately. Prefer this
# over hand-parsing JSON out of .content.

# --- composing saved workflows ----------------------------------------------
report = wf.workflow("deep-research", args="What changed in HTTP/3 since 2022?")
# Runs ~/.copilot/workflows/<name>.{cwf.,}py (or a path) inline on THIS runtime — shared
# budget/concurrency/checkpoints/progress — and returns what the child printed. Call it at
# the TOP LEVEL only (not inside fan_out/pipeline/parallel) and nest at most one level.

# --- structure, isolation, safety, cost ------------------------------------
with wf.phase("port files"):            # groups agents in the live view
    ...
with wf.worktree(f"fix-{item}") as path:    # isolated checkout — use a UNIQUE name per branch
    wf.agent("apply the fix", cwd=path)
q = wf.quarantine()                      # reader of untrusted content: no shell/write tools
note = wf.agent(f"summarize this web page: {url}", **q)
wf.budget(20)                            # cap premium-request credits (also: cwf --budget)
while wf.budget_total and wf.remaining() > 1:   # loop-until-budget (guard the inf case!)
    wf.agent("find one more bug")
wf.log("phase 2 complete")               # diagnostic line to stderr
```

Return the final answer by `print()`-ing it to stdout at the end of the harness.

## Patterns (recipes)

* **Pipeline (default for multi-stage work)** — stream each item through stages with no
  barrier between them, so a slow item never holds up the fast ones. Reach for a barrier
  (`fan_out`/`parallel`/`synthesize`) only when a stage truly needs every prior result at
  once (dedupe/merge, zero-count early-exit, cross-item comparison).
  ```python
  # review each changed file, then verify that review — verification of file A starts as
  # soon as A's review lands, while file B is still being reviewed.
  rows = wf.pipeline(files,
      lambda f: wf.agent(f"Review {f} for bugs", model="claude-haiku-4.5", phase="review", label=f),
      lambda rev, f, i: {"file": f, "verdict": wf.verify(rev, rubric="real, reproducible bug")})
  print(wf.synthesize([r for r in rows if r["verdict"].passed], prompt="Group by severity."))
  ```
* **Fan-out-and-synthesize** — split work, run one agent per piece, merge at a barrier.
  ```python
  parts = wf.fan_out(files, lambda f: wf.agent(f"Summarize {f}", model="claude-haiku-4.5", label=f))
  print(wf.synthesize(parts, prompt="Write one overview.", model="claude-sonnet-4.5"))
  ```
* **Adversarial verification** — for each finding, spawn a refuter to attack it; keep survivors.
  ```python
  findings = wf.fan_out(endpoints, lambda e: wf.agent(f"Find auth gaps in {e}", label=e))
  solid = [f for f in findings if wf.verify(f, rubric="exploitable, with evidence").passed]
  ```
* **Tournament** (ranking/taste) — comparative judgment is more reliable than scoring.
  `best = wf.tournament(options, criteria="...")`.
* **Generate-and-filter** — `wf.generate_and_filter(prompt, n=N, rubric="...")` dedupes and keeps
  only candidates that pass.
* **Classify-and-route** — `tag = wf.classify(item, [...])` then branch on `tag`.
* **Loop-until-done** — repeat until a stop condition (no new findings, tests pass):
  `wf.loop_until(step, lambda r: done(r), max_iters=K)`.
* **Quarantine** (security) — agents that read untrusted/public content get `**wf.quarantine()**`
  (no shell/write); a separate trusted *actor* agent, fed only their structured output, takes any
  privileged action.

## Quality guidance (how to size and harden a workflow)

* **Scout inline first, then orchestrate.** Discover the work-list yourself (list files, scope the
  diff, find the channels) in the conversation, *then* fan out over it. You only need to know the
  shape before the *orchestration step*, not before the task.
* **Scale to the ask.** "find any bugs" → a few finders, single-vote verify. "thoroughly audit" /
  "be comprehensive" → larger finder pool + a 3–5-vote adversarial pass + a synthesis stage. Lean
  thorough for research/review/audit; lean brief for quick checks.
* **Diverse-lens verify.** When a finding can fail in more than one way, give each verifier a
  distinct lens (correctness, security, perf, does-it-reproduce) instead of N identical refuters —
  diversity catches failure modes that redundancy can't.
* **Loop-until-dry** (unknown-size discovery) — keep spawning finders until K consecutive rounds
  surface nothing new; dedupe against everything seen so far, not just what you kept.
* **No silent caps.** If a workflow bounds coverage (top-N, sampling, no-retry), `wf.log()` what was
  dropped — silent truncation reads as "covered everything" when it didn't.

## A complete minimal harness

```python
# triage.cwf.py — classify, cross-check, and summarize a batch of tickets.
tickets = args or ["app crashes on export", "please add dark mode", "how do I reset my password?"]

def handle(t):
    kind = wf.classify(t, ["bug", "feature", "question"], model="claude-haiku-4.5")
    detail = wf.agent(f"In one sentence, suggest next action for this {kind}: {t}",
                      model="claude-haiku-4.5", label=kind)
    return {"ticket": t, "kind": kind, "action": detail.content.strip()}

with wf.phase("triage"):
    rows = wf.fan_out(tickets, handle)

report = wf.synthesize([f"{r['kind']}: {r['ticket']} -> {r['action']}" for r in rows],
                       prompt="Group these by kind into a short triage report.",
                       model="claude-sonnet-4.5")
print(report.content)
```

Run: `cwf run triage.cwf.py --budget 5 --disable-mcp --args '["ticket one", "ticket two"]'`

## Cost, resume, and visibility

* **Budget** in premium-request credits. Always set `--budget`. By default, once the budget is hit,
  remaining agents are skipped (the run "drains" gracefully) rather than aborting; `--strict-budget`
  stops hard. Use a small/cheaper model for wide fan-out, a strong one only for synthesis/judging.
* **Resume** — runs checkpoint each completed agent. If interrupted, rerun with
  `cwf run harness.py --resume <runId>`; finished agents return instantly.
* **Watch / list** — `cwf runs` lists recent runs; `cwf watch <runId>` shows live progress.
* **Personas (optional)** — pass `agent="verifier"` (etc.) to `wf.agent` to use a reusable persona
  from `~/.copilot/agents/`. The built-in patterns already embed strong personas, so this is only
  for extra steering.
* **Restricted mode** — `cwf run harness.py --restricted` runs the harness orchestration-only and
  deterministically: no `open`/`exec`/`eval`, no fs/proc/net imports, and no `time`/`random`/
  `datetime`/`uuid` (blocked imports fail fast; pass timestamps via `args`, vary randomness by index;
  `wf.workflow` is limited to saved-workflow names). Use it when running a harness you don't fully
  trust. It is **defense-in-depth + resume-safety, not a security jail** (in-process Python `exec` is
  escapable) — pair it with an OS/agent sandbox (`copilot --cloud` / `/sandbox`) for untrusted authors.
  This is a different layer from `wf.quarantine()`, which sandboxes the untrusted *content a subagent
  reads*; `--restricted` sandboxes the untrusted *harness code*.

## Saving and reusing

A harness is just a file. Drop a polished one in `~/.copilot/workflows/<name>.py` and rerun it any
time with `cwf run ~/.copilot/workflows/<name>.py --args ...`. Read `args` inside the harness to
parameterize it (target paths, a question, a list) instead of editing the script each run.
