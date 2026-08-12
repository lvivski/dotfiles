/**
 * Session-scoped, revisioned, atomically replaced Foundry plan storage.
 *
 * The complete plan document is authoritative. Every write validates the full
 * candidate, rejects symlink escapes, and coordinates local and cross-process
 * writers through heartbeated owner files.
 *
 * @module foundry/storage
 */
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
    link,
    lstat,
    mkdir,
    open,
    readFile,
    readdir,
    realpath,
    rename,
    unlink,
    utimes,
} from "node:fs/promises";

import {
    PLAN_STATUS,
    assertPlanId,
    summarizePlan,
    validatePlan,
} from "./domain.mjs";

/**
 * @typedef {object} StorageAnchor
 * @property {string} realBase
 * @property {number} device
 * @property {number} inode
 */

/**
 * @typedef {object} PlanStoreOptions
 * @property {string} [workspacePath]
 * @property {() => Date|string|number} [clock]
 * @property {number} [lockWaitMs]
 * @property {number} [lockPollMs]
 */

/**
 * @typedef {object} PlanStore
 * @property {(plan: any, expectedRevision?: 0) => Promise<any>} create
 * @property {(id: string) => Promise<any>} read
 * @property {(id: string, expectedRevision: number, candidate: any) => Promise<any>} update
 * @property {(id: string, options: {reason: string, requestedBy: string}) => Promise<any>} quarantineInvalidPlan
 * @property {(options?: {limit?: number}) => Promise<any>} list
 * @property {(planId: string, expectedRevision: number) => Promise<any>} activate
 * @property {() => Promise<any>} getActive
 * @property {() => Promise<any>} deactivate
 * @property {(options?: any) => Promise<any>} recoverStaleLocks
 * @property {string} directory
 */

/** Default number of plan summaries returned by a list operation. */
const DEFAULT_LIST_LIMIT = 50;

/** Hard upper bound for one list operation. */
const MAX_LIST_LIMIT = 100;

/** Maximum time to wait for another writer before failing. */
const DEFAULT_LOCK_WAIT_MS = 5_000;

/** Poll cadence while waiting for another process's owner file. */
const DEFAULT_LOCK_POLL_MS = 20;

/** Owner-file name that serializes startup lock recovery. */
const RECOVERY_BARRIER_NAME = ".foundry-recovery.lock";

/** Heartbeat cadence for active owner files. */
const OWNER_HEARTBEAT_MS = 1_000;

/** Unique identity for this extension process, distinct from the reusable PID. */
export const STORAGE_PROCESS_INSTANCE_ID = randomUUID();

/** In-process promise chains keyed by target path. */
const writeLocks = new Map();

/** Typed error surfaced by the plan store. */
export class FoundryStorageError extends Error {
    /**
     * @param {string} code Stable machine-readable error code.
     * @param {string} message Human-readable failure summary.
     * @param {{details?: unknown, cause?: unknown}} [options]
     */
    constructor(code, message, options = {}) {
        super(message);
        this.name = "FoundryStorageError";
        this.code = code;
        this.details = options.details ?? null;
        this.cause = options.cause;
    }

    /**
     * Serializes the safe public error fields.
     *
     * @returns {{code: string, message: string, details: unknown}}
     */
    toJSON() {
        return {
            code: this.code,
            message: this.message,
            details: this.details,
        };
    }
}

/**
 * Creates a typed storage error.
 *
 * @param {string} code
 * @param {string} message
 * @param {{details?: unknown, cause?: unknown}} [options]
 * @returns {FoundryStorageError}
 */
function storageError(code, message, options) {
    return new FoundryStorageError(code, message, options);
}

/**
 * Creates an owned structured clone of caller data.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function clone(value) {
    return structuredClone(value);
}

/**
 * Resolves the configured storage clock to canonical UTC.
 *
 * @param {() => Date|string|number} clock
 * @returns {string}
 */
function resolveTimestamp(clock) {
    const value = clock();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
        throw storageError("invalid_clock", "The storage clock returned an invalid timestamp");
    }
    return date.toISOString();
}

/**
 * Validates and normalizes a session workspace path.
 *
 * @param {unknown} workspacePath
 * @returns {string}
 */
function validateWorkspacePath(workspacePath) {
    if (typeof workspacePath !== "string" || workspacePath.trim().length === 0) {
        throw storageError(
            "workspace_unavailable",
            "Foundry requires the current Copilot session workspacePath",
        );
    }
    if (!path.isAbsolute(workspacePath)) {
        throw storageError("invalid_workspace_path", "workspacePath must be absolute");
    }
    return path.resolve(workspacePath);
}

/**
 * Requires a positive mutation revision.
 *
 * @param {any} expectedRevision
 * @returns {void}
 */
function validateExpectedRevision(expectedRevision) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
        throw storageError(
            "invalid_expected_revision",
            "expectedRevision must be a positive safe integer",
            { details: { expectedRevision } },
        );
    }
}

/**
 * Requires a bounded plan-list limit.
 *
 * @param {any} limit
 * @returns {void}
 */
function validateLimit(limit) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
        throw storageError(
            "invalid_list_limit",
            `limit must be an integer from 1 through ${MAX_LIST_LIMIT}`,
            { details: { limit } },
        );
    }
}

/**
 * Resolves a contained artifact path for a validated plan ID.
 *
 * @param {string} baseDirectory
 * @param {string} id
 * @returns {string}
 */
function planTarget(baseDirectory, id) {
    assertPlanId(id);
    const target = path.resolve(baseDirectory, `${id}.json`);
    if (path.dirname(target) !== baseDirectory) {
        throw storageError("path_outside_workspace", "Resolved plan path escaped Foundry storage");
    }
    return target;
}

/**
 * Computes a source fingerprint used to detect artifact replacement.
 *
 * @param {string|Uint8Array} source
 * @returns {string}
 */
function fingerprint(source) {
    return createHash("sha256").update(source).digest("hex");
}

/**
 * Tests whether an error represents a missing filesystem entry.
 *
 * @param {any} error
 * @returns {boolean}
 */
function isMissing(error) {
    return error?.code === "ENOENT";
}

/**
 * Requires a real, non-symlink directory when it exists.
 *
 * @param {string} pathname
 * @param {string} label
 * @returns {Promise<boolean>} Whether the directory already exists.
 */
