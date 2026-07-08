/**
 * @module progress
 *
 * Structured progress for a run: appends normalized events to `progress.jsonl` (each with a
 * monotonic `seq` for deterministic replay), maintains a live `state.json` snapshot (debounced,
 * always flushed on completion), and exposes a rolled-up summary. Subagent-supplied fields
 * (labels, models, errors) are sanitized so control characters cannot corrupt terminal output.
 * Rich TUI rendering (pipeline grids, run trees) is deferred to a later phase.
 *
 * @typedef {"queued"|"running"|"done"|"cached"|"skipped"|"error"} AgentStatus
 * @typedef {"running"|"complete"|"failed"|"error"|"timeout"} RunStatus
 */
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

const CTRL = /[\u0000-\u001f\u007f-\u009f]/g;
/** Strip control chars. @param {unknown} s */
const san = (s) => String(s ?? "").replace(CTRL, " ");
/** AIC from a raw nanoAiu field. @param {unknown} nano */
const aic = (nano) => Number(nano || 0) / 1_000_000_000;

/** Minimal, persistence-focused progress reporter. */
export class ProgressReporter {
	#jsonlPath;
	#statePath;
	#onLine;
	#seq = 0;
	#lastStateWrite = 0;
	/** @type {Map<number, any>} */
	#running = new Map();
	/** @type {any[]} */
	#recent = [];
	/** @type {Map<number, any>} */
	#groups = new Map();
	#state;

	/**
	 * @param {{ jsonlPath?: string|null, statePath?: string|null, runId: string, meta?: object,
	 *   title?: string, onLine?: (line: string, level?: "info"|"warning"|"error") => void, write?: boolean }} config
	 */
	constructor({ jsonlPath = null, statePath = null, runId, meta = {}, title, onLine = () => {}, write = true }) {
		this.#jsonlPath = write ? jsonlPath : null;
		this.#statePath = write ? statePath : null;
		this.#onLine = onLine;
		const now = new Date().toISOString();
		this.#state = {
			runId,
			title: title || runId,
			meta,
			status: /** @type {RunStatus} */ ("running"),
			startedAt: now,
			updatedAt: now,
			phase: /** @type {string|null} */ (null),
			counts: { launched: 0, done: 0, failed: 0, cached: 0, skipped: 0 },
			nanoAiu: 0,
			aic: 0,
			outputTokens: 0,
			running: /** @type {any[]} */ ([]),
			groups: /** @type {any[]} */ ([]),
			recent: /** @type {any[]} */ ([]),
			errors: /** @type {any[]} */ ([]),
		};
		if (this.#jsonlPath) mkdirSync(dirname(this.#jsonlPath), { recursive: true });
	}

