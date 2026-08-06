/** @module ledger — append-only attempts, resource accounting, approvals, and revisions. */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readSync, statSync, truncateSync, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import { approveLimits } from "./schema.mjs";
import { LockedError, LostLeaseError } from "./persistence.mjs";

const PROGRESS_BUFFER_SIZE = 32;
const PROGRESS_FLUSH_MS = 150;

export class Ledger {
	#path;
	#lease;
	#readOnly;
	#mode;
	#recordTypes;
	#revision = 0;
	#activeMs = 0;
	#spawnedAgents = 0;
	#nanoAiu = 0;
	#unknownUsage = 0;
	#approvedLimits = {};
	#budgetIncreaseDeclined = false;
	#interruptedRevision = 0;
	/** @type {any[]} */
	#records = [];
	/** @type {any[]} */
	#progressBuffer = [];
	/** @type {ReturnType<typeof setTimeout>|null} */
	#progressTimer = null;
	/** @type {Error|null} */
	#progressFatal = null;
	/** @type {Error|null} */
	#progressWarning = null;
	#progressSeq = 0;
	/** @type {Map<string, unknown>} */
	#cache = new Map();
	/** @type {Map<string, number>} */
	#invalidationEpochs = new Map();
	#invalidationGeneration = 0;
	/** @type {Map<string, number>} */
	#groupBases = new Map();
	/** @type {Map<string, number>} */
	#nextGroupBase = new Map();
	/** @type {Map<string, { startedAt: number, lastAt: number }>} */
	#openAttempts = new Map();