async function assertDirectory(pathname, label) {
    let metadata;
    try {
        metadata = await lstat(pathname);
    } catch (error) {
        if (isMissing(error)) {
            return false;
        }
        throw storageError("artifact_directory_unreadable", `${label} could not be inspected`, {
            details: { filesystemCode: error?.code ?? null },
            cause: error,
        });
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw storageError("path_outside_workspace", `${label} must be a real directory, not a symlink`, {
            details: { pathname },
        });
    }
    return true;
}

/**
 * Creates and anchors `<workspace>/files/foundry` without following symlinks.
 *
 * @param {string} workspacePath
 * @param {string} filesRoot
 * @param {string} baseDirectory
 * @returns {Promise<StorageAnchor>}
 */
async function ensureStorageDirectory(workspacePath, filesRoot, baseDirectory) {
    let workspaceMetadata;
    try {
        workspaceMetadata = await lstat(workspacePath);
    } catch (error) {
        throw storageError("workspace_unavailable", "The Copilot session workspace could not be inspected", {
            details: { filesystemCode: error?.code ?? null },
            cause: error,
        });
    }
    if (!workspaceMetadata.isDirectory()) {
        throw storageError("invalid_workspace_path", "workspacePath must identify a directory");
    }

    if (!await assertDirectory(filesRoot, "workspacePath/files")) {
        try {
            await mkdir(filesRoot, { mode: 0o700 });
        } catch (error) {
            if (error?.code !== "EEXIST") {
                throw storageError("artifact_directory_unreadable", "workspacePath/files could not be created", {
                    details: { filesystemCode: error?.code ?? null },
                    cause: error,
                });
            }
        }
        await assertDirectory(filesRoot, "workspacePath/files");
    }
    if (!await assertDirectory(baseDirectory, "Foundry storage directory")) {
        try {
            await mkdir(baseDirectory, { mode: 0o700 });
        } catch (error) {
            if (error?.code !== "EEXIST") {
                throw storageError("artifact_directory_unreadable", "Foundry storage directory could not be created", {
                    details: { filesystemCode: error?.code ?? null },
                    cause: error,
                });
            }
        }
        await assertDirectory(baseDirectory, "Foundry storage directory");
    }

    let realWorkspace;
    let realBase;
    try {
        [realWorkspace, realBase] = await Promise.all([
            realpath(workspacePath),
            realpath(baseDirectory),
        ]);
    } catch (error) {
        throw storageError("artifact_directory_unreadable", "Foundry storage paths could not be resolved", {
            details: { filesystemCode: error?.code ?? null },
            cause: error,
        });
    }
    if (path.relative(realWorkspace, realBase) !== path.join("files", "foundry")) {
        throw storageError(
            "path_outside_workspace",
            "Foundry storage resolved outside workspacePath/files/foundry",
            { details: { workspacePath: realWorkspace, storagePath: realBase } },
        );
    }
    const metadata = await lstat(baseDirectory);
    return {
        realBase,
        device: metadata.dev,
        inode: metadata.ino,
    };
}

/**
 * Revalidates that the storage directory still matches its anchored inode.
 *
 * @param {string} baseDirectory
 * @param {StorageAnchor} anchor
 * @returns {Promise<void>}
 */
async function verifyStorageAnchor(baseDirectory, anchor) {
    let metadata;
    let resolved;
    try {
        metadata = await lstat(baseDirectory);
        resolved = await realpath(baseDirectory);
    } catch (error) {
        throw storageError("path_outside_workspace", "Foundry storage changed during the operation", {
            details: { filesystemCode: error?.code ?? null },
            cause: error,
        });
    }
    if (metadata.isSymbolicLink()
        || !metadata.isDirectory()
        || metadata.dev !== anchor.device
        || metadata.ino !== anchor.inode
        || resolved !== anchor.realBase) {
        throw storageError("path_outside_workspace", "Foundry storage changed during the operation", {
            details: { expected: anchor.realBase, actual: resolved },
        });
    }
}

/**
 * Serializes writes to one target within this process.
 *
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
async function withLocalWriteLock(key, operation) {
    const previous = writeLocks.get(key);
    let release;
    const current = new Promise((resolve) => {
        release = resolve;
    });
    writeLocks.set(key, current);

    if (previous) {
        await previous;
    }
    try {
        return await operation();
    } finally {
        release();
        if (writeLocks.get(key) === current) {
            writeLocks.delete(key);
        }
    }
}

/**
 * Acquires a cross-process owner file after respecting startup recovery.
 *
 * @param {string} target
 * @param {StorageAnchor} anchor
 * @param {{lockWaitMs: number, lockPollMs: number}} options
 * @returns {Promise<{handle: import("node:fs/promises").FileHandle, heartbeat: NodeJS.Timeout, lockPath: string, token: string}>}
 */
async function acquireFileLock(target, anchor, options) {
    const lockPath = path.join(path.dirname(target), `.${path.basename(target)}.lock`);
    const recoveryBarrier = path.join(path.dirname(target), RECOVERY_BARRIER_NAME);
    const token = randomUUID();
    const startedAt = Date.now();
    const deadline = startedAt + options.lockWaitMs;

    while (true) {
        try {
            try {
                await lstat(recoveryBarrier);
                if (Date.now() >= deadline) {
                    throw storageError("lock_timeout", "Timed out waiting for Foundry startup recovery", {
                        details: { recoveryBarrier, waitMs: options.lockWaitMs },
                    });
                }
                await new Promise((resolve) => setTimeout(resolve, options.lockPollMs));
                continue;
            } catch (barrierError) {
                if (!isMissing(barrierError)) {
                    if (barrierError instanceof FoundryStorageError) {
                        throw barrierError;
                    }
                    throw storageError("lock_acquisition_failed", "Foundry recovery barrier could not be inspected", {
                        details: { filesystemCode: barrierError?.code ?? null },
                        cause: barrierError,
                    });
                }
            }
            const handle = await publishOwnerFile(lockPath, {
                token,
                pid: process.pid,
                instanceId: STORAGE_PROCESS_INSTANCE_ID,
                createdAt: new Date(startedAt).toISOString(),
            });
            const resolvedLock = await realpath(lockPath);
            if (path.dirname(resolvedLock) !== anchor.realBase) {
                throw storageError("path_outside_workspace", "Foundry write lock escaped the storage directory", {
                    details: { lockPath: resolvedLock },
                });
            }
            return {
                handle,
                heartbeat: startOwnerHeartbeat(lockPath),
                lockPath,
                token,
            };
        } catch (error) {
            if (error?.code === "EEXIST"
                && await removeRecoverableOwnerFile(lockPath, 30_000)) {
                continue;
            }
            if (error?.code !== "EEXIST") {
                if (error instanceof FoundryStorageError) {
                    throw error;
                }
                throw storageError("lock_acquisition_failed", "Foundry could not acquire the plan write lock", {
                    details: { filesystemCode: error?.code ?? null },
                    cause: error,
                });
            }
            if (Date.now() >= deadline) {
                throw storageError("lock_timeout", "Timed out waiting for another Foundry writer", {
                    details: { lockPath, waitMs: options.lockWaitMs },
                    cause: error,
                });
            }
            await new Promise((resolve) => setTimeout(resolve, options.lockPollMs));
        }
    }
}