	/**
	 * Record one progress event (adds `seq` + `t`). Recognized `ev`: `run_start`, `start`, `end`,
	 * `group_start`, `group_end`, `run_end`. Persists to `progress.jsonl` and updates the snapshot.
	 * @param {any} event
	 */
	emit(event) {
		const rec = { seq: ++this.#seq, t: Date.now(), ...event };
		if (this.#jsonlPath) {
			try {
				appendFileSync(this.#jsonlPath, JSON.stringify(rec) + "\n", "utf8");
			} catch {
				// best-effort persistence
			}
		}
		this.#apply(rec);
		if (rec.ev === "end") this.#onLine(formatEnd(rec), endLevel(rec));
		else if (rec.ev === "group_start") this.#onLine(`  ${san(rec.kind)} launched (${rec.n})`);
		else if (rec.ev === "group_end") this.#onLine(`  ${san(rec.kind)} settled (${rec.n})`);
		return rec;
	}

	/** @param {any} rec */
	#apply(rec) {
		const s = this.#state;
		switch (rec.ev) {
			case "start":
				this.#running.set(rec.seq, rec);
				if (rec.phase) s.phase = san(rec.phase);
				break;
			case "group_start":
				this.#groups.set(rec.gid, { gid: rec.gid, kind: san(rec.kind), phase: rec.phase ? san(rec.phase) : null, n: rec.n });
				break;
			case "group_end":
				this.#groups.delete(rec.gid);
				break;
			case "end": {
				this.#running.delete(rec.seq);
				s.nanoAiu += Number(rec.nanoAiu || 0);
				s.aic = aic(s.nanoAiu);
				s.outputTokens += Number(rec.outputTokens || 0);
				if (rec.skipped) s.counts.skipped++;
				else if (rec.cached) s.counts.cached++;
				else if (rec.ok) s.counts.done++;
				else {
					s.counts.failed++;
					s.errors.push({ label: san(rec.label), error: san(rec.error) });
				}
				if (!rec.cached && !rec.skipped) s.counts.launched++;
				this.#recent.push(rec);
				if (this.#recent.length > 8) this.#recent.shift();
				if (rec.phase) s.phase = san(rec.phase);
				break;
			}
		}
		s.updatedAt = new Date().toISOString();
		this.#syncState(rec.ev === "run_end" || rec.ev === "run_start");
	}

	/** Write state.json now (`force`) or debounced (~150ms). @param {boolean} force */
	#syncState(force) {
		if (!this.#statePath) return;
		const now = Date.now();
		if (!force && now - this.#lastStateWrite < 150) return;
		this.#lastStateWrite = now;
		Object.assign(this.#state, this.#derived());
		try {
			writeFileSync(this.#statePath, JSON.stringify(this.#state, null, 2), "utf8");
		} catch {
			// best-effort
		}
	}

	/** Live-derived view fields (running/groups/recent). */
	#derived() {
		return {
			running: [...this.#running.values()].map((r) => ({ seq: r.seq, label: san(r.label), model: san(r.model), phase: r.phase ? san(r.phase) : null })),
			groups: [...this.#groups.values()],
			recent: this.#recent.map(formatRecent),
		};
	}

	/** Finalize the run: set status, flush state.json. @param {RunStatus} status */
	close(status) {
		this.#state.status = status;
		this.#syncState(true);
	}

	/** Defensive copy of the live snapshot (derived fields always current). */
	snapshot() {
		return { ...structuredClone(this.#state), ...this.#derived() };
	}

	/** A workflow-style one-line run summary. */
	runSummary() {
		const { counts: c, aic: total, startedAt } = this.#state;
		const agents = c.launched + c.cached + c.skipped;
		const secs = ((Date.now() - Date.parse(startedAt)) / 1000).toFixed(1);
		return `— workflow: ${agents} agents (${c.cached} cached, ${c.skipped} skipped, ${c.failed} failed), ${total.toFixed(1)} AIC, ${secs}s`;
	}
}

/** @param {any} r */
const formatRecent = (r) => ({
	label: san(r.label),
	status: r.skipped ? "skipped" : r.cached ? "cached" : r.ok ? "done" : "error",
	aic: aic(r.nanoAiu),
	error: r.error ? san(r.error) : null,
});

/** Log level for a finished-agent line: failures error, skips warning, else info. @param {any} rec */
const endLevel = (rec) => (!rec.ok && !rec.cached && !rec.skipped ? "error" : rec.skipped ? "warning" : "info");

/** One-line narration for a finished agent (Python format_agent_line parity). @param {any} rec */
function formatEnd(rec) {
	const label = san(rec.label || "agent").slice(0, 32);
	const cost = aic(rec.nanoAiu).toFixed(4);
	if (rec.cached) return `  HIT  ${label}  ${cost} AIC  (cached)`;
	if (rec.skipped) return `  SKIP ${label}  (${san(rec.error || "skipped")})`;
	if (rec.ok) return `  OK   ${label}  ${cost} AIC  ${Number(rec.outputTokens || 0)} tok  [${san(rec.model || "")}]`;
	return `  ERR  ${label}  ${cost} AIC  ERROR: ${san(rec.error || "?")}`;
}
