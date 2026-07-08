// loop-memory.cwf.mjs — durable cross-run memory (for scheduled/recurring workflow ticks).
//
//   run_workflow({ name: "loop-memory", budget: 1000,
//                  memory: "~/.copilot/workflows/state/sweep.md", args: "src/" })
//
// Each run is fresh (checkpoints reset), but `memory` persists ACROSS runs. The harness reads what
// prior runs recorded and appends one new note, so a recurring loop makes incremental progress
// instead of repeating itself. Works in restricted mode: the runtime owns the file I/O, so the
// harness needs no fs access. `memory` is always safe to call: with no memory path it is disabled
// (read() -> "", writes are no-ops), and under dryRun reads work but writes are suppressed.
export const meta = { name: "loop-memory", description: "Append one non-duplicate note per run to durable cross-run memory." };

const target = typeof args === "string" ? args : "the codebase";

const done = memory.read(); // everything prior runs recorded ("" on the first run)
if (!memory.enabled) log("loop-memory: no memory file set — this run's note will not persist.");

const result = await agent(
	`Suggest exactly ONE concrete, actionable improvement for ${target} that is NOT already listed below. Answer with a single short line.\n\n=== Already done (do not repeat) ===\n${done || "(nothing yet)"}`,
	{ label: "next-step" },
);

const note = result.ok ? result.content.trim() : "";
if (note) {
	memory.append("- " + note.split("\n")[0]); // persist for the next run
	return note;
}
return `(no new suggestion this run: ${result.error || "empty"})`;
