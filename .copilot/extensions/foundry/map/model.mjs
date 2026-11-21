/** @typedef {ReturnType<typeof import("../work/status.mjs").status>} Status */
/** @param {Status} s */
export function mapSnapshot(s) {
	const latest = new Map(s.reviews.map(r => [r.squad, r]));
	return {
		run: s.run, direction: s.direction, example: false,
		owner: "qualified" in s,
		phase: !s.active ? (s.qualified && s.goal ? "Qualified" : "qualified" in s ? "Paused" : "Inactive") : s.expired ? "Deadline elapsed" : "Active",
		qualified: s.qualified ?? null, checkpoint: s.checkpoint ?? null,
		timing: s.metrics ? { firstWriter: s.metrics.firstWriter.state, writerMs: s.metrics.firstWriter.elapsedMs,
			qualifiedMs: s.metrics.qualified.elapsedMs } : null,
		blocker: s.blocker ?? s.discoveryError ?? "",
		holds: [...new Set(s.pending.flatMap(p => p.reason ? [p.reason] : []))],
		scoutIssues: s.goal && s.qualified ? [] : [...latest.values()].flatMap(r => {
			if (r.state === "blocked" && r.reason) return [`${r.squad}: ${r.reason}`];
			const o = r.state === "observed" ? r.observation : undefined;
			return o?.outcome === "waiting" ? [`${r.squad} waits for ${o.waitFor}: ${o.reason}`] : [];
		}),
		questions: (s.questions ?? []).map(q => {
			const d = q.delivery;
			return d?.status === "unavailable" ? `${q.question} — ${d.reason}` :
				d ? `${q.question} — ${d.status === "presenting" ? "sent to owner; delivery may be unconfirmed" : d.status}` : q.question;
		}),
		scouting: s.reviews.filter(r => r.state === "reading" && r.workflowId).length,
		scoutsStarting: s.reviews.filter(r => r.state === "reading" && !r.workflowId).length,
		goal: s.goal ? { commit: s.goal.commit, result: s.goal.receipt ? { exit: s.goal.receipt.exit, output: s.goal.receipt.output } : null } : null,
		nodes: s.nodes.map(n => ({
			id: n.grain, task: n.task ?? "", directory: n.directory, needs: n.requires,
			state: n.state === "writing" ? (!("worker" in n) ? "assigned" : n.worker ? "writing" : "starting") : n.state,
			reason: n.reason ?? "", check: n.evaluator, checked: n.checked ?? null,
			result: n.receipt ? { commit: n.receipt.commit, exit: n.receipt.exit } : null,
		})),
	};
}

/** @typedef {ReturnType<typeof mapSnapshot>} MapSnapshot */
/** @typedef {MapSnapshot["nodes"][number]} Assignment */

// An explicitly selected example, never a fallback for a missing or inaccessible run.
/** @type {MapSnapshot} */
export const example = {
	run: "file-catalog", direction: "Search a local file catalog and export the matching entries.",
	example: true, owner: true, phase: "Active", qualified: null, checkpoint: null, timing: null, blocker: "",
	holds: [], scoutIssues: [], questions: [], scouting: 0, scoutsStarting: 0, goal: { commit: "8c0d27b", result: { exit: 1, output: "The saved catalog cannot be searched or exported yet." } },
	nodes: [
		{ id: "catalog-format", task: "Preserve file names and types in a portable catalog.", directory: "src/catalog", needs: [], state: "published", reason: "", check: "checks/catalog", checked: "f41c0a8", result: { commit: "f41c0a8", exit: 0 } },
		{ id: "file-reader", task: "Read file entries from a saved catalog.", directory: "src/reader", needs: ["catalog-format"], state: "writing", reason: "", check: "checks/read", checked: null, result: null },
		{ id: "csv-format", task: "Encode catalog entries as CSV, including names containing commas.", directory: "src/csv", needs: ["catalog-format"], state: "writing", reason: "", check: "checks/csv", checked: null, result: null },
		{ id: "search-index", task: "Find files by name without dropping entries that share a name.", directory: "src/index", needs: [], state: "blocked", reason: "The index check found one entry for two files with the same name. The repair allowance is exhausted.", check: "checks/index", checked: null, result: { commit: "2cb634a", exit: 1 } },
		{ id: "export-results", task: "Export the entries from the saved catalog.", directory: "cli/export", needs: ["file-reader", "csv-format"], state: "waiting", reason: "", check: "checks/export", checked: null, result: null },
		{ id: "search-command", task: "Search the saved catalog from the command line.", directory: "cli/search", needs: ["file-reader", "search-index"], state: "waiting", reason: "", check: "checks/search", checked: null, result: null },
	],
};
