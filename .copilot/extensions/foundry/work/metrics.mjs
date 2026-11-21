import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { qualifiedProduct } from "./evidence.mjs";

/** @param {unknown} value @returns {number|null} */
function instant(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
/** @param {number|null} start @param {number|null} end */
const elapsed = (start, end) => start !== null && end !== null && end >= start ? end - start : null;
/** @param {string} message */
const messageHash = message => createHash("sha256").update(message).digest("hex");

/** Owner-only projection of a decoded run (qualified products already require exact runner receipts).
 * Retired assignments still have effects; a `writing` node can be only a reservation.
 * @param {import("./model.js").Run} run */
export function metricsFacts(run) {
	const activatedAt = instant(run.activatedAt);
	const creates = run.effects.filter(e => e.kind === "writer" && e.tool === "create_session");
	const writers = creates.flatMap(e => {
		if (e.state !== "done" || !e.nativeId) return [];
		const k = e.args.kickoff;
		const prompt = k && typeof k === "object" && !Array.isArray(k) && k.prompt;
		return [{ nativeId: e.nativeId, boundAt: instant(e.boundAt),
			kickoffHash: typeof prompt === "string" && prompt.length ? messageHash(prompt) : null }];
	});
	const qualified = qualifiedProduct(run);
	const qualifiedAt = instant(qualified?.qualifiedAt);
	const baseline = !!run.goal && !!qualified && qualified.commit === qualified.target && !Object.keys(qualified.outputs).length;
	let boundAt = null;
	for (const w of writers) {
		if (w.boundAt === null) { boundAt = null; break; }
		if (boundAt === null || w.boundAt < boundAt) boundAt = w.boundAt;
	}
	const unconfirmed = creates.some(e => e.state === "issued" || e.state === "uncertain");
	return {
		run: run.id, activatedAt,
		firstWriter: {
			state: writers.length ? "bound" : unconfirmed ? "unconfirmed" : baseline ? "not-applicable" : "not-bound",
			boundAt, elapsedMs: elapsed(activatedAt, boundAt),
			nativeIds: boundAt === null ? [] : [...new Set(writers.filter(w => w.boundAt === boundAt).map(w => w.nativeId))],
		},
		qualified: { commit: qualified?.commit ?? null, qualifiedAt, elapsedMs: elapsed(activatedAt, qualifiedAt), baseline },
		history: { owner: run.owner, writers, hasUnconfirmedWriters: unconfirmed, workflowIds: [...new Set(run.effects.flatMap(e =>
			e.kind === "scout" && e.tool === "workflow" && e.workflowId ? [e.workflowId] : []))] },
	};
}

/** @param {string} s */
function literal(s) {
	if (typeof s !== "string" || s.includes("\0")) throw new Error("Invalid receipt identity");
	return `'${s.replaceAll("'", "''")}'`;
}

/** A single bounded native session_store_sql read, never a connection to a ledger, service or history store.
 * @param {ReturnType<typeof metricsFacts>} facts @param {number} [asOf] */
export function usageQuery(facts, asOf) {
	// Shared owner turns, separately hosted agents and unsurfaced calls aren't accounted for by this query.
	const unmeasured = { ownerUsage: null, separateHelperUsage: null, separateWorkflowUsage: null, totalRunUsage: null };
	const start = instant(facts.activatedAt), end = instant(facts.qualified.commit === null ? asOf : facts.qualified.qualifiedAt);
	if (start === null || end === null || end < start)
		return { ...unmeasured, query: null, reason: "Unknown usage window: need activation and exact qualification time, or an explicit as-of for unfinished work." };
	const { writers, owner } = facts.history;
	if (!writers.length) return { ...unmeasured, query: null, reason: "No bound writer to attribute; this is not zero run usage." };
	const bindings = writers.map(w => `(${literal(w.nativeId)}, ${instant(w.boundAt) ?? "NULL"}, ${w.kickoffHash ? literal(w.kickoffHash) : "CAST(NULL AS VARCHAR)"})`);
	const scope = `BETWEEN epoch_ms(CAST(${start} AS BIGINT)) AND epoch_ms(CAST(${end} AS BIGINT))`;
	// The first unrecognized input closes attribution. Never restart it from a queued repair or a timestamp.
	const query = `WITH bindings(native_id, bound_ms, kickoff_hash) AS (VALUES ${bindings.join(", ")}),
links AS (
  SELECT b.*, s.id, s.created_at, COUNT(*) OVER (PARTITION BY b.native_id) AS histories, COUNT(*) OVER (PARTITION BY s.id) AS writers
  FROM bindings b LEFT JOIN sessions s ON (s.id=b.native_id OR s.task_id=b.native_id)
    AND s.created_at ${scope} AND s.id<>${literal(owner)} AND COALESCE(s.task_id,'')<>${literal(owner)}
    AND (b.bound_ms IS NULL OR s.created_at <= epoch_ms(CAST(b.bound_ms AS BIGINT)))
), mapped AS (
  SELECT DISTINCT native_id, bound_ms, kickoff_hash,
    CASE WHEN histories=1 AND writers=1 THEN id END AS history_id,
    CASE WHEN histories=1 AND writers=1 THEN created_at END AS created_at FROM links
), trace AS (
  SELECT e.session_id, e.timestamp, e.type, e.usage_model, e.usage_input_tokens, e.usage_output_tokens,
    CASE WHEN e.type='user.message' THEN sha256(COALESCE(e.user_content,'')) END AS message_hash
  FROM events e WHERE e.timestamp ${scope} AND e.session_id IN (SELECT history_id FROM mapped)
    AND e.type IN ('user.message','system.notification','session.resume','assistant.usage')
), bounds AS (
  SELECT m.native_id, m.history_id, m.bound_ms,
    MIN(CASE WHEN t.message_hash=m.kickoff_hash AND t.timestamp>=m.created_at THEN t.timestamp END) AS kickoff,
    MIN(CASE WHEN t.type IN ('system.notification','session.resume') OR t.message_hash<>m.kickoff_hash THEN t.timestamp END) AS stop_at
  FROM mapped m LEFT JOIN trace t ON t.session_id=m.history_id AND t.type<>'assistant.usage'
  GROUP BY m.native_id, m.history_id, m.bound_ms
), report AS (
SELECT b.native_id, b.history_id, u.usage_model,
  CASE WHEN b.history_id IS NULL THEN 'unmapped or ambiguous identity'
    WHEN b.bound_ms IS NULL OR b.bound_ms < ${start} THEN 'unknown binding time'
    WHEN b.kickoff IS NULL THEN 'no verified kickoff in history'
    WHEN COUNT(u.type)=0 THEN 'no attributable usage observed'
    ELSE 'observed writer-session usage only' END AS coverage,
  CASE WHEN b.bound_ms>=${start} AND (b.stop_at IS NULL OR b.kickoff<b.stop_at)
    THEN epoch_ms(b.kickoff)-${start} END AS hosted_kickoff_elapsed_ms,
  NULLIF(COUNT(u.type),0) AS usage_records,
  CASE WHEN COUNT(u.usage_input_tokens)=COUNT(u.type) THEN SUM(u.usage_input_tokens) END AS input_tokens,
  CASE WHEN COUNT(u.usage_output_tokens)=COUNT(u.type) THEN SUM(u.usage_output_tokens) END AS output_tokens,
  COUNT(*) OVER () AS result_rows
FROM bounds b LEFT JOIN trace u ON u.session_id=b.history_id AND u.type='assistant.usage'
  AND b.bound_ms>=${start} AND u.timestamp>=epoch_ms(CAST(b.bound_ms AS BIGINT))
  AND u.timestamp>b.kickoff AND (b.stop_at IS NULL OR u.timestamp<b.stop_at)
GROUP BY b.native_id, b.history_id, b.bound_ms, b.kickoff, b.stop_at, u.usage_model
)
SELECT report.*, CASE WHEN ${facts.history.hasUnconfirmedWriters === false ? "TRUE" : "FALSE"}
  AND COUNT(hosted_kickoff_elapsed_ms) OVER ()=result_rows THEN MIN(hosted_kickoff_elapsed_ms) OVER () END AS first_hosted_kickoff_elapsed_ms
FROM report WHERE result_rows<=10000
UNION ALL
SELECT NULL, NULL, NULL, 'history result limit; measurements unknown', NULL, NULL, NULL, NULL, MAX(result_rows), NULL
FROM report HAVING MAX(result_rows)>10000
ORDER BY native_id, usage_model`;
	return { ...unmeasured, from: start, through: end, unfinished: facts.qualified.commit === null, query };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const { metrics, asOf } = JSON.parse(readFileSync(0, "utf8"));
		console.log(JSON.stringify(usageQuery(metrics, asOf)));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
