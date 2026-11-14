import {
	closeSync,
	constants,
	lstatSync,
	mkdirSync,
	openSync,
	realpathSync,
} from "node:fs";
import path from "node:path";
import { errorCode } from "../data.mjs";
import { sqliteError, storageError } from "./errors.mjs";

/**
 * @typedef {object} PlanStoreOptions
 * @property {string} [workspacePath]
 * @property {() => Date|string|number} [clock]
 * @property {number} [busyTimeoutMs]
 */
/** @typedef {{realBase: string, device: number, inode: number}} StorageAnchor */

const DATABASE_NAME = "foundry.sqlite";

const DATABASE_FILES = new Set([
	DATABASE_NAME,
	`${DATABASE_NAME}-journal`,
	`${DATABASE_NAME}-wal`,
	`${DATABASE_NAME}-shm`,
]);

/** @type {typeof import("node:sqlite")} */
let sqlite;

try {
	const [major, minor] = process.versions.node.split(".").map(Number);
	if (major < 22 || (major === 22 && minor < 13)) {
		throw new Error("Node.js is older than 22.13");
	}
	sqlite = await import("node:sqlite");
	if (typeof sqlite.DatabaseSync !== "function") {
		throw new Error("DatabaseSync is unavailable");
	}
} catch (cause) {
	throw storageError(
		"sqlite_unavailable",
		"Foundry requires Node.js 22.13+ with built-in node:sqlite enabled; upgrade the extension host or enable SQLite",
		{ cause },
	);
}

export const sqliteConstants = sqlite.constants;

/** @param {unknown} workspacePath */
function validateWorkspacePath(workspacePath) {
	if (typeof workspacePath !== "string" || workspacePath.trim().length === 0) {
		throw storageError("workspace_unavailable", "Foundry requires the current Copilot session workspacePath");
	}
	if (!path.isAbsolute(workspacePath)) {
		throw storageError("invalid_workspace_path", "workspacePath must be absolute");
	}
	return path.resolve(workspacePath);
}

/** @param {string} pathname */
function inspect(pathname) {
	try {
		return lstatSync(pathname);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return null;
		throw storageError("artifact_unreadable", "Foundry could not inspect a storage path", {
			details: { pathname, filesystemCode: errorCode(error) ?? null },
			cause: error,
		});
	}
}

/** @param {string} pathname @param {boolean} create */
function requireDirectory(pathname, create) {
	let metadata = inspect(pathname);
	if (!metadata && create) {
		try {
			mkdirSync(pathname, { mode: 0o700 });
		} catch (error) {
			if (errorCode(error) !== "EEXIST") {
				throw storageError("artifact_directory_unreadable", "Foundry could not create its storage directory", {
					details: { pathname, filesystemCode: errorCode(error) ?? null },
					cause: error,
				});
			}
		}
		metadata = inspect(pathname);
	}
	if (!metadata || metadata.isSymbolicLink() || !metadata.isDirectory()) {
		throw storageError("path_outside_workspace", "Foundry storage paths must be real directories, not symlinks", {
			details: { pathname },
		});
	}
	return metadata;
}

/** @param {string} workspacePath @param {string[]} parts @param {StorageAnchor|undefined} anchor */
function ensureDirectory(workspacePath, parts, anchor) {
	requireDirectory(workspacePath, false);
	let directory = workspacePath;
	for (const part of parts) {
		directory = path.join(directory, part);
		requireDirectory(directory, !anchor);
	}
	const metadata = requireDirectory(directory, false);
	const realBase = realpathSync(directory);
	if (path.relative(realpathSync(workspacePath), realBase) !== path.join(...parts)
		|| (anchor && (realBase !== anchor.realBase
			|| metadata.dev !== anchor.device || metadata.ino !== anchor.inode))) {
		throw storageError("path_outside_workspace", "Foundry storage moved or resolved outside the session workspace");
	}
	return { realBase, device: metadata.dev, inode: metadata.ino };
}

/** @param {string} pathname @param {StorageAnchor} anchor */
function requireRegularFile(pathname, anchor) {
	const metadata = inspect(pathname);
	if (!metadata) return null;
	if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
		throw storageError("artifact_unsafe", "Foundry artifacts must be contained regular files without links", {
			details: { pathname },
		});
	}
	let resolved;
	try {
		resolved = realpathSync(pathname);
	} catch (error) {
		// SQLite can remove a completed journal between these inspections.
		if (errorCode(error) === "ENOENT") return null;
		throw error;
	}
	if (path.dirname(resolved) !== anchor.realBase) {
		throw storageError("artifact_unsafe", "A Foundry artifact resolved outside storage", {
			details: { pathname },
		});
	}
	return metadata;
}