/**
 * Publishes an owner file atomically with hard-link create-if-absent semantics.
 *
 * @param {string} target
 * @param {any} payload
 * @returns {Promise<import("node:fs/promises").FileHandle>}
 */
async function publishOwnerFile(target, payload) {
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    let handle;
    try {
        handle = await open(temporary, "wx", 0o600);
        await handle.writeFile(JSON.stringify(payload), "utf8");
        await handle.sync();
        await link(temporary, target);
        try {
            await unlink(temporary);
        } catch {
            // The published owner file is authoritative; a hidden temp is harmless.
        }
        return handle;
    } catch (error) {
        if (handle) {
            try {
                await handle.close();
            } catch {
                // The publish error remains authoritative.
            }
        }
        try {
            await unlink(temporary);
        } catch {
            // A failed publish may already have removed the temporary name.
        }
        throw error;
    }
}

/**
 * Releases an owner file only after verifying its token still belongs to us.
 *
 * @param {{handle: import("node:fs/promises").FileHandle, heartbeat: NodeJS.Timeout, lockPath: string, token: string}} lock
 * @returns {Promise<void>}
 */
async function releaseFileLock(lock) {
    clearInterval(lock.heartbeat);
    await lock.handle.close();
    let payload;
    try {
        const metadata = await lstat(lock.lockPath);
        if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 4_096) {
            throw storageError("lock_compromised", "Foundry write lock is not a valid lock file", {
                details: { lockPath: lock.lockPath },
            });
        }
        payload = JSON.parse(await readFile(lock.lockPath, "utf8"));
    } catch (error) {
        if (error instanceof FoundryStorageError) {
            throw error;
        }
        throw storageError("lock_compromised", "Foundry write-lock ownership could not be verified", {
            details: { lockPath: lock.lockPath, filesystemCode: error?.code ?? null },
            cause: error,
        });
    }
    if (payload?.token !== lock.token) {
        throw storageError("lock_compromised", "Foundry write lock was replaced by another owner", {
            details: { lockPath: lock.lockPath },
        });
    }
    try {
        await unlink(lock.lockPath);
    } catch (error) {
        throw storageError("lock_release_failed", "Foundry could not release the plan write lock", {
            details: { lockPath: lock.lockPath, filesystemCode: error?.code ?? null },
            cause: error,
        });
    }
}

/**
 * Conservatively probes whether an operating-system process may still exist.
 *
 * @param {number} pid
 * @returns {boolean}
 */
function processIsAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code !== "ESRCH";
    }
}

/**
 * Determines whether owner metadata and heartbeat still represent live work.
 *
 * @param {any} payload
 * @param {import("node:fs").Stats} metadata
 * @param {number} staleMs
 * @returns {boolean}
 */
function ownerIsActive(payload, metadata, staleMs) {
    const pid = Number(payload?.pid);
    const createdAt = Date.parse(payload?.createdAt);
    if (!Number.isSafeInteger(pid)
        || pid < 1
        || !Number.isFinite(createdAt)
        || !processIsAlive(pid)) {
        return false;
    }
    if (pid === process.pid
        && payload.instanceId !== STORAGE_PROCESS_INSTANCE_ID) {
        return false;
    }
    if (payload.instanceId === STORAGE_PROCESS_INSTANCE_ID) {
        return true;
    }
    return Number.isFinite(metadata?.mtimeMs)
        && Date.now() - metadata.mtimeMs < staleMs;
}

/**
 * Quarantines and removes a conclusively stale owner file without racing refresh.
 *
 * @param {string} ownerPath
 * @param {number} staleMs
 * @returns {Promise<boolean>} Whether the stale owner was removed.
 */
async function removeRecoverableOwnerFile(ownerPath, staleMs) {
    const quarantine = `${ownerPath}.stale.${process.pid}.${randomUUID()}`;
    try {
        const metadata = await lstat(ownerPath);
        if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 4_096) {
            return false;
        }
        const source = await readFile(ownerPath, "utf8");
        const payload = JSON.parse(source);
        if (ownerIsActive(payload, metadata, staleMs)) {
            return false;
        }
        await rename(ownerPath, quarantine);
        const currentMetadata = await lstat(quarantine);
        const currentSource = await readFile(quarantine, "utf8");
        if (currentMetadata.dev !== metadata.dev
            || currentMetadata.ino !== metadata.ino
            || currentSource !== source) {
            await restoreQuarantine(quarantine, ownerPath);
            return false;
        }
        if (ownerIsActive(payload, currentMetadata, staleMs)) {
            await restoreQuarantine(quarantine, ownerPath);
            return false;
        }
        await unlink(quarantine);
        return true;
    } catch {
        try {
            await restoreQuarantine(quarantine, ownerPath);
        } catch {
            // A competing owner at the original path remains authoritative.
        }
        return false;
    }
}

/**
 * Restores a quarantined owner when reclamation loses a race.
 *
 * @param {string} quarantine
 * @param {string} ownerPath
 * @returns {Promise<void>}
 */
