/**
 * @module progress
 *
 * Structured progress for conveyor runs: JSONL events, live state snapshots, and terminal narration.
 *
 * @typedef {"queued"|"running"|"done"|"cached"|"skipped"|"error"} AgentStatus
 * @typedef {"preview"|"queued"|"running"|"pausing"|"paused"|"resuming"|"cancelling"|"cancelled"|"complete"|"partial"|"failed"|"error"|"timeout"|"interrupted"} RunStatus
 */
import { PROCESS_INSTANCE_ID } from "./persistence.mjs";
import { isTerminalStatus } from "./schema.mjs";

const CTRL = /[\u0000-\u001f\u007f-\u009f]/g;
const MAX_ERRORS = 20;
const MAX_RECENT = 8;
const DASHBOARD_INTERVAL_MS = 1500;
const STATE_WRITE_INTERVAL_MS = 150;
export { PROCESS_INSTANCE_ID };
/** Strip control chars. @param {unknown} s */
const san = (s) => String(s ?? "").replace(CTRL, " ");
/** AIC from a raw nanoAiu field. @param {unknown} nano */
const aic = (nano) => Number(nano || 0) / 1_000_000_000;

/** Minimal, persistence-focused progress reporter. */
export class ProgressReporter {
	/** @type {((state: any) => void)|null} */
	#writeState;
	#onLine;
	#dashboard;
	#dashboardIntervalMs;
	#lastDashboard = 0;
	#seq = 0;
	#lastStateWrite = 0;
	/** @type {ReturnType<typeof setTimeout>|null} */
	#stateTimer = null;
	/** @type {Map<number, any>} */
	#running = new Map();
	/** @type {any[]} */
	#recent = [];
	/** @type {Map<number, any>} */
	#groups = new Map();
	/** @type {Map<string, any>} */
	#phases = new Map();
	/** @type {Map<string, { phaseId: string, startedAt: number }>} */
	#phaseInvocations = new Map();
	#state;