/**
 * Database work and mutation callbacks are synchronous; no transaction crosses
 * an await. Async methods expose owned documents, never a database connection.
 *
 * Shared private-artifact SQLite safety and transaction boundary. Schema owners
 * supply initialization; no database connection escapes a synchronous callback.
 *
 * @param {PlanStoreOptions & {
 *   directoryParts?: string[],
 *   initialize: (db: import("node:sqlite").DatabaseSync) => void,
 *   schemaVersion: number
 * }} options
 */
export function createArtifactDatabase(options) {
	const workspacePath = validateWorkspacePath(options.workspacePath);
	const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
	if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 2_147_483_647) {
		throw storageError("invalid_storage_options", "busyTimeoutMs must be a positive bounded integer");
	}
	const parts = options.directoryParts ?? ["files", "foundry"];
	if (!Array.isArray(parts) || parts.length < 1
		|| parts.some((part) => typeof part !== "string" || !/^[a-zA-Z0-9._-]+$/.test(part)
			|| part === "." || part === "..")) {
		throw storageError("invalid_storage_options", "Storage directory parts must be contained simple names");
	}
	const directory = path.join(workspacePath, ...parts);
	const databasePath = path.join(directory, DATABASE_NAME);
	/** @type {StorageAnchor|undefined} */
	let anchor;
	/** @type {{dev: number, ino: number}|undefined} */
	let databaseIdentity;
	let running = false;

	const verifyFiles = () => {
		anchor = ensureDirectory(workspacePath, parts, anchor);
		const database = requireRegularFile(databasePath, anchor);
		if (!database || (databaseIdentity
			&& (database.dev !== databaseIdentity.dev || database.ino !== databaseIdentity.ino))) {
			throw storageError("artifact_changed", "The Foundry database was removed or replaced");
		}
		for (const filename of DATABASE_FILES) {
			if (filename !== DATABASE_NAME) requireRegularFile(path.join(directory, filename), anchor);
		}
		databaseIdentity = { dev: database.dev, ino: database.ino };
	};

	/**
	 * @template T
	 * @param {(db: import("node:sqlite").DatabaseSync) => T} operation
	 * @param {{write?: boolean}} [settings]
	 * @returns {T}
	 */
	const transaction = (operation, settings = {}) => {
		if (running) throw storageError("storage_reentrant", "A storage mutation cannot call the same store recursively");
		running = true;
		/** @type {import("node:sqlite").DatabaseSync|undefined} */
		let db;
		let begun = false;
		try {
			anchor = ensureDirectory(workspacePath, parts, anchor);
			if (!inspect(databasePath) && !databaseIdentity) {
				for (const filename of DATABASE_FILES) {
					if (filename !== DATABASE_NAME && inspect(path.join(directory, filename))
						&& !inspect(databasePath)) {
						throw storageError("artifact_unsafe", "SQLite sidecars exist without their Foundry database");
					}
				}
				try {
					closeSync(openSync(databasePath,
						constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
				} catch (error) {
					if (errorCode(error) !== "EEXIST") throw error;
				}
			}
			verifyFiles();
			db = new sqlite.DatabaseSync(databasePath);
			db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}; PRAGMA synchronous = FULL; PRAGMA trusted_schema = OFF;`);
			if (db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete") {
				throw storageError("database_journal_mode", "Foundry storage requires SQLite DELETE journal mode");
			}
			const initialized = db.prepare("PRAGMA user_version").get()?.user_version === options.schemaVersion;
			db.exec(settings.write || !initialized ? "BEGIN IMMEDIATE" : "BEGIN");
			begun = true;
			options.initialize(db);
			verifyFiles();
			const result = operation(db);
			if (result && (typeof result === "object" || typeof result === "function")
				&& "then" in result && typeof result.then === "function") {
				Promise.resolve(result).catch(() => { });
				throw storageError("invalid_mutation", "SQLite callbacks must be synchronous");
			}
			verifyFiles();
			db.exec("COMMIT");
			begun = false;
			return result;
		} catch (error) {
			if (begun && db) {
				try {
					db.exec("ROLLBACK");
				} catch (rollbackError) {
					throw storageError("rollback_failed", "Foundry could not roll back its failed transaction", {
						cause: new AggregateError([error, rollbackError]),
					});
				}
			}
			throw sqliteError(error);
		} finally {
			try {
				db?.close();
			} finally {
				running = false;
			}
		}
	};
	return Object.freeze({ transaction, directory, databasePath, verifyFiles });
}