async function restoreQuarantine(quarantine, ownerPath) {
    try {
        await link(quarantine, ownerPath);
        await unlink(quarantine);
    } catch (error) {
        if (error?.code === "EEXIST") {
            try {
                await unlink(quarantine);
            } catch {
                // The competing owner remains authoritative.
            }
            return;
        }
        if (error?.code !== "ENOENT" && error?.code !== "EEXIST") {
            throw error;
        }
    }
}

/**
 * Acquires the singleton startup-recovery barrier.
 *
 * @param {string} barrierPath
 * @param {number} staleMs
 * @returns {Promise<{handle: import("node:fs/promises").FileHandle, heartbeat: NodeJS.Timeout, token: string} | null>}
 */
async function acquireRecoveryBarrier(barrierPath, staleMs) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const token = randomUUID();
            const handle = await publishOwnerFile(barrierPath, {
                token,
                pid: process.pid,
                instanceId: STORAGE_PROCESS_INSTANCE_ID,
                createdAt: new Date().toISOString(),
            });
            return {
                handle,
                heartbeat: startOwnerHeartbeat(barrierPath),
                token,
            };
        } catch (error) {
            if (error?.code === "EEXIST"
                && attempt === 0
                && await removeRecoverableOwnerFile(barrierPath, staleMs)) {
                continue;
            }
            if (error?.code === "EEXIST") {
                return null;
            }
            throw storageError("lock_recovery_failed", "Foundry could not acquire the recovery barrier", {
                details: { filesystemCode: error?.code ?? null },
                cause: error,
            });
        }
    }
    return null;
}

/**
 * Starts an unreferenced mtime heartbeat for an active owner file.
 *
 * @param {string} ownerPath
 * @returns {NodeJS.Timeout}
 */
function startOwnerHeartbeat(ownerPath) {
    const heartbeat = setInterval(() => {
        const now = new Date();
        utimes(ownerPath, now, now).catch(() => {});
    }, OWNER_HEARTBEAT_MS);
    heartbeat.unref?.();
    return heartbeat;
}

/**
 * Executes a mutation under both local and cross-process locks.
 *
 * @template T
 * @param {string} target
 * @param {string} baseDirectory
 * @param {StorageAnchor} anchor
 * @param {{lockWaitMs: number, lockPollMs: number}} options
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
async function withWriteLock(target, baseDirectory, anchor, options, operation) {
    return withLocalWriteLock(target, async () => {
        await verifyStorageAnchor(baseDirectory, anchor);
        const lock = await acquireFileLock(target, anchor, options);
        let operationError;
        let result;
        try {
            result = await operation();
        } catch (error) {
            operationError = error;
        }
        try {
            await releaseFileLock(lock);
        } catch (releaseError) {
            if (!operationError) {
                throw releaseError;
            }
            operationError.lockReleaseError = releaseError.toJSON?.() ?? {
                code: releaseError.code,
                message: releaseError.message,
            };
        }
        if (operationError) {
            throw operationError;
        }
        return result;
    });
}

/**
 * Opens and reads a regular contained file without following replacement races.
 *
 * @param {string} target
 * @param {string} expectedId
 * @param {StorageAnchor} anchor
 * @returns {Promise<string>}
 */
async function readSafeFile(target, expectedId, anchor) {
    let before;
    try {
        const resolvedTarget = await realpath(target);
        if (path.dirname(resolvedTarget) !== anchor.realBase) {
            throw storageError("artifact_unsafe", `Plan ${expectedId} resolved outside Foundry storage`, {
                details: { id: expectedId, resolvedTarget },
            });
        }
        before = await lstat(target);
    } catch (error) {
        if (error instanceof FoundryStorageError) {
            throw error;
        }
        if (isMissing(error)) {
            throw storageError("plan_not_found", `Plan ${expectedId} does not exist`, {
                details: { id: expectedId },
                cause: error,
            });
        }
        throw storageError("artifact_unreadable", `Plan ${expectedId} could not be inspected`, {
            details: { id: expectedId, filesystemCode: error?.code ?? null },
            cause: error,
        });
    }
    if (before.isSymbolicLink() || !before.isFile()) {
        throw storageError("artifact_unsafe", `Plan ${expectedId} must be a regular file, not a symlink`, {
            details: { id: expectedId },
        });
    }

    let handle;
    try {
        handle = await open(target, "r");
        const after = await handle.stat();
        if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) {
            throw storageError("artifact_changed", `Plan ${expectedId} changed while it was being opened`, {
                details: { id: expectedId },
            });
        }
        return await handle.readFile("utf8");
    } catch (error) {
        if (error instanceof FoundryStorageError) {
            throw error;
        }
        throw storageError("artifact_unreadable", `Plan ${expectedId} could not be read`, {
            details: { id: expectedId, filesystemCode: error?.code ?? null },
            cause: error,
        });
    } finally {
        if (handle) {
            await handle.close();
        }
    }
}

/**
 * Parses and validates one captured plan payload.
 *
 * @param {string} source
 * @param {string} expectedId
 * @returns {any}
 */
function parsePlanSource(source, expectedId) {
    let plan;
    try {
        plan = JSON.parse(source);
    } catch (error) {
        throw storageError("artifact_invalid", `Plan ${expectedId} contains invalid JSON`, {
            details: { id: expectedId },
            cause: error,
        });
    }

    try {
        validatePlan(plan);
    } catch (error) {
        throw storageError("artifact_invalid", `Plan ${expectedId} failed schema validation`, {
            details: {
                id: expectedId,
                validationCode: error?.code ?? null,
                validationPath: error?.path ?? null,
                validationMessage: error?.message ?? String(error),
            },
            cause: error,
        });
    }
    if (plan.id !== expectedId) {
        throw storageError("artifact_identity_mismatch", `Plan file ${expectedId}.json declares id ${plan.id}`, {
            details: { expectedId, actualId: plan.id },
        });
    }
	return plan;
}

/**
 * Reads, parses, validates, and fingerprints one plan artifact.
 *
 * @param {string} target
 * @param {string} expectedId
 * @param {StorageAnchor} anchor
 * @returns {Promise<{plan: any, fingerprint: string}>}
 */
async function readPlanAt(target, expectedId, anchor) {
    const source = await readSafeFile(target, expectedId, anchor);
	const plan = parsePlanSource(source, expectedId);
    return {
        plan,
        fingerprint: fingerprint(source),
    };
}

