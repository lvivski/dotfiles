/** @module work — one durable lifecycle concept for a real conveyor attempt. */
import { readdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
	atomicWriteJson,
	LockedError,
	LostLeaseError,
	Persistence,
	PROCESS_INSTANCE_ID,
	readJsonFile,
} from "./persistence.mjs";

export const CONTROL_POLL_INTERVAL_MS = 250;
export const HEARTBEAT_INTERVAL_MS = 5000;
export const HEARTBEAT_STALE_MS = HEARTBEAT_INTERVAL_MS * 6;

const ACTIONS = new Set(["pause", "cancel"]);
/** @type {Map<string, Work>} */
const ACTIVE = new Map();
/** @typedef {{ runId: string, runDir: string, timeoutSec?: number|null, signal?: AbortSignal,
 *   controlPollMs?: number, heartbeatIntervalMs?: number }} WorkOptions */

export class WorkError extends Error {}

export class Work {
	#closed = false;
	#controller = new AbortController();
	/** @type {ReturnType<typeof setTimeout>|null} */
	#deadlineTimer = null;
	/** @type {ReturnType<typeof setTimeout>|null} */
	#controlTimer = null;
	/** @type {ReturnType<typeof setInterval>|null} */
	#heartbeatTimer = null;
	/** @type {AbortSignal|null} */
	#parentSignal = null;
	/** @type {(() => void)|null} */
	#parentAbort = null;
	/** @type {() => void} */
	#resolveSettled = () => {};

	/**
	 * Open one real conveyor attempt. Dry runs must never call this.
	 * @param {WorkOptions} input
	 */
	static open(input) {
		if (ACTIVE.has(input.runId)) throw new WorkError(`conveyor run '${input.runId}' is already active.`);
		const persistence = new Persistence(input.runDir, { runId: input.runId });
		let lease;
		try {
			lease = persistence.acquire();
		} catch (error) {
			if (error instanceof LockedError) throw new WorkError(error.message);
			throw error;
		}
		const work = new Work(input, persistence, lease);
		ACTIVE.set(input.runId, work);
		try {
			work.#start(input);
			return work;
		} catch (error) {
			try {
				work.close();
			} catch {
				// Preserve the startup failure; close already removed Work from the active registry.
			}
			throw error;
		}
	}

	/** @param {string} runId */
	static find(runId) {
		return ACTIVE.get(runId) ?? null;
	}

	/** @param {WorkOptions} input @param {Persistence} persistence @param {import("./persistence.mjs").Lease} lease */
	constructor(input, persistence, lease) {
		this.runId = input.runId;
		this.runDir = input.runDir;
		this.persistence = persistence;
		this.lease = lease;
		/** @type {Promise<void>} */
		const settled = new Promise((resolve) => {
			this.#resolveSettled = () => resolve();
		});
		this.settled = settled;
	}

	get signal() {
		return this.#controller.signal;
	}

	get generation() {
		return this.lease.generation;
	}

