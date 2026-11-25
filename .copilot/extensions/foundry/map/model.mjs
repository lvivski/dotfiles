import { boardFacts, projectBoard } from "../work/visibility.mjs";

/** @param {ReturnType<typeof boardFacts>["pending"][number]} p */
function pendingMessage(p) {
	const labels = { goal: "Goal check", component: "Component check", product: "Product check", writer: "Writer launch",
		scout: "Scout", repair: "Repair notice", handoff: "Handoff notice", decision: "Decision notice", artifact: "Reference notice", escalation: "Unowned blocker notice" };
	const label = labels[p.kind] + (p.grain ? ` (${p.grain})` : "");
	const reason = p.reason?.replace(/^(?:Error: )+/, "");
	if (p.evaluating) return `${label} started; no evaluator result recorded yet.`;
	return reason ? `${label}: ${reason}` : undefined;
}

/** @param {import("../work/model.js").Run} run @param {string} actor */
export function boardSnapshot(run, actor) {
	return mapSnapshot(boardFacts(run, actor));
}

/** The canvas supplies boardFacts. Older internal callers already holding status
 * can project it without constructing a second map implementation.
 * @param {ReturnType<typeof boardFacts>|import("../work/visibility.mjs").BoardSource} source */
export function mapSnapshot(source) {
	const s = "owner" in source ? source : projectBoard(source, !!source.metrics);
	const latest = new Map(s.reviews.map(r => [r.squad, r]));
	return {
		run: s.run, direction: s.direction, example: false,
		owner: s.owner,
		phase: !s.active ? (s.qualified && s.goal ? "Qualified" : s.owner ? "Paused" : "Inactive") : s.expired ? "Deadline elapsed" : "Active",
		qualified: s.qualified, checkpoint: s.checkpoint, timing: s.timing, blocker: s.blocker,
		holds: [...new Set(s.pending.flatMap(p => pendingMessage(p) ?? []))],
		scoutIssues: s.goal && s.qualified ? [] : [...latest.values()].flatMap(r => {
			if (r.state === "blocked" && r.reason) return [`${r.squad}: ${r.reason}`];
			const o = r.state === "observed" ? r.observation : undefined;
			if (o?.outcome === "unresolved") return [`${r.squad}: ${o.reason}`];
			return o?.outcome === "waiting" ? [`${r.squad} waits for ${o.waitFor}: ${o.reason}`] : [];
		}),
		questions: s.questions.map(q => q.delivery === "unavailable" ? `${q.question} — ${q.reason}` :
			q.delivery ? `${q.question} — ${q.delivery === "presenting" ? "sent to owner; delivery may be unconfirmed" : q.delivery}` : q.question),
		scouting: s.reviews.filter(r => r.state === "reading" && r.started).length,
		scoutsStarting: s.reviews.filter(r => r.state === "reading" && !r.started).length,
		goal: s.goal, nodes: s.nodes,
	};
}

/** @typedef {ReturnType<typeof boardSnapshot>} BoardSnapshot */
/** @typedef {BoardSnapshot} MapSnapshot */
/** @typedef {MapSnapshot["nodes"][number]} Assignment */

// An explicitly selected example, never a fallback for a missing or inaccessible run.
/** @type {MapSnapshot} */
export const example = {
	run: "file-catalog", direction: "Search a local file catalog and export the matching entries.",
	example: true, owner: true, phase: "Active", qualified: null, checkpoint: null, timing: null, blocker: "",
	holds: [], scoutIssues: [], questions: [], scouting: 0, scoutsStarting: 0, goal: { commit: "8c0d27b", result: { exit: 1, output: "The saved catalog cannot be searched or exported yet." } },
	nodes: [
		{ id: "catalog-format", task: "Preserve file names and types in a portable catalog.", directory: "src/catalog", needs: [], state: "published", reason: "", check: "checks/catalog", checked: "f41c0a8", result: { commit: "f41c0a8", exit: 0 } },
		{ id: "file-reader", task: "Read file entries from a saved catalog.", directory: "src/reader", needs: ["catalog-format"], state: "assigned", reason: "", check: "checks/read", checked: null, result: null },
		{ id: "csv-format", task: "Encode catalog entries as CSV, including names containing commas.", directory: "src/csv", needs: ["catalog-format"], state: "assigned", reason: "", check: "checks/csv", checked: null, result: null },
		{ id: "search-index", task: "Find files by name without dropping entries that share a name.", directory: "src/index", needs: [], state: "blocked", reason: "The index check found one entry for two files with the same name. The repair allowance is exhausted.", check: "checks/index", checked: null, result: { commit: "2cb634a", exit: 1 } },
		{ id: "export-results", task: "Export the entries from the saved catalog.", directory: "cli/export", needs: ["file-reader", "csv-format"], state: "waiting", reason: "", check: "checks/export", checked: null, result: null },
		{ id: "search-command", task: "Search the saved catalog from the command line.", directory: "cli/search", needs: ["file-reader", "search-index"], state: "waiting", reason: "", check: "checks/search", checked: null, result: null },
	],
};