/**
 * Takes an owned snapshot or translates clone failures into storage errors.
 *
 * @template T
 * @param {T} value
 * @param {string} errorCode
 * @param {string} message
 * @returns {T}
 */
function ownSnapshot(value, errorCode, message) {
    try {
        return structuredClone(value);
    } catch (error) {
        throw storageError(errorCode, message, {
            details: { serializationMessage: error?.message ?? String(error) },
            cause: error,
        });
    }
}

/**
 * Serializes and reparses a plan before full domain validation.
 *
 * @param {object} value
 * @param {string} errorCode
 * @param {string} message
 * @returns {{payload: string, plan: any}}
 */
function serializeValidatedPlan(value, errorCode, message) {
    let payload;
    let plan;
    try {
        payload = `${JSON.stringify(value, null, 2)}\n`;
        plan = JSON.parse(payload);
    } catch (error) {
        throw storageError(errorCode, message, {
            details: { serializationMessage: error?.message ?? String(error) },
            cause: error,
        });
    }
    try {
        validatePlan(plan);
    } catch (error) {
        throw storageError(errorCode, message, {
            details: {
                validationCode: error?.code ?? null,
                validationPath: error?.path ?? null,
                validationMessage: error?.message ?? String(error),
            },
            cause: error,
        });
    }
    return { payload, plan };
}

/**
 * Writes and fsyncs a sibling temporary file inside the anchored directory.
 *
 * @param {string} baseDirectory
 * @param {string} target
 * @param {string} payload
 * @param {StorageAnchor} anchor
 * @returns {Promise<string>} Temporary file path.
 */
