/**
 * @module sessions
 *
 * Disposal of the Copilot sessions a conveyor run creates. Every subagent is a full `copilot`
 * session: a `$COPILOT_HOME/session-state/<id>/` directory plus rows in `session-store.db`, which
 * is what the `--resume` picker lists. A fan-out therefore leaves dozens of dead sessions behind
 * per run even though nothing reads them afterwards — the durable record of an agent is the run's
 * own `journal.jsonl` / `progress.jsonl`, and AIC accounting reads the child log while the agent is
 * still running (see `agent.mjs`).
 *
 * Removal mirrors worktree disposal (`worktree.mjs`): clean runs leave no trace, anything that
 * failed is preserved for inspection. Set `CONVEYOR_KEEP_SESSIONS=1` to keep every child session.
 */
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** SQLite variable limit is far higher, but chunking keeps statements small and predictable. */
const PURGE_CHUNK = 250;

/** @returns {string} `$COPILOT_HOME` or `~/.copilot`. */
export const copilotHome = () => process.env.COPILOT_HOME || join(homedir(), ".copilot");

/** @param {string} id @returns {string} the session's state directory (not checked for existence). */
export const sessionStateDir = (id) => join(copilotHome(), "session-state", id);

/** @returns {string} the local session store the `--resume` picker reads. */
export const sessionStorePath = () => join(copilotHome(), "session-store.db");

/** @returns {boolean} true when the user opted out of child-session disposal. */
export const keepSessions = () => process.env.CONVEYOR_KEEP_SESSIONS === "1";

/**
 * A session id is used as a single path segment under `session-state/`, so it must not be able to
 * escape it. Deliberately not UUID-shaped: the CLI accepts any id it wrote.
 * @param {unknown} id
 * @returns {id is string}
 */
export function isSafeSessionId(id) {
	return typeof id === "string" && id.length > 0 && id.length <= 255 && id !== "." && id !== ".." && !/[\\/\u0000-\u001f\u007f]/.test(id);
}

/**
 * Delete child sessions: their state directories, then their rows in the local session store (so
 * the resume picker does not keep listing ghosts). Best-effort and never throws — cleanup runs
 * while a run is finalizing, and a locked store or a vanished directory must not fail the run.
 * @param {Iterable<string>} ids
 * @param {{ purgeStore?: boolean }} [opts]
 * @returns {Promise<{ deleted: string[], skipped: string[], purgedRows: number, warnings: string[] }>}
 */
export async function deleteSessions(ids, opts = {}) {
	const warnings = [];
	const deleted = [];
	const skipped = [];
	for (const id of new Set(ids)) {
		if (!isSafeSessionId(id)) {
			skipped.push(String(id));
			continue;
		}
		try {
			rmSync(sessionStateDir(id), { recursive: true, force: true });
			deleted.push(id);
		} catch (e) {
			skipped.push(id);
			warnings.push(`session ${id}: ${errMsg(e)}`);
		}
	}
	let purgedRows = 0;
	if (deleted.length && opts.purgeStore !== false) {
		const purge = await purgeSessionStore(deleted);
		purgedRows = purge.rows;
		warnings.push(...purge.warnings);
	}
	return { deleted, skipped, purgedRows, warnings };
}

/**
 * Remove every row belonging to `ids` from the local session store. The schema is owned by the CLI,
 * so tables are discovered by looking for a `session_id` column rather than hard-coded: a future
 * table is purged automatically and a dropped one cannot break cleanup.
 * @param {string[]} ids
 * @returns {Promise<{ rows: number, warnings: string[] }>}
 */
export async function purgeSessionStore(ids) {
	/** @type {string[]} */
	const warnings = [];
	const path = sessionStorePath();
	if (!ids.length || !existsSync(path)) return { rows: 0, warnings };
	const sqlite = await loadSqlite();
	if (!sqlite) return { rows: 0, warnings: ["session store purge skipped: node:sqlite is unavailable"] };

	let db = null;
	let rows = 0;
	try {
		db = new sqlite.DatabaseSync(path);
		// The CLI holds this store open; wait for its writes instead of failing on SQLITE_BUSY.
		db.exec("PRAGMA busy_timeout = 5000");
		for (const chunk of chunks(ids, PURGE_CHUNK)) {
			const placeholders = chunk.map(() => "?").join(",");
			db.exec("BEGIN IMMEDIATE");
			try {
				for (const table of sessionTables(db)) {
					try {
						rows += Number(db.prepare(`DELETE FROM "${table}" WHERE session_id IN (${placeholders})`).run(...chunk).changes ?? 0);
					} catch (e) {
						// One unpurgeable table (e.g. a contentless FTS index) must not abandon the rest.
						warnings.push(`session store: ${table}: ${errMsg(e)}`);
					}
				}
				rows += Number(db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...chunk).changes ?? 0);
				db.exec("COMMIT");
			} catch (e) {
				try {
					db.exec("ROLLBACK");
				} catch {
					/* no open transaction */
				}
				throw e;
			}
		}
	} catch (e) {
		warnings.push(`session store purge failed: ${errMsg(e)}`);
	} finally {
		try {
			db?.close();
		} catch {
			/* already closed */
		}
	}
	return { rows, warnings };
}

/**
 * Tables carrying per-session rows, children first so `sessions` is deleted last (its rows are the
 * FK target). `sessions` itself is excluded — it is keyed by `id`, not `session_id`.
 * @param {any} db
 * @returns {string[]}
 */
function sessionTables(db) {
	try {
		return db
			.prepare("SELECT m.name AS name FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND p.name = 'session_id' ORDER BY m.name")
			.all()
			.map((/** @type {any} */ row) => String(row.name));
	} catch {
		return [];
	}
}

/** @returns {Promise<any|null>} `node:sqlite`, or null on runtimes that do not ship it. */
async function loadSqlite() {
	try {
		return await import("node:sqlite");
	} catch {
		return null;
	}
}

/** @template T @param {T[]} items @param {number} size @returns {T[][]} */
function chunks(items, size) {
	const out = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/** @param {unknown} e @returns {string} */
function errMsg(e) {
	return e instanceof Error ? e.message : String(e);
}
