/**
 * @module persistence
 *
 * Durable run ownership and atomic artifact persistence. A lock directory gives one process the
 * right to mutate a run; generation-fenced leases prevent a stale owner from continuing after
 * takeover. `manifest.json` is the immutable run identity.
 */
import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { stableStringify } from "./json.mjs";

/**
 * The only versioned thing in the extension. A resumed run replays cached agent results and branch
 * allocations from its own artifacts, so resuming a run written by a different on-disk format could
 * silently serve one group another group's cached result. Bump this whenever the manifest, journal
 * record shape, or cache-key algorithm changes incompatibly; older runs then become inspection-only.
 */
export const FORMAT_VERSION = 1;

export class PersistenceError extends Error {}
export class LockedError extends PersistenceError {}
export class LostLeaseError extends PersistenceError {}

/** @param {string} path @returns {any|null} */
export function readJsonFile(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/** @param {string} path @param {string|Buffer} body */
export function atomicWriteFile(path, body) {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
	const fd = openSync(temp, "wx", 0o600);
	try {
		if (typeof body === "string") writeSync(fd, body);
		else writeSync(fd, body, 0, body.length);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		renameSync(temp, path);
		fsyncDir(dirname(path));
	} catch (e) {
		rmSync(temp, { force: true });
		throw e;
	}
}

/** @param {string} path @param {unknown} value */
export function atomicWriteJson(path, value) {
	atomicWriteFile(path, JSON.stringify(value, null, 2));
}

/** @param {string} dir */
function fsyncDir(dir) {
	if (process.platform === "win32") return;
	try {
		const fd = openSync(dir, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	} catch {
		// Directory fsync is unavailable on some filesystems; file+rename durability still applies.
	}
}

/** @param {number} pid */
function processAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
	}
}

/** @param {unknown} value */
export function hashValue(value) {
	return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/** @param {string|null|undefined} path */
export function hashFile(path) {
	if (!path) return null;
	try {
		return createHash("sha256").update(readFileSync(path)).digest("hex");
	} catch {
		return null;
	}
}

export class Lease {
	#released = false;

	/** @param {Persistence} persistence @param {{ token: string, generation: number }} owner */
	constructor(persistence, owner) {
		this.persistence = persistence;
		this.token = owner.token;
		this.generation = owner.generation;
	}

	/**
	 * Fence every write: a run whose lock was taken over (its owner died and another process
	 * claimed it) must not keep writing. Called before each artifact write, so ownership loss is
	 * always caught at the moment it matters.
	 */
	assertOwned() {
		const owner = readJsonFile(this.persistence.ownerPath);
		if (owner?.token !== this.token || owner?.generation !== this.generation) {
			throw new LostLeaseError(`workflow run '${this.persistence.runId}' ownership changed; refusing a stale write`);
		}
	}

	release() {
		if (this.#released) return;
		this.#released = true;
		const owner = readJsonFile(this.persistence.ownerPath);
		if (owner?.token === this.token && owner?.generation === this.generation) {
			rmSync(this.persistence.lockPath, { recursive: true, force: true });
			fsyncDir(this.persistence.runDir);
		}
	}
}

export class Persistence {
	/**
	 * @param {string} runDir
	 * @param {{ runId: string }} opts
	 */
	constructor(runDir, { runId }) {
		this.runDir = runDir;
		this.runId = runId;
		this.lockPath = join(runDir, ".lock");
		this.ownerPath = join(this.lockPath, "owner.json");
		this.generationPath = join(runDir, "lock-generation");
		mkdirSync(runDir, { recursive: true });
	}

	/** @returns {Lease} */
	acquire() {
		while (true) {
			const candidate = `${this.lockPath}.candidate-${randomUUID()}`;
			mkdirSync(candidate);
			const previous = Number(readFileSafe(this.generationPath) || 0);
			const generation = Number.isSafeInteger(previous) && previous >= 0 ? previous + 1 : 1;
			const owner = { token: randomUUID(), generation };
			atomicWriteJson(join(candidate, "owner.json"), { ...owner, pid: process.pid });
			try {
				renameSync(candidate, this.lockPath);
				atomicWriteFile(this.generationPath, String(generation));
				return new Lease(this, owner);
			} catch (e) {
				rmSync(candidate, { recursive: true, force: true });
				if (!["EEXIST", "ENOTEMPTY"].includes(/** @type {NodeJS.ErrnoException} */ (e).code || "")) throw e;
				const current = readJsonFile(this.ownerPath);
				if (processAlive(Number(current?.pid))) {
					throw new LockedError(`workflow run '${this.runId}' is owned by live process ${current.pid}`);
				}
				const stale = `${this.lockPath}.stale-${randomUUID()}`;
				try {
					renameSync(this.lockPath, stale);
					rmSync(stale, { recursive: true, force: true });
				} catch (renameError) {
					if (!["ENOENT", "EEXIST", "ENOTEMPTY"].includes(/** @type {NodeJS.ErrnoException} */ (renameError).code || "")) throw renameError;
				}
			}
		}
	}

	/**
	 * Create or validate the immutable manifest.
	 * @param {Record<string, unknown>} manifest
	 * @param {{ resume?: boolean }} [opts]
	 */
	ensureManifest(manifest, { resume = false } = {}) {
		const path = join(this.runDir, "manifest.json");
		const existing = readJsonFile(path);
		if (!existing) {
			if (resume) throw new PersistenceError(`workflow run '${this.runId}' predates the durable manifest format and is inspection-only; start a new run`);
			atomicWriteJson(path, manifest);
			return manifest;
		}
		if (existing.runId !== this.runId) {
			throw new PersistenceError(`workflow run '${this.runId}' has a manifest for a different run id '${existing.runId}'`);
		}
		if (existing.formatVersion !== FORMAT_VERSION) {
			throw new PersistenceError(
				`workflow run '${this.runId}' was written by format ${existing.formatVersion ?? "(none)"}, but this build writes format ${FORMAT_VERSION}; it is inspection-only. Start a new run.`,
			);
		}
		if (!resume) throw new PersistenceError(`workflow run '${this.runId}' already exists; use resume instead of reusing its id`);
		return existing;
	}

	/** @param {Lease} lease @param {string} name @param {unknown} value */
	writeJson(lease, name, value) {
		lease.assertOwned();
		atomicWriteJson(join(this.runDir, name), value);
	}

	/** @param {Lease} lease @param {string} name @param {string|Buffer} value */
	writeFile(lease, name, value) {
		lease.assertOwned();
		atomicWriteFile(join(this.runDir, name), value);
	}
}

/** @param {string} path */
function readFileSafe(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}