async function writeTemporaryFile(baseDirectory, target, payload, anchor) {
    const temporary = path.join(
        baseDirectory,
        `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle;
    let created = false;
    try {
        handle = await open(temporary, "wx", 0o600);
        created = true;
        const resolvedTemporary = await realpath(temporary);
        if (path.dirname(resolvedTemporary) !== anchor.realBase) {
            throw storageError("path_outside_workspace", "Foundry temporary file escaped the storage directory", {
                details: { temporary: resolvedTemporary },
            });
        }
        await verifyStorageAnchor(baseDirectory, anchor);
        await handle.writeFile(payload, "utf8");
        await handle.sync();
        await handle.close();
        handle = null;
        return temporary;
    } catch (error) {
        if (handle) {
            try {
                await handle.close();
            } catch {
                // Cleanup below remains best effort after the write failure.
            }
        }
        if (created) {
            try {
                await unlink(temporary);
            } catch (cleanupError) {
                if (!isMissing(cleanupError)) {
                    throw storageError("temporary_file_cleanup_failed", "Foundry could not clean up a failed write", {
                        details: {
                            temporary,
                            writeError: error?.message ?? String(error),
                            cleanupFilesystemCode: cleanupError?.code ?? null,
                        },
                        cause: cleanupError,
                    });
                }
            }
        }
        if (error instanceof FoundryStorageError) {
            throw error;
        }
        throw storageError("temporary_write_failed", "Foundry could not write the candidate plan", {
            details: { temporary, filesystemCode: error?.code ?? null },
            cause: error,
        });
    }
}

/**
 * Retries transient cross-platform rename failures with bounded backoff.
 *
 * @param {string} source
 * @param {string} target
 * @returns {Promise<void>}
 */
async function retryRename(source, target) {
    const retryable = new Set(["EACCES", "EBUSY", "EPERM"]);
    let lastError;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            await rename(source, target);
            return;
        } catch (error) {
            lastError = error;
            if (!retryable.has(error?.code) || attempt === 4) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 10 * (2 ** attempt)));
        }
    }
    throw lastError;
}

/**
 * Creates a new plan without replacing an existing artifact.
 *
 * @param {string} baseDirectory
 * @param {string} target
 * @param {{payload: string, plan: any}} persisted
 * @param {StorageAnchor} anchor
 * @returns {Promise<void>}
 */
async function atomicCreate(baseDirectory, target, persisted, anchor) {
    const temporary = await writeTemporaryFile(baseDirectory, target, persisted.payload, anchor);
    try {
        await verifyStorageAnchor(baseDirectory, anchor);
        await link(temporary, target);
    } catch (error) {
        try {
            await unlink(temporary);
        } catch {
            // Preserve the creation error; the hidden temporary file is never authoritative.
        }
        if (error?.code === "EEXIST") {
            throw storageError("plan_exists", `Plan ${persisted.plan.id} already exists`, {
                details: { id: persisted.plan.id },
                cause: error,
            });
        }
        if (error instanceof FoundryStorageError) {
            throw error;
        }
        throw storageError("artifact_create_failed", `Plan ${persisted.plan.id} could not be created`, {
            details: { id: persisted.plan.id, filesystemCode: error?.code ?? null },
            cause: error,
        });
    }
    try {
        await unlink(temporary);
    } catch (error) {
        if (!isMissing(error)) {
            throw storageError("temporary_file_cleanup_failed", "Foundry created the plan but could not remove its temporary link", {
                details: { temporary, committed: true },
                cause: error,
            });
        }
    }
}

/**
 * Replaces a plan only after rechecking the expected current artifact.
 *
 * @param {string} baseDirectory
 * @param {string} target
 * @param {{payload: string, plan: any}} persisted
 * @param {StorageAnchor} anchor
 * @param {() => Promise<void>} verifyCurrent
 * @returns {Promise<void>}
 */
async function atomicReplace(baseDirectory, target, persisted, anchor, verifyCurrent) {
    const temporary = await writeTemporaryFile(baseDirectory, target, persisted.payload, anchor);
    try {
        await verifyCurrent();
        await verifyStorageAnchor(baseDirectory, anchor);
        await retryRename(temporary, target);
    } catch (error) {
        try {
            await unlink(temporary);
        } catch {
            // Preserve the original replacement error.
        }
        if (error instanceof FoundryStorageError) {
            throw error;
        }
        throw storageError("artifact_replace_failed", `Plan ${persisted.plan.id} could not be replaced`, {
            details: { id: persisted.plan.id, filesystemCode: error?.code ?? null },
            cause: error,
        });
    }
}

/**
 * Atomically replaces a non-plan session marker payload.
 *
 * @param {string} baseDirectory
 * @param {string} target
 * @param {string} payload
 * @param {StorageAnchor} anchor
 * @returns {Promise<void>}
 */
async function atomicReplacePayload(baseDirectory, target, payload, anchor) {
    const temporary = await writeTemporaryFile(baseDirectory, target, payload, anchor);
    try {
        await verifyStorageAnchor(baseDirectory, anchor);
        await retryRename(temporary, target);
    } catch (error) {
        try {
            await unlink(temporary);
        } catch {
            // Preserve the replacement error.
        }
        if (error instanceof FoundryStorageError) {
            throw error;
        }
        throw storageError("artifact_replace_failed", "Foundry could not replace the session marker", {
            details: { filesystemCode: error?.code ?? null },
            cause: error,
        });
    }
}

/**
 * Builds a bounded list projection without exposing the full plan document.
 *
 * @param {any} plan
 * @returns {any}
 */
function summaryForList(plan) {
    const summary = summarizePlan(plan);
    return {
        ...summary,
        objective: summary.objective.length > 240
            ? `${summary.objective.slice(0, 237)}...`
            : summary.objective,
    };
}

/**
 * Creates a session-scoped plan and activation-marker store.
 *
 * @param {PlanStoreOptions} options
 * @returns {Readonly<PlanStore>}
 */
export function createPlanStore(options = {}) {
    const workspacePath = validateWorkspacePath(options.workspacePath);
    const clock = options.clock ?? (() => new Date());
    if (typeof clock !== "function") {
        throw storageError("invalid_clock", "clock must be a function");
    }
    const lockWaitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
    const lockPollMs = options.lockPollMs ?? DEFAULT_LOCK_POLL_MS;
    if (!Number.isSafeInteger(lockWaitMs) || lockWaitMs < 1
        || !Number.isSafeInteger(lockPollMs) || lockPollMs < 1) {
        throw storageError("invalid_lock_options", "lockWaitMs and lockPollMs must be positive integers");
    }
    const lockOptions = { lockWaitMs, lockPollMs };

    const baseDirectory = path.resolve(workspacePath, "files", "foundry");
    const filesRoot = path.resolve(workspacePath, "files");
    if (baseDirectory !== path.join(filesRoot, "foundry")) {
        throw storageError("path_outside_workspace", "Foundry storage must remain under workspacePath/files");
    }
    /**
     * Reads and clones one validated plan.
     *
     * @param {string} id
     * @returns {Promise<any>}
     */
    const read = async (id) => {
        const target = planTarget(baseDirectory, id);
        const anchor = await ensureStorageDirectory(workspacePath, filesRoot, baseDirectory);
        return clone((await readPlanAt(target, id, anchor)).plan);
    };

    /**
     * Creates a revision-one draft without replacing existing data.
     *
     * @param {any} plan
     * @param {0} [expectedRevision]
     * @returns {Promise<any>}
     */
    const create = async (plan, expectedRevision = undefined) => {
        if (expectedRevision !== 0) {
            throw storageError("invalid_expected_revision", "Creating a plan requires expectedRevision 0", {
                details: { expectedRevision },
            });
        }
        const snapshot = ownSnapshot(plan, "invalid_new_plan", "The new plan is not serializable");
        const persisted = serializeValidatedPlan(
            snapshot,
            "invalid_new_plan",
            "The serialized new plan failed validation",
        );
        if (persisted.plan.revision !== 1 || persisted.plan.status !== PLAN_STATUS.DRAFT) {
            throw storageError("invalid_new_plan", "A new plan must be a draft at revision 1", {
                details: {
                    revision: persisted.plan.revision,
                    status: persisted.plan.status,
                },
            });
        }
        const target = planTarget(baseDirectory, persisted.plan.id);
        const anchor = await ensureStorageDirectory(workspacePath, filesRoot, baseDirectory);
        return withWriteLock(target, baseDirectory, anchor, lockOptions, async () => {
            try {
                const existing = (await readPlanAt(target, persisted.plan.id, anchor)).plan;
                throw storageError("plan_exists", `Plan ${persisted.plan.id} already exists`, {
                    details: {
                        id: persisted.plan.id,
                        latestRevision: existing.revision,
                    },
                });
            } catch (error) {
                if (error?.code !== "plan_not_found") {
                    throw error;
                }
            }
            await atomicCreate(baseDirectory, target, persisted, anchor);
            return clone(persisted.plan);
        });
    };

    /**
     * Validates and atomically writes the next revision of a plan.
     *
     * @param {string} id
     * @param {number} expectedRevision
     * @param {any} candidate
     * @returns {Promise<any>}
     */
    const update = async (id, expectedRevision, candidate) => {
        validateExpectedRevision(expectedRevision);
        const target = planTarget(baseDirectory, id);
        const anchor = await ensureStorageDirectory(workspacePath, filesRoot, baseDirectory);
        return withWriteLock(target, baseDirectory, anchor, lockOptions, async () => {
            const initial = await readPlanAt(target, id, anchor);
            const current = initial.plan;
            if (current.revision !== expectedRevision) {
                throw storageError("revision_conflict", `Plan ${id} has changed`, {
                    details: {
                        id,
                        expectedRevision,
                        latestRevision: current.revision,
                    },
                });
            }

            const snapshot = ownSnapshot(
                candidate,
                "candidate_invalid",
                `Updated plan ${id} is not serializable`,
            );
            snapshot.revision = current.revision + 1;
            snapshot.updatedAt = resolveTimestamp(clock);
            const persisted = serializeValidatedPlan(
                snapshot,
                "candidate_invalid",
                `Serialized plan ${id} failed validation`,
            );
            if (persisted.plan.id !== current.id
                || persisted.plan.createdAt !== current.createdAt) {
                throw storageError(
                    "immutable_plan_identity",
					"An update cannot change id or createdAt",
                    { details: { id } },
                );
            }

            await atomicReplace(baseDirectory, target, persisted, anchor, async () => {
                const latest = await readPlanAt(target, id, anchor);
                if (latest.fingerprint === initial.fingerprint) {
                    return;
                }
                if (latest.plan.revision !== expectedRevision) {
                    throw storageError("revision_conflict", `Plan ${id} changed during the update`, {
                        details: {
                            id,
                            expectedRevision,
                            latestRevision: latest.plan.revision,
                        },
                    });
                }
                throw storageError("artifact_changed", `Plan ${id} changed during the update`, {
                    details: { id, expectedRevision },
                });
            });
            return clone(persisted.plan);
        });
    };

	/**
	 * Moves one unreadable regular plan artifact aside after an attributed request.
	 *
	 * @param {string} id
	 * @param {{reason: string, requestedBy: string}} quarantineOptions
	 * @returns {Promise<{
	 *   planId: string,
	 *   quarantineFile: string,
	 *   reason: string,
	 *   requestedBy: string,
	 *   quarantinedAt: string
	 * }>}
	 */
	const quarantineInvalidPlan = async (id, quarantineOptions) => {
		assertPlanId(id);
		const reason = String(quarantineOptions?.reason ?? "").trim();
		const requestedBy = String(quarantineOptions?.requestedBy ?? "").trim();
		if (!reason || !requestedBy) {
			throw storageError(
				"invalid_quarantine_request",
				"Quarantining a plan requires reason and requestedBy",
				{ details: { id } },
			);
		}
		const target = planTarget(baseDirectory, id);
		const anchor = await ensureStorageDirectory(workspacePath, filesRoot, baseDirectory);
		return withWriteLock(target, baseDirectory, anchor, lockOptions, async () => {
			const source = await readSafeFile(target, id, anchor);
			let invalidError = null;
			try {
				parsePlanSource(source, id);
			} catch (error) {
				if (!["artifact_invalid", "artifact_identity_mismatch"].includes(error?.code)) {
					throw error;
				}
				invalidError = error;
			}
			if (invalidError === null) {
				throw storageError(
					"artifact_valid",
					`Plan ${id} is valid and cannot be quarantined`,
					{ details: { id } },
				);
			}

			const quarantinedAt = resolveTimestamp(clock);
			const token = `${Date.now()}.${randomUUID()}`;
			const quarantineFile = `.${id}.invalid.${token}.json`;
			const quarantineTarget = path.join(baseDirectory, quarantineFile);
			try {
				await verifyStorageAnchor(baseDirectory, anchor);
				await rename(target, quarantineTarget);
			} catch (error) {
				throw storageError(
					"artifact_quarantine_failed",
					`Plan ${id} could not be moved into quarantine`,
					{
						details: {
							id,
							quarantineFile,
							causeCode: error?.code ?? null,
						},
						cause: error,
					},
				);
			}
			return {
				planId: id,
				quarantineFile,
				reason,
				requestedBy,
				quarantinedAt,
			};
		});
	};

    /**
     * Lists bounded valid summaries and separately reports invalid artifacts.
     *
     * @param {{limit?: number}} [listOptions]
     * @returns {Promise<{plans: object[], invalid: object[], truncated: boolean}>}
     */
    const list = async (listOptions = {}) => {
        const limit = listOptions.limit ?? DEFAULT_LIST_LIMIT;
        validateLimit(limit);
        const anchor = await ensureStorageDirectory(workspacePath, filesRoot, baseDirectory);
        let entries;
        try {
            entries = await readdir(baseDirectory, { withFileTypes: true });
        } catch (error) {
            if (error?.code === "ENOENT") {
                return { plans: [], invalid: [], truncated: false };
            }
            throw storageError("artifact_directory_unreadable", "Foundry plan directory could not be read", {
                details: { filesystemCode: error?.code ?? null },
                cause: error,
            });
        }

        const filenames = entries
            .filter((entry) => !entry.name.startsWith(".") && entry.name.endsWith(".json"))
            .map((entry) => entry.name)
            .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
        const selected = filenames.slice(0, limit);
        const plans = [];
        const invalid = [];

        for (const filename of selected) {
            const id = filename.slice(0, -".json".length);
            try {
                assertPlanId(id);
                const plan = (await readPlanAt(path.join(baseDirectory, filename), id, anchor)).plan;
                plans.push(summaryForList(plan));
            } catch (error) {
                invalid.push({
                    filename,
                    code: error?.code ?? "artifact_invalid",
                    message: error?.message ?? String(error),
					details: error?.details ?? null,
                });
            }
        }

        return {
            plans,
            invalid,
            truncated: filenames.length > selected.length,
        };
    };

    const activationTarget = path.join(baseDirectory, ".active-plan.json");

    /**
     * Reads and validates the optional session-local activation marker.
     *
     * @param {StorageAnchor} anchor
     * @returns {Promise<{planId: string, activatedAt: string} | null>}
     */
    const readActivationMarker = async (anchor) => {
        let source;
        try {
            source = await readSafeFile(activationTarget, "active-plan", anchor);
        } catch (error) {
            if (error?.code === "plan_not_found") {
                return null;
            }
            throw error;
        }
        let marker;
        try {
            marker = JSON.parse(source);
        } catch (error) {
            throw storageError("activation_invalid", "Foundry activation marker contains invalid JSON", {
                cause: error,
            });
        }
        const keys = Object.keys(marker ?? {}).sort();
		if (keys.join(",") !== "activatedAt,planId"
            || typeof marker.planId !== "string"
            || typeof marker.activatedAt !== "string") {
            throw storageError("activation_invalid", "Foundry activation marker failed validation");
        }
        assertPlanId(marker.planId, "planId");
        /** @type {string | null} */
        let canonicalTimestamp = null;
        try {
            canonicalTimestamp = new Date(marker.activatedAt).toISOString();
        } catch {
            canonicalTimestamp = null;
        }
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(marker.activatedAt)
            || canonicalTimestamp !== marker.activatedAt) {
            throw storageError("activation_invalid", "Foundry activation timestamp is invalid");
        }
        return marker;
    };

    /**
     * Activates one exact plan revision for coordinator hooks.
     *
     * @param {string} planId
     * @param {number} expectedRevision
     * @returns {Promise<object>}
     */
    const activate = async (planId, expectedRevision) => {
        validateExpectedRevision(expectedRevision);
        const anchor = await ensureStorageDirectory(workspacePath, filesRoot, baseDirectory);
        const target = planTarget(baseDirectory, planId);
        return withWriteLock(
            target,
            baseDirectory,
            anchor,
            lockOptions,
            async () => {
                const plan = (await readPlanAt(target, planId, anchor)).plan;
                if (plan.revision !== expectedRevision) {
                    throw storageError("revision_conflict", `Plan ${planId} has changed`, {
                        details: { planId, expectedRevision, latestRevision: plan.revision },
                    });
                }
                const marker = {
                    planId,
                    activatedAt: resolveTimestamp(clock),
                };
                await withWriteLock(
                    activationTarget,
                    baseDirectory,
                    anchor,
                    lockOptions,
                    () => atomicReplacePayload(
                        baseDirectory,
                        activationTarget,
                        `${JSON.stringify(marker, null, 2)}\n`,
                        anchor,
                    ),
                );
                return marker;
            },
        );
    };

    /**
     * Reads the activation marker and its current validated plan.
     *
     * @returns {Promise<object | null>}
     */
    const getActive = async () => {
        const anchor = await ensureStorageDirectory(workspacePath, filesRoot, baseDirectory);
        const marker = await readActivationMarker(anchor);
        if (!marker) {
            return null;
        }
        const plan = (await readPlanAt(
            planTarget(baseDirectory, marker.planId),
            marker.planId,
            anchor,
        )).plan;
        return { ...marker, plan };
    };

    /**
     * Removes the activation marker under its own write lock.
     *
     * @returns {Promise<{deactivated: boolean, planId: string | null, repaired: boolean}>}
     */
    const deactivate = async () => {
        const anchor = await ensureStorageDirectory(workspacePath, filesRoot, baseDirectory);
        return withWriteLock(
            activationTarget,
            baseDirectory,
            anchor,
            lockOptions,
            async () => {
				/** @type {{planId: string, activatedAt: string} | null} */
				let marker = null;
				let repaired = false;
				try {
					marker = await readActivationMarker(anchor);
				} catch {
					repaired = true;
				}
				if (!marker && !repaired) {
					return { deactivated: false, planId: null, repaired: false };
                }
                try {
                    await verifyStorageAnchor(baseDirectory, anchor);
                    await unlink(activationTarget);
                } catch (error) {
                    throw storageError("activation_remove_failed", "Foundry could not remove the activation marker", {
                        details: { filesystemCode: error?.code ?? null },
                        cause: error,
                    });
                }
				return {
					deactivated: true,
					planId: marker?.planId ?? null,
					repaired,
				};
            },
        );
    };

    /**
     * Reclaims owner files only when process and heartbeat evidence are stale.
     *
     * @param {{staleMs?: number, beforeReclaim?: (lockPath: string) => Promise<void>}} [recoverOptions]
     * @returns {Promise<{recovered: string[], skipped: object[]}>}
     */
    const recoverStaleLocks = async (recoverOptions = {}) => {
        const staleMs = recoverOptions.staleMs ?? 30_000;
        if (!Number.isSafeInteger(staleMs) || staleMs < 1) {
            throw storageError("invalid_lock_options", "staleMs must be a positive integer");
        }
        const anchor = await ensureStorageDirectory(workspacePath, filesRoot, baseDirectory);
        const barrierPath = path.join(baseDirectory, RECOVERY_BARRIER_NAME);
        const barrier = await acquireRecoveryBarrier(barrierPath, staleMs);
        if (!barrier) {
            return {
                recovered: [],
                skipped: [{ lock: RECOVERY_BARRIER_NAME, reason: "recovery-in-progress" }],
            };
        }
        const recovered = [];
        const skipped = [];
        try {
            const entries = await readdir(baseDirectory, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isFile()
                    || !entry.name.endsWith(".lock")
                    || entry.name === RECOVERY_BARRIER_NAME) {
                    continue;
                }
                const lockPath = path.join(baseDirectory, entry.name);
                try {
                    const resolved = await realpath(lockPath);
                    if (path.dirname(resolved) !== anchor.realBase) {
                        skipped.push({ lock: entry.name, reason: "outside-storage" });
                        continue;
                    }
                    const metadata = await lstat(lockPath);
                    if (metadata.isSymbolicLink() || metadata.size > 4_096) {
                        skipped.push({ lock: entry.name, reason: "invalid-lock-file" });
                        continue;
                    }
                    const source = await readFile(lockPath, "utf8");
                    const payload = JSON.parse(source);
                    const createdAt = Date.parse(payload.createdAt);
                    const pid = Number(payload.pid);
                    if (!Number.isSafeInteger(pid)
                        || pid < 1
                        || !Number.isFinite(createdAt)) {
                        skipped.push({ lock: entry.name, reason: "invalid-lock-metadata" });
                        continue;
                    }
                    if (ownerIsActive(payload, metadata, staleMs)) {
                        skipped.push({ lock: entry.name, reason: "owner-alive" });
                        continue;
                    }
                    if (typeof recoverOptions.beforeReclaim === "function") {
                        await recoverOptions.beforeReclaim(lockPath);
                    }
                    await verifyStorageAnchor(baseDirectory, anchor);
                    if (await removeRecoverableOwnerFile(lockPath, staleMs)) {
                        recovered.push(entry.name);
                    } else {
                        skipped.push({ lock: entry.name, reason: "lock-active-or-changed" });
                    }
                } catch (error) {
                    if (!isMissing(error)) {
                        skipped.push({
                            lock: entry.name,
                            reason: error?.code ?? "unreadable-lock",
                        });
                    }
                }
            }
        } finally {
            clearInterval(barrier.heartbeat);
            await barrier.handle.close();
            try {
                const persistedBarrier = JSON.parse(await readFile(barrierPath, "utf8"));
                if (persistedBarrier.token !== barrier.token) {
                    throw storageError("lock_compromised", "Foundry recovery barrier ownership changed");
                }
                await unlink(barrierPath);
            } catch (error) {
                if (!isMissing(error)) {
                    throw error;
                }
            }
        }
        return { recovered, skipped };
    };

    return Object.freeze({
        create,
        read,
        update,
		quarantineInvalidPlan,
        list,
        activate,
        getActive,
        deactivate,
        recoverStaleLocks,
        directory: baseDirectory,
    });
}