	/** @param {string} runDir @param {{ lease?: import("./persistence.mjs").Lease|null, readOnly?: boolean, mode?: "runtime"|"summary"|"records", types?: string[] }} [options] */
	constructor(runDir, { lease = null, readOnly = false, mode = "runtime", types = null } = {}) {
		this.runDir = runDir;
		this.#path = join(runDir, "ledger.jsonl");
		this.#lease = lease;
		this.#readOnly = readOnly;
		this.#mode = mode;
		this.#recordTypes = Array.isArray(types) ? new Set(types) : null;
		if (!readOnly && existsSync(this.#path)) repairTrailingLine(this.#path);
		this.#load();
	}

	get revision() {
		return this.#revision;
	}

	get approvedLimits() {
		return { ...this.#approvedLimits };
	}

	get budgetIncreaseDeclined() {
		return this.#budgetIncreaseDeclined;
	}

	get interruptedRevision() {
		return this.#interruptedRevision;
	}

	get records() {
		if (this.#mode !== "records") throw new Error("Ledger records were not retained; open with mode:'records'");
		return this.#records;
	}

	get consumed() {
		let activeMs = this.#activeMs;
		for (const attempt of this.#openAttempts.values()) {
			activeMs += Math.max(0, attempt.lastAt - attempt.startedAt);
		}
		return {
			activeMs,
			spawnedAgents: this.#spawnedAgents,
			nanoAiu: this.#nanoAiu,
			unknownUsage: this.#unknownUsage,
		};
	}

	startAttempt() {
		const attemptId = randomUUID();
		const startedAt = Date.now();
		this.#append({ type: "attempt_started", attemptId, startedAt });
		this.#openAttempts.set(attemptId, { startedAt, lastAt: startedAt });
		return { attemptId, startedAt };
	}

	/** @param {{ attemptId: string, startedAt: number }} attempt @param {string} status @param {unknown} [failure] */
	finishAttempt(attempt, status, failure = null) {
		const activeMs = Math.max(0, Date.now() - attempt.startedAt);
		this.#append({ type: "attempt_finished", attemptId: attempt.attemptId, activeMs, status, failure });
		this.#activeMs += activeMs;
		this.#openAttempts.delete(attempt.attemptId);
	}

	admitAgent() {
		this.#append({ type: "agent_admitted", count: 1 });
		this.#spawnedAgents++;
	}

	/** Persist one terminal agent outcome and account its usage. @param {string} key @param {any} result */
	recordUsage(key, result) {
		const nanoAiu = Number.isFinite(result.nanoAiu) && Number(result.nanoAiu) >= 0 ? Number(result.nanoAiu) : 0;
		const unknownUsage = result.usageUnknown === true ? 1 : 0;
		this.#append({
			type: "agent_usage",
			key,
			nanoAiu,
			unknownUsage,
			outcome: result.skipped ? "skipped" : result.ok ? "ok" : "failed",
			label: result.label,
			sessionId: result.sessionId,
			model: result.model,
			durationMs: result.durationMs,
			inputTokens: result.inputTokens,
			outputTokens: result.outputTokens,
			cacheReadTokens: result.cacheReadTokens,
			cacheWriteTokens: result.cacheWriteTokens,
			reasoningTokens: result.reasoningTokens,
		});
		this.#nanoAiu += nanoAiu;
		this.#unknownUsage += unknownUsage;
	}

	/** @param {unknown} declared @param {unknown} requested */
	approve(declared, requested) {
		const approved = approveLimits(declared, this.#approvedLimits, requested, this.consumed);
		this.#append({ type: "limits_approved", limits: approved });
		this.#approvedLimits = approved;
		return { ...approved };
	}

	declineLimits(proposed) {
		this.#append({ type: "limits_declined", limits: proposed });
		this.#budgetIncreaseDeclined = true;
	}

	invalidationEpoch(branch) {
		let epoch = 0;
		for (let depth = 0; depth <= branch.length; depth++) {
			epoch = Math.max(epoch, this.#invalidationEpochs.get(JSON.stringify(branch.slice(0, depth))) ?? 0);
		}
		return epoch;
	}

	get(key) {
		const value = this.#cache.get(key);
		return value && typeof value === "object" ? { ...value, cached: true } : value;
	}

	lookup(key) {
		return this.#cache.has(key) ? { hit: true, value: this.#cache.get(key) } : { hit: false, value: undefined };
	}

	put(key, value, kind = "agent") {
		if (this.#cache.has(key)) return;
		this.#cache.set(key, value);
		this.#append({ type: "result", kind, key, value });
	}

	recordStarted(key, spec, branch = [], retainPrompt = false, agentSeq = null, attemptId = null) {
		const prompt = String(spec.prompt || "");
		this.#append({
			type: "agent_started",
			key,
			branch,
			branchPath: formatBranchPath(branch),
			agentSeq,
			attemptId,
			...(retainPrompt ? { prompt } : { promptHash: createHash("sha256").update(prompt).digest("hex") }),
			label: spec.label,
			model: spec.model,
			cwd: spec.cacheCwd,
			startedAt: new Date().toISOString(),
		});
	}

	invalidate(branches) {
		if (this.#readOnly) throw new Error("Conveyor ledger is read-only");
		if (!Array.isArray(branches) || !branches.length) return null;
		const generation = this.#invalidationGeneration + 1;
		const record = {
			type: "branches_invalidated",
			generation,
			branches: branches.map((branch) => [...branch]),
			invalidatedAt: new Date().toISOString(),
		};
		this.#append(record);
		this.#applyInvalidation(record);
		return generation;
	}

	reserveBranches(parent, site, size) {
		const existing = this.#groupBases.get(JSON.stringify([parent, site]));
		if (existing !== undefined) return existing;
		const record = { type: "group", parent: [...parent], site, base: this.#nextGroupBase.get(JSON.stringify(parent)) ?? 0, size };
		this.#append(record);
		this.#applyGroup(record);
		return record.base;
	}

	/** Record a durable lifecycle event and return its revision. @param {string} type @param {Record<string, unknown>} [data] */
	record(type, data = {}) {
		return this.#append({ type, ...data });
	}

	/** Buffer diagnostic progress without fsync; durable revisions are assigned only when flushed. */
	progress(record) {
		if (this.#readOnly) throw new Error("Conveyor ledger is read-only");
		if (this.#progressFatal) throw this.#progressFatal;
		const progressSeq = ++this.#progressSeq;
		this.#progressBuffer.push({ type: "progress", record, progressSeq });
		if (this.#progressBuffer.length >= PROGRESS_BUFFER_SIZE) this.flushProgress();
		else this.#scheduleProgressFlush();
		return { progressSeq, revision: this.#revision };
	}

	flushProgress() {
		if (this.#progressTimer) {
			clearTimeout(this.#progressTimer);
			this.#progressTimer = null;
		}
		if (this.#progressFatal) throw this.#progressFatal;
		if (!this.#progressBuffer.length) return;
		const buffered = this.#progressBuffer.splice(0);
		const values = buffered.map((record) => ({ ...record, revision: ++this.#revision, recordedAt: Date.now() }));
		try {
			this.#write(values, false);
			if (this.#mode === "records") this.#records.push(...values);
			for (const attempt of this.#openAttempts.values()) attempt.lastAt = values.at(-1).recordedAt;
		} catch (error) {
			if (error instanceof LostLeaseError || error instanceof LockedError) {
				this.#progressFatal = error;
				throw error;
			}
			this.#progressWarning = error instanceof Error ? error : new Error(String(error));
		}
	}

	takeProgressWarning() {
		const warning = this.#progressWarning;
		this.#progressWarning = null;
		return warning;
	}

	#scheduleProgressFlush() {
		if (this.#progressTimer) return;
		this.#progressTimer = setTimeout(() => {
			this.#progressTimer = null;
			try {
				this.flushProgress();
			} catch {
				// Fatal lease loss is surfaced by the next progress or critical operation.
			}
		}, PROGRESS_FLUSH_MS);
		this.#progressTimer.unref?.();
	}

	#load() {
		if (!existsSync(this.#path)) return;
		for (const line of readFileSync(this.#path, "utf8").split("\n")) {
			if (!line.trim()) continue;
			let record;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}
			this.#revision = Math.max(this.#revision, Number(record.revision) || 0);
			if (this.#mode === "records" && (!this.#recordTypes || this.#recordTypes.has(record.type))) this.#records.push(record);
			if (record.type === "attempt_started" && typeof record.attemptId === "string") {
				const startedAt = Number(record.startedAt) || Number(record.recordedAt) || 0;
				this.#openAttempts.set(record.attemptId, { startedAt, lastAt: Number(record.recordedAt) || startedAt });
				this.#interruptedRevision = Math.max(this.#interruptedRevision, Number(record.revision) || 0);
			} else if (record.type === "attempt_finished" && typeof record.attemptId === "string") {
				this.#openAttempts.delete(record.attemptId);
				if (!this.#openAttempts.size) this.#interruptedRevision = 0;
				this.#activeMs += Math.max(0, Number(record.activeMs) || 0);
			} else if (record.type === "agent_admitted") {
				this.#spawnedAgents += Math.max(0, Number(record.count) || 0);
			} else if (record.type === "agent_usage") {
				this.#nanoAiu += Math.max(0, Number(record.nanoAiu) || 0);
				this.#unknownUsage += Math.max(0, Number(record.unknownUsage) || 0);
			} else if (record.type === "limits_approved" && record.limits && typeof record.limits === "object") {
				this.#approvedLimits = { ...record.limits };
			} else if (record.type === "limits_declined") {
				this.#budgetIncreaseDeclined = true;
			} else if (this.#mode === "runtime" && record.type === "result" && typeof record.key === "string" && Object.hasOwn(record, "value") && !this.#cache.has(record.key)) {
				this.#cache.set(record.key, record.value);
			} else if (this.#mode === "runtime" && record.type === "group") {
				this.#applyGroup(record);
			} else if (this.#mode === "runtime" && record.type === "branches_invalidated") {
				this.#applyInvalidation(record);
			}
			for (const attempt of this.#openAttempts.values()) {
				attempt.lastAt = Math.max(attempt.lastAt, Number(record.recordedAt) || attempt.lastAt);
			}
		}
		for (const attempt of this.#openAttempts.values()) {
			this.#activeMs += Math.max(0, attempt.lastAt - attempt.startedAt);
		}
		this.#openAttempts.clear();
	}

	#applyGroup(record) {
		if (!validBranch(record.parent) || typeof record.site !== "string" || !record.site) return;
		const base = Number(record.base);
		const size = Number(record.size);
		if (!Number.isSafeInteger(base) || base < 0 || !Number.isSafeInteger(size) || size < 1) return;
		const parentKey = JSON.stringify(record.parent);
		if (base < (this.#nextGroupBase.get(parentKey) ?? 0)) {
			this.#nextGroupBase.set(parentKey, Math.max(this.#nextGroupBase.get(parentKey) ?? 0, base + size));
			return;
		}
		this.#groupBases.set(JSON.stringify([record.parent, record.site]), base);
		this.#nextGroupBase.set(parentKey, base + size);
	}

	#applyInvalidation(record) {
		const generation = Number(record.generation);
		if (!Number.isSafeInteger(generation) || generation < 1 || !Array.isArray(record.branches)) return;
		const branches = record.branches.filter(validBranch).map((branch) => branch.map(Number));
		if (!branches.length) return;
		this.#invalidationGeneration = Math.max(this.#invalidationGeneration, generation);
		for (const branch of branches) {
			const key = JSON.stringify(branch);
			this.#invalidationEpochs.set(key, Math.max(this.#invalidationEpochs.get(key) ?? 0, generation));
		}
	}

	/** @param {Record<string, unknown>} record */
	#append(record) {
		if (this.#readOnly) throw new Error("Conveyor ledger is read-only");
		this.flushProgress();
		if (this.#progressFatal) throw this.#progressFatal;
		const value = { ...record, revision: ++this.#revision, recordedAt: Date.now() };
		this.#write([value], true);
		for (const attempt of this.#openAttempts.values()) attempt.lastAt = value.recordedAt;
		if (this.#mode === "records") this.#records.push(value);
		return value.revision;
	}

	#write(values, sync) {
		this.#lease?.assertOwned();
		const fd = openSync(this.#path, "a", 0o600);
		try {
			writeSync(fd, values.map((value) => JSON.stringify(value) + "\n").join(""));
			if (sync) fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	}
}

/** @param {unknown} value @returns {value is number[]} */
function validBranch(value) {
	return Array.isArray(value) && value.every((part) => Number.isSafeInteger(part) && part >= 0);
}

/** @param {number[]} branch */
export function formatBranchPath(branch) {
	return branch.length ? `/${branch.join("/")}` : "/";
}

/** Remove a crash-torn final JSONL record before the next append. @param {string} path */
function repairTrailingLine(path) {
	const size = statSync(path).size;
	if (!size) return;
	const fd = openSync(path, "r+");
	try {
		const tail = Buffer.alloc(1);
		readSync(fd, tail, 0, 1, size - 1);
		if (tail[0] === 0x0a) return;
		const body = Buffer.alloc(size);
		readSync(fd, body, 0, size, 0);
		const newline = body.lastIndexOf(0x0a);
		truncateSync(path, newline < 0 ? 0 : newline + 1);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
