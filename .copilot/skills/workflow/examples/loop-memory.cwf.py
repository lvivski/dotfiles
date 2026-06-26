# loop-memory.cwf.py — durable cross-run memory for `cwf loop`.
#
#   cwf loop ./loop-memory.cwf.py --every 10m --budget 1000 \
#       --memory ~/.copilot/workflows/state/sweep.md --args '"src/"'
#
# Each tick is a FRESH run (checkpoints reset every tick), but --memory persists ACROSS
# ticks. The harness reads what prior ticks recorded and appends one new note for the
# next tick, so the loop makes incremental progress instead of repeating itself — the
# "memory" primitive of loop engineering. Works in --restricted: the runtime owns the
# file I/O, so the harness needs no open()/os.
#
# wf.memory is always safe to call: with no --memory it is disabled (read() -> "",
# writes are no-ops), and under --dry-run reads work but writes are suppressed.

target = args if isinstance(args, str) else "the codebase"

done = wf.memory.read()  # everything prior ticks recorded ("" on the first tick)
if not wf.memory.enabled:
    wf.log("loop-memory: no --memory file set — this tick's note will not persist.")

result = wf.agent(
    "Suggest exactly ONE concrete, actionable improvement for %s that is NOT already "
    "listed below. Answer with a single short line.\n\n"
    "=== Already done (do not repeat) ===\n%s" % (target, done or "(nothing yet)"),
    label="next-step",
)

note = result.content.strip() if result.ok else ""
if note:
    wf.memory.append("- " + note.splitlines()[0])  # persist for the next tick
    print(note)
else:
    print("(no new suggestion this tick: %s)" % (result.error or "empty"))
