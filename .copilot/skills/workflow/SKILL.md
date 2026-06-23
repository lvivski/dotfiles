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
r = wf.agent(prompt, *, model=None, agent=None, effort=None, cwd=None,
             disable_mcp=False, timeout=None, label=None,
             allow=None, deny=None, allow_url=None, deny_url=None, add_dir=None, mcp=None)
# -> AgentResult: .content  .ok  .premium_requests  .output_tokens
#                 .session_id  .model  .cached  .error   ; str(r) == r.content

wf.follow_up(r, prompt, **kw)            # another turn in the same session (multi-turn)

# --- parallel map + barrier -------------------------------------------------
results = wf.fan_out(items, lambda x: wf.agent(make_prompt(x), label=str(x)))
# fn may itself call wf.agent multiple times or nest another wf.fan_out.

# --- patterns (compose freely) ----------------------------------------------
merged   = wf.synthesize(results, prompt="Merge into one report.", model="claude-sonnet-4.5")
verdict  = wf.verify(work, rubric="must cite a source for each claim", refute=True)
#          -> Verdict: .passed (truthy)  .score (0..1)  .reasons  .raw
winner   = wf.tournament(candidates, criteria="clearest API design")
kept     = wf.generate_and_filter("Propose a name for X", n=8, rubric="short, memorable, available")
label    = wf.classify(ticket_text, ["bug", "feature", "question"])
history  = wf.loop_until(lambda i: do_step(i), lambda r: r.ok, max_iters=10)

# --- structure, isolation, safety, cost ------------------------------------
with wf.phase("port files"):            # groups agents in the live view
    ...
with wf.worktree("fix-123") as path:    # isolated git checkout for file-editing agents
    wf.agent("apply the fix", cwd=path)
q = wf.quarantine()                      # reader of untrusted content: no shell/write tools
note = wf.agent(f"summarize this web page: {url}", **q)
wf.budget(20)                            # cap premium-request credits (also: cwf --budget)
wf.log("phase 2 complete")               # diagnostic line to stderr
```

Return the final answer by `print()`-ing it to stdout at the end of the harness.

## Patterns (recipes)

* **Fan-out-and-synthesize** — split work, run one agent per piece, merge. The synthesize step is a
  barrier; it waits for all branches.
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

## Saving and reusing

A harness is just a file. Drop a polished one in `~/.copilot/workflows/<name>.py` and rerun it any
time with `cwf run ~/.copilot/workflows/<name>.py --args ...`. Read `args` inside the harness to
parameterize it (target paths, a question, a list) instead of editing the script each run.