	/** Pause or cancel synchronously. Returns false once Work has settled. @param {"pause"|"cancel"} action */
	request(action) {
		if (this.#closed || !ACTIONS.has(action)) return false;
		if (!this.signal.aborted) {
			this.#controller.abort({ kind: action });
			return true;
		}
		if (action === "cancel" && this.signal.reason?.kind === "pause") this.signal.reason.kind = "cancel";
		return true;
	}

	/**
	 * Stop lifecycle machinery and release ownership after terminal artifacts have been written.
	 * Idempotent.
	 */
	close() {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#deadlineTimer) clearTimeout(this.#deadlineTimer);
		if (this.#controlTimer) clearTimeout(this.#controlTimer);
		if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
		if (this.#parentSignal && this.#parentAbort) this.#parentSignal.removeEventListener("abort", this.#parentAbort);
		if (ACTIVE.get(this.runId) === this) ACTIVE.delete(this.runId);
		let releaseError = null;
		try {
			this.lease.release();
		} catch (error) {
			releaseError = error;
		} finally {
			this.#resolveSettled();
		}
		if (releaseError) throw releaseError;
	}

	/** @param {WorkOptions} input */
	#start(input) {
		if (input.signal) {
			const parentSignal = input.signal;
			const parentAbort = () => this.#abort(parentSignal.reason);
			this.#parentSignal = parentSignal;
			this.#parentAbort = parentAbort;
			if (parentSignal.aborted) parentAbort();
			else parentSignal.addEventListener("abort", parentAbort, { once: true });
		}
		if (input.timeoutSec != null) {
			const deadlineTimer = setTimeout(() => this.#abort({ kind: "timeout" }), input.timeoutSec * 1000);
			deadlineTimer.unref?.();
			this.#deadlineTimer = deadlineTimer;
		}
		this.#writeHeartbeat();
		const heartbeatMs = Math.max(10, input.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
		const heartbeatTimer = setInterval(() => this.#writeHeartbeat(), heartbeatMs);
		heartbeatTimer.unref?.();
		this.#heartbeatTimer = heartbeatTimer;
		this.#scheduleControl(input.controlPollMs ?? CONTROL_POLL_INTERVAL_MS);
	}

	/** @param {unknown} reason */
	#abort(reason) {
		if (!this.signal.aborted) this.#controller.abort(reason);
	}

	#writeHeartbeat() {
		if (this.#closed) return;
		try {
			this.lease.assertOwned();
			atomicWriteJson(join(this.runDir, "heartbeat.json"), {
				token: this.lease.token,
				generation: this.lease.generation,
				pid: this.lease.pid,
				instanceId: this.lease.instanceId,
				heartbeatAt: new Date().toISOString(),
			});
		} catch (error) {
			if (error instanceof LostLeaseError) this.#abort({ kind: "cancel", error: error.message });
			// Heartbeat persistence is diagnostic; normal artifact writes still surface storage errors.
		}
	}

	/** @param {number} intervalMs */
	#scheduleControl(intervalMs) {
		if (this.#closed) return;
		const controlTimer = setTimeout(() => {
			this.#controlTimer = null;
			const request = takeWorkControl(this.runDir);
			if (request) this.request(request.action);
			this.#scheduleControl(intervalMs);
		}, Math.max(10, intervalMs));
		controlTimer.unref?.();
		this.#controlTimer = controlTimer;
	}
}

/** Test/emergency helper. @param {string} runId */
export function abortWork(runId) {
	return Work.find(runId)?.request("cancel") ?? false;
}

/** @param {number} pid */
export function processIsAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM";
	}
}

/** @param {string} runDir */
export function readWorkOwner(runDir) {
	const owner = readJsonFile(join(runDir, ".lock", "owner.json"));
	const pid = Number(owner?.pid);
	const generation = Number(owner?.generation);
	if (typeof owner?.token !== "string" || !owner.token || !Number.isSafeInteger(generation) || generation < 1 || !Number.isInteger(pid) || pid <= 0) return null;
	return {
		token: owner.token,
		generation,
		pid,
		instanceId: typeof owner.instanceId === "string" ? owner.instanceId : null,
	};
}

/**
 * Queue a cross-process request fenced to the current Work generation.
 * @param {string} runDir
 * @param {"pause"|"cancel"} action
 */
export function requestWorkControl(runDir, action) {
	if (!ACTIONS.has(action)) throw new WorkError(`unsupported conveyor control action '${action}'`);
	const owner = readWorkOwner(runDir);
	if (!owner || !processIsAlive(owner.pid)) throw new WorkError("conveyor has no live owner");
	const id = randomUUID();
	const request = {
		id,
		action,
		requestedAt: new Date().toISOString(),
		requesterPid: process.pid,
		target: owner,
	};
	const path = join(runDir, "control", `${Date.now()}-${id}.json`);
	try {
		atomicWriteJson(path, request);
	} catch (error) {
		throw new WorkError(`failed to persist conveyor control request: ${error instanceof Error ? error.message : error}`);
	}
	const current = readWorkOwner(runDir);
	if (!sameOwner(owner, current) || !processIsAlive(owner.pid)) {
		removeArtifact(path);
		throw new WorkError("conveyor ownership changed before the control request was accepted");
	}
	return request;
}

/** @param {string} runDir */
export function takeWorkControl(runDir) {
	const owner = readWorkOwner(runDir);
	if (!owner || owner.pid !== process.pid) return null;
	const dir = join(runDir, "control");
	let files;
	try {
		files = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
	} catch {
		return null;
	}
	let selected = null;
	for (const name of files) {
		const path = join(dir, name);
		const request = readJsonFile(path);
		if (!validRequest(request) || !sameOwner(owner, request.target)) {
			removeArtifact(path);
			continue;
		}
		removeArtifact(path);
		if (!selected || request.action === "cancel") selected = request;
	}
	return selected;
}

/** Reconcile persisted running state against Work ownership. @param {any} rec @param {string} runDir */
export function reconcileWorkRecord(rec, runDir) {
	if (!rec || rec.status !== "running") return rec;
	const owner = readWorkOwner(runDir);
	if (owner) {
		if (!processIsAlive(owner.pid)) return interrupted(rec, "conveyor host process exited before completion");
		if (owner.pid === process.pid && owner.instanceId && owner.instanceId !== PROCESS_INSTANCE_ID) {
			return interrupted(rec, "conveyor owner instance exited before completion");
		}
		const heartbeat = readHeartbeat(runDir, owner);
		return heartbeat ? { ...rec, heartbeatAt: heartbeat.heartbeatAt, updatedAt: latestTime(rec.updatedAt, heartbeat.heartbeatAt) } : rec;
	}
	const pid = Number(rec.ownerPid);
	if (Number.isInteger(pid) && pid > 0) {
		if (!processIsAlive(pid)) return interrupted(rec, "conveyor host process exited before completion");
		if (pid === process.pid && rec.ownerInstanceId !== PROCESS_INSTANCE_ID) return interrupted(rec, "conveyor owner instance exited before completion");
	}
	const updated = timestampMs(rec.heartbeatAt || rec.updatedAt || rec.startedAt);
	if (updated > 0 && Date.now() - updated > HEARTBEAT_STALE_MS) return interrupted(rec, "conveyor has no active owner lock");
	return rec;
}

/** @param {string} runDir @param {unknown} fallback */
export function workHeartbeatAt(runDir, fallback = null) {
	const owner = readWorkOwner(runDir);
	const heartbeat = owner ? readHeartbeat(runDir, owner)?.heartbeatAt : null;
	return latestTime(fallback, heartbeat);
}

/** @param {string} runDir @param {any} owner */
function readHeartbeat(runDir, owner) {
	const heartbeat = readJsonFile(join(runDir, "heartbeat.json"));
	return sameOwner(owner, heartbeat) && timestampMs(heartbeat?.heartbeatAt) > 0 ? heartbeat : null;
}

/** @param {any} request */
function validRequest(request) {
	return request && typeof request === "object" && typeof request.id === "string" && ACTIONS.has(request.action);
}

/** @param {any} a @param {any} b */
function sameOwner(a, b) {
	return !!a && !!b && a.token === b.token && a.generation === b.generation && a.pid === b.pid;
}

/** @param {any} rec @param {string} message */
function interrupted(rec, message) {
	return { ...rec, status: "interrupted", error: rec.error || message };
}

/** @param {unknown} a @param {unknown} b */
function latestTime(a, b) {
	const aMs = timestampMs(a);
	const bMs = timestampMs(b);
	if (!aMs && !bMs) return null;
	return aMs >= bMs ? new Date(aMs).toISOString() : new Date(bMs).toISOString();
}

/** @param {unknown} value */
function timestampMs(value) {
	const parsed = Date.parse(String(value || ""));
	return Number.isNaN(parsed) ? 0 : parsed;
}

/** @param {string} path */
function removeArtifact(path) {
	try {
		rmSync(path, { force: true, recursive: true });
	} catch {
		// Requests are generation-fenced, so stale artifacts cannot affect a later Work.
	}
}