	/**
	 * @param {{ runId: string, meta?: object,
	 *   title?: string, onLine?: (line: string, level?: "info"|"warning"|"error", meta?: { ephemeral?: boolean }) => void, write?: boolean,
	 *   dashboard?: boolean, dashboardIntervalMs?: number,
	 *   ownerGeneration?: number|null, writeState?: ((state: any) => void)|null }} config
	 */
	constructor({
		runId,
		meta = {},
		title,
		onLine = () => {},
		write = true,
		dashboard = false,
		dashboardIntervalMs = DASHBOARD_INTERVAL_MS,
		ownerGeneration = null,
		writeState = null,
	}) {
		this.#writeState = write ? writeState : null;
		this.#onLine = onLine;
		this.#dashboard = dashboard;
		this.#dashboardIntervalMs = dashboardIntervalMs;
		const now = new Date().toISOString();
		this.#state = {
			runId,
			title: title || runId,
			meta,
			ownerPid: process.pid,
			ownerInstanceId: PROCESS_INSTANCE_ID,
			ownerGeneration,
			status: /** @type {RunStatus} */ ("running"),
			startedAt: now,
			updatedAt: now,
			phase: /** @type {string|null} */ (null),
			counts: { launched: 0, done: 0, failed: 0, cached: 0, skipped: 0, dropped: 0, unknownUsage: 0 },
			nanoAiu: 0,
			aic: 0,
			errors: /** @type {any[]} */ ([]),
			revision: 0,
		};
		for (const [ordinal, raw] of (Array.isArray(meta.phases) ? meta.phases : []).entries()) {
			const phase = typeof raw === "string" ? { id: `phase:${ordinal}`, ordinal, title: raw } : raw;
			if (!phase?.title) continue;
			this.#phases.set(phase.id, {
				id: phase.id,
				ordinal: phase.ordinal ?? ordinal,
				title: san(phase.title),
				detail: phase.detail ? san(phase.detail) : undefined,
				status: "pending",
				entryCount: 0,
				accumulatedActiveMs: 0,
				totalAgentCount: 0,
				liveAgentCount: 0,
			});
		}
	}

	/**
	 * Record one progress event (adds `seq` + `t`). Recognized `ev`: `run_start`, `start`, `end`,
	 * `group_start`, `group_end`, `run_end`. Updates the live state snapshot.
	 * @param {any} event
	 */
	emit(event) {
		const agentSeq = event.agentSeq;
		const requestedSeq = Number(event.progressSeq);
		const seq = Number.isSafeInteger(requestedSeq) && requestedSeq > 0 ? requestedSeq : this.#seq + 1;
		this.#seq = Math.max(this.#seq, seq);
		const rec = { t: Date.now(), ...event, seq };
		if (event.ev === "start" || event.ev === "end") rec.agentSeq = agentSeq;
		this.#apply(rec);
		this.#narrate(rec);
		return rec;
	}

	/** @param {any} rec */
	#apply(rec) {
		const s = this.#state;
		switch (rec.ev) {
			case "start":
				this.#running.set(rec.agentSeq, rec);
				if (rec.phase) s.phase = san(rec.phase);
				{
					const phase = [...this.#phases.values()].find((item) => item.title === san(rec.phase));
					if (phase) phase.liveAgentCount++;
				}
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
			case "drop":
				this.#applyDrop(rec);
				break;
			case "phase_enter":
				this.#applyPhaseEnter(rec);
				break;
			case "phase_exit":
				this.#applyPhaseExit(rec);
				break;
		}
		s.revision = Math.max(Number(s.revision) || 0, Number(rec.revision) || 0);
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
		this.#running.delete(rec.agentSeq);
		s.nanoAiu += Number(rec.nanoAiu || 0);
		s.aic = aic(s.nanoAiu);

		if (rec.skipped) s.counts.skipped++;
		else if (rec.cached) s.counts.cached++;
		else if (rec.ok) s.counts.done++;
		else this.#recordError(rec);
		if (rec.usageUnknown) s.counts.unknownUsage++;

		if (!rec.cached && !rec.skipped) s.counts.launched++;
		this.#recent.push(rec);
		if (this.#recent.length > MAX_RECENT) this.#recent.shift();
		if (rec.phase) s.phase = san(rec.phase);
		const phase = [...this.#phases.values()].find((item) => item.title === san(rec.phase));
		if (phase) {
			phase.totalAgentCount++;
			phase.liveAgentCount = Math.max(0, phase.liveAgentCount - 1);
		}
	}

	/** @param {any} rec */
	#applyPhaseEnter(rec) {
		let phase = this.#phases.get(rec.phaseId);
		if (!phase) {
			phase = {
				id: rec.phaseId,
				ordinal: rec.ordinal ?? null,
				title: san(rec.phase),
				detail: rec.detail ? san(rec.detail) : undefined,
				status: "pending",
				entryCount: 0,
				accumulatedActiveMs: 0,
				totalAgentCount: 0,
				liveAgentCount: 0,
			};
			this.#phases.set(rec.phaseId, phase);
		}
		phase.status = "active";
		phase.entryCount++;
		phase.startedAt ??= rec.t;
		this.#phaseInvocations.set(rec.invocationId, { phaseId: rec.phaseId, startedAt: rec.t });
		this.#state.phase = phase.title;
	}

	/** @param {any} rec */
	#applyPhaseExit(rec) {
		const invocation = this.#phaseInvocations.get(rec.invocationId);
		const phase = this.#phases.get(rec.phaseId);
		if (!phase || !invocation) return;
		this.#phaseInvocations.delete(rec.invocationId);
		phase.accumulatedActiveMs += Math.max(0, Number(rec.durationMs) || rec.t - invocation.startedAt);
		if (![...this.#phaseInvocations.values()].some((item) => item.phaseId === rec.phaseId)) {
			phase.status = "completed";
			phase.completedAt = rec.t;
		}
	}

	/** @param {any} rec */
	#recordError(rec) {
		const { errors, counts } = this.#state;
		counts.failed++;
		errors.push({ label: san(rec.label), error: san(rec.error) });
		if (errors.length > MAX_ERRORS) errors.splice(0, errors.length - MAX_ERRORS);
	}

	/** @param {any} rec */
	#applyDrop(rec) {
		const { errors, counts } = this.#state;
		counts.dropped++;
		errors.push({ label: `${san(rec.kind || "group")}[${Number(rec.index) || 0}]`, error: san(rec.error || "dropped") });
		if (errors.length > MAX_ERRORS) errors.splice(0, errors.length - MAX_ERRORS);
	}

	/** @param {any} rec */
	#narrate(rec) {
		if (this.#dashboard) {
			if (rec.ev === "end" && (!rec.ok || rec.skipped) && !rec.cached) this.#onLine(formatEnd(rec), endLevel(rec), { ephemeral: false });
			if (rec.ev === "drop") this.#onLine(formatDrop(rec), "warning", { ephemeral: false });
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
		} else if (rec.ev === "drop") {
			this.#onLine(formatDrop(rec), "warning", { ephemeral: false });
		}
	}

	/** Write state.json now (`force`) or debounced (~150ms). @param {boolean} force */
	#syncState(force) {
		if (!this.#writeState) return;
		const now = Date.now();
		const elapsed = now - this.#lastStateWrite;
		if (!force && elapsed < STATE_WRITE_INTERVAL_MS) {
			if (!this.#stateTimer) {
				this.#stateTimer = setTimeout(() => {
					this.#stateTimer = null;
					this.#persistState();
				}, STATE_WRITE_INTERVAL_MS - elapsed);
				this.#stateTimer.unref?.();
			}
			return;
		}
		if (this.#stateTimer) {
			clearTimeout(this.#stateTimer);
			this.#stateTimer = null;
		}
		this.#persistState();
	}

	#persistState() {
		if (!this.#writeState) return;
		this.#lastStateWrite = Date.now();
		Object.assign(this.#state, this.#derived());
		try {
			this.#writeState(this.#state);
		} catch {
			// Progress files are diagnostic; conveyor execution must continue if they cannot be written.
		}
	}

	/** Live-derived view fields (running/groups/recent). */
	#derived() {
		return {
			running: [...this.#running.values()].map((r) => ({
				seq: r.agentSeq,
				label: san(r.label),
				model: san(r.model),
				phase: r.phase ? san(r.phase) : null,
				branchPath: r.branchPath ? san(r.branchPath) : "/",
			})),
			groups: [...this.#groups.values()],
			recent: this.#recent.map(formatRecent),
			phases: [...this.#phases.values()].map((phase) => ({ ...phase })),
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
		const now = new Date().toISOString();
		this.#state.status = status;
		this.#state.updatedAt = now;
		for (const phase of this.#phases.values()) {
			if (phase.status === "pending") phase.status = "skipped";
			else if (phase.status === "active") {
				phase.status = "completed";
				phase.completedAt = Date.now();
			}
		}
		this.#syncState(true);
	}

	/** Defensive copy of the live snapshot (derived fields always current). */
	snapshot() {
		return { ...structuredClone(this.#state), ...this.#derived() };
	}

	/** A conveyor-style one-line run summary. */
	runSummary() {
		const { counts: c, aic: total, startedAt } = this.#state;
		const agents = c.launched + c.cached + c.skipped;
		const secs = ((Date.now() - Date.parse(startedAt)) / 1000).toFixed(1);
		return `— conveyor: ${agents} agents (${c.cached} cached, ${c.skipped} skipped, ${c.failed} failed, ${c.dropped} dropped), ${total.toFixed(1)} AIC, ${secs}s`;
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

/** One-line narration for a dropped group item. @param {any} rec */
function formatDrop(rec) {
	return `  DROP ${san(rec.kind || "group")}[${Number(rec.index) || 0}]  (${san(rec.error || "dropped")})`;
}

/** @param {any} s */
export function formatDashboard(s) {
	const c = s.counts || {};
	const running = s.running || [];
	const recent = s.recent || [];
	const errors = s.errors || [];
	const total = Number(c.launched || 0) + Number(c.cached || 0) + Number(c.skipped || 0) + running.length;
	const terminal = isTerminalStatus(s.status);
	const endMs = terminal && s.updatedAt ? Date.parse(s.updatedAt) : Date.now();
	const elapsed = ((endMs - Date.parse(s.startedAt || new Date().toISOString())) / 1000).toFixed(0);
	const lines = [
		`┌─ conveyor: ${clip(s.title || s.runId, 36)} · ${s.status || "running"} · ${Number(s.aic || 0).toFixed(1)} AIC · ${elapsed}s`,
		`│ phase: ${clip(s.phase || "—", 48)}`,
		`│ agents: ${total} total · ${c.done || 0} done · ${running.length} running · ${c.cached || 0} cached · ${c.skipped || 0} skipped · ${c.failed || 0} failed · ${c.dropped || 0} dropped`,
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
	lines.push(`└─ inspect: /conveyor ${s.runId || ""}`);
	return lines.join("\n");
}

/** @param {unknown} s @param {number} n */
function clip(s, n) {
	const text = san(s);
	return text.length > n ? text.slice(0, Math.max(0, n - 1)) + "…" : text;
}
