/**
 * @module progress
 *
 * Structured progress for workflow runs: JSONL events, live state snapshots, and terminal narration.
 *
 * @typedef {"queued"|"running"|"done"|"cached"|"skipped"|"error"} AgentStatus
 * @typedef {"running"|"complete"|"failed"|"error"|"timeout"} RunStatus
 */
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

const CTRL = /[\u0000-\u001f\u007f-\u009f]/g;
const MAX_BUFFERED_EVENTS = 32;
const MAX_ERRORS = 20;
const MAX_RECENT = 8;
const DASHBOARD_INTERVAL_MS = 1500;
const FLUSH_INTERVAL_MS = 150;
const STATE_WRITE_INTERVAL_MS = 150;
/** Strip control chars. @param {unknown} s */
const san = (s) => String(s ?? "").replace(CTRL, " ");
/** AIC from a raw nanoAiu field. @param {unknown} nano */
const aic = (nano) => Number(nano || 0) / 1_000_000_000;

/** Small buffered JSONL appender for progress events. */
class BufferedJsonl {
	#path;
	/** @type {string[]} */
	#buffer = [];
	/** @type {ReturnType<typeof setTimeout>|null} */
	#timer = null;

	/** @param {string|null|undefined} path */
	constructor(path) {
		this.#path = path || null;
		if (this.#path) mkdirSync(dirname(this.#path), { recursive: true });
	}

	/** @param {any} rec */
	write(rec) {
		if (!this.#path) return;
		this.#buffer.push(JSON.stringify(rec) + "\n");
		if (this.#buffer.length >= MAX_BUFFERED_EVENTS) this.flush();
		else this.#schedule();
	}

	#schedule() {
		if (this.#timer) return;
		this.#timer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
		this.#timer.unref?.();
	}

	flush() {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = null;
		}
		if (!this.#path || !this.#buffer.length) return;
		const body = this.#buffer.join("");
		this.#buffer.length = 0;
		try {
			appendFileSync(this.#path, body, "utf8");
		} catch {
			// Progress files are diagnostic; workflow execution must continue if they cannot be written.
		}
	}

	close() {
		this.flush();
	}
}

/** Minimal, persistence-focused progress reporter. */
export class ProgressReporter {
	#statePath;
	#onLine;
	#dashboard;
	#dashboardIntervalMs;
	#lastDashboard = 0;
	#seq = 0;
	#lastStateWrite = 0;
	/** @type {ReturnType<typeof setTimeout>|null} */
	#stateTimer = null;
	#jsonl;
	/** @type {Map<number, any>} */
	#running = new Map();
	/** @type {any[]} */
	#recent = [];
	/** @type {Map<number, any>} */
	#groups = new Map();
	#state;

	/**
	 * @param {{ jsonlPath?: string|null, statePath?: string|null, runId: string, meta?: object,
	 *   title?: string, onLine?: (line: string, level?: "info"|"warning"|"error", meta?: { ephemeral?: boolean }) => void, write?: boolean,
	 *   dashboard?: boolean, dashboardIntervalMs?: number }} config
	 */
	constructor({ jsonlPath = null, statePath = null, runId, meta = {}, title, onLine = () => {}, write = true, dashboard = false, dashboardIntervalMs = DASHBOARD_INTERVAL_MS }) {
		this.#jsonl = new BufferedJsonl(write ? jsonlPath : null);
		this.#statePath = write ? statePath : null;
		this.#onLine = onLine;
		this.#dashboard = dashboard;
		this.#dashboardIntervalMs = dashboardIntervalMs;
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
	}

	/**
	 * Record one progress event (adds `seq` + `t`). Recognized `ev`: `run_start`, `start`, `end`,
	 * `group_start`, `group_end`, `run_end`. Persists to `progress.jsonl` and updates the snapshot.
	 * @param {any} event
	 */
	emit(event) {
		const rec = { seq: ++this.#seq, t: Date.now(), ...event };
		this.#jsonl.write(rec);
		this.#apply(rec);
		this.#narrate(rec);
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
				this.#applyGroupStart(rec);
				break;
			case "group_end":
				this.#groups.delete(rec.gid);
				break;
			case "end":
				this.#applyEnd(rec);
				break;
		}
		s.updatedAt = new Date().toISOString();
		this.#syncState(rec.ev === "run_end" || rec.ev === "run_start");
	}

	/** @param {any} rec */
	#applyGroupStart(rec) {
		this.#groups.set(rec.gid, { gid: rec.gid, kind: san(rec.kind), phase: rec.phase ? san(rec.phase) : null, n: rec.n });
	}

	/** @param {any} rec */
	#applyEnd(rec) {
		const s = this.#state;
		this.#running.delete(rec.seq);
		s.nanoAiu += Number(rec.nanoAiu || 0);
		s.aic = aic(s.nanoAiu);
		s.outputTokens += Number(rec.outputTokens || 0);

		if (rec.skipped) s.counts.skipped++;
		else if (rec.cached) s.counts.cached++;
		else if (rec.ok) s.counts.done++;
		else this.#recordError(rec);

		if (!rec.cached && !rec.skipped) s.counts.launched++;
		this.#recent.push(rec);
		if (this.#recent.length > MAX_RECENT) this.#recent.shift();
		if (rec.phase) s.phase = san(rec.phase);
	}

	/** @param {any} rec */
	#recordError(rec) {
		const { errors, counts } = this.#state;
		counts.failed++;
		errors.push({ label: san(rec.label), error: san(rec.error) });
		if (errors.length > MAX_ERRORS) errors.splice(0, errors.length - MAX_ERRORS);
	}

	/** @param {any} rec */
	#narrate(rec) {
		if (this.#dashboard) {
			if (rec.ev === "end" && (!rec.ok || rec.skipped) && !rec.cached) this.#onLine(formatEnd(rec), endLevel(rec), { ephemeral: false });
			this.#maybeDashboard(rec.ev === "run_start" || rec.ev === "group_start" || rec.ev === "group_end");
			return;
		}
		if (rec.ev === "end") {
			const level = endLevel(rec);
			this.#onLine(formatEnd(rec), level, { ephemeral: level === "info" });
		} else if (rec.ev === "group_start") {
			this.#onLine(`  ${san(rec.kind)} launched (${rec.n})`, "info", { ephemeral: true });
		} else if (rec.ev === "group_end") {
			this.#onLine(`  ${san(rec.kind)} settled (${rec.n})`, "info", { ephemeral: true });
		}
	}

	/** Write state.json now (`force`) or debounced (~150ms). @param {boolean} force */
	#syncState(force) {
		if (!this.#statePath) return;
		const now = Date.now();
		const elapsed = now - this.#lastStateWrite;
		if (!force && elapsed < STATE_WRITE_INTERVAL_MS) {
			if (!this.#stateTimer) {
				this.#stateTimer = setTimeout(() => {
					this.#stateTimer = null;
					this.#writeState();
				}, STATE_WRITE_INTERVAL_MS - elapsed);
				this.#stateTimer.unref?.();
			}
			return;
		}
		this.#cancelStateTimer();
		if (force) this.#jsonl.flush();
		this.#writeState();
	}

	#cancelStateTimer() {
		if (!this.#stateTimer) return;
		clearTimeout(this.#stateTimer);
		this.#stateTimer = null;
	}

	#writeState() {
		if (!this.#statePath) return;
		this.#lastStateWrite = Date.now();
		Object.assign(this.#state, this.#derived());
		try {
			writeFileSync(this.#statePath, JSON.stringify(this.#state), "utf8");
		} catch {
			// Progress files are diagnostic; workflow execution must continue if they cannot be written.
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

	/** @param {boolean} force */
	#maybeDashboard(force = false) {
		if (!this.#dashboard) return;
		const now = Date.now();
		if (!force && now - this.#lastDashboard < this.#dashboardIntervalMs) return;
		this.#lastDashboard = now;
		this.#onLine(formatDashboard(this.snapshot()), "info", { ephemeral: true });
	}

	/** Finalize the run: set status, flush state.json. @param {RunStatus} status */
	close(status) {
		this.#state.status = status;
		this.#jsonl.close();
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

/** One-line narration for a finished agent. @param {any} rec */
function formatEnd(rec) {
	const label = san(rec.label || "agent").slice(0, 32);
	const cost = aic(rec.nanoAiu).toFixed(4);
	if (rec.cached) return `  HIT  ${label}  ${cost} AIC  (cached)`;
	if (rec.skipped) return `  SKIP ${label}  (${san(rec.error || "skipped")})`;
	if (rec.ok) return `  OK   ${label}  ${cost} AIC  ${Number(rec.outputTokens || 0)} tok  [${san(rec.model || "")}]`;
	return `  ERR  ${label}  ${cost} AIC  ERROR: ${san(rec.error || "?")}`;
}

/** @param {any} s */
export function formatDashboard(s) {
	const c = s.counts || {};
	const running = s.running || [];
	const recent = s.recent || [];
	const errors = s.errors || [];
	const total = Number(c.launched || 0) + Number(c.cached || 0) + Number(c.skipped || 0) + running.length;
	const terminal = ["complete", "failed", "error", "timeout"].includes(s.status || "");
	const endMs = terminal && s.updatedAt ? Date.parse(s.updatedAt) : Date.now();
	const elapsed = ((endMs - Date.parse(s.startedAt || new Date().toISOString())) / 1000).toFixed(0);
	const lines = [
		`┌─ workflow: ${clip(s.title || s.runId, 36)} · ${s.status || "running"} · ${Number(s.aic || 0).toFixed(1)} AIC · ${elapsed}s`,
		`│ phase: ${clip(s.phase || "—", 48)}`,
		`│ agents: ${total} total · ${c.done || 0} done · ${running.length} running · ${c.cached || 0} cached · ${c.skipped || 0} skipped · ${c.failed || 0} failed`,
	];
	if (running.length) {
		lines.push("├─ running");
		for (const r of running.slice(0, 4)) lines.push(`│  • ${clip(r.label || "agent", 24).padEnd(24)} ${clip(r.model || "", 18).padEnd(18)} ${clip(r.phase || "", 16)}`);
		if (running.length > 4) lines.push(`│  • … ${running.length - 4} more`);
	}
	if (recent.length) {
		lines.push("├─ recent");
		for (const r of recent.slice(-4)) {
			const icon = r.status === "done" ? "✓" : r.status === "error" ? "✗" : r.status === "cached" ? "↻" : "!";
			lines.push(`│  ${icon} ${clip(r.label || "agent", 28).padEnd(28)} ${Number(r.aic || 0).toFixed(3)} AIC`);
		}
	}
	if (errors.length) {
		lines.push("├─ errors");
		for (const e of errors.slice(-3)) lines.push(`│  ✗ ${clip(e.label || "agent", 20)}: ${clip(e.error || "error", 48)}`);
	}
	lines.push(`└─ inspect: /wf ${s.runId || ""}`);
	return lines.join("\n");
}

/** @param {unknown} s @param {number} n */
function clip(s, n) {
	const text = san(s);
	return text.length > n ? text.slice(0, Math.max(0, n - 1)) + "…" : text;
}
