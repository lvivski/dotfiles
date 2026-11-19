import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { guardRetirementWrite } from "./retirement.mjs";
import { decoders } from "./records.mjs";
import { FoundryError, record, text } from "./values.mjs";

export const schema = 5;
const modules = readdirSync(new URL(".", import.meta.url)).filter(name => name.endsWith(".mjs") && !name.endsWith(".test.mjs")).sort();
export const engine = [...modules, "../extension.mjs", "../hooks.mjs"].reduce((hash, name) =>
	hash.update(name).update("\0").update(readFileSync(new URL(name, import.meta.url))).update("\0"), createHash("sha256")).digest("hex");

/** @typedef {import("./records.mjs").Records} Records */
/** @typedef {import("./records.mjs").Table} Table */
/** @typedef {{
 * cwd: string, databasePath: string, db: DatabaseSync, timestamp: () => string,
 * optional: <K extends Table>(table: K, id: string) => Records[K] | undefined,
 * get: <K extends Table>(table: K, id: string) => Records[K],
 * list: <K extends Table>(table: K, where?: string, parameters?: import("node:sqlite").SQLInputValue[]) => Records[K][],
 * put: <K extends Table>(table: K, value: Records[K]) => void,
 * newId: (table: Table, supplied: unknown) => string
 * }} Transaction */
/** @typedef {{databasePath:string, transaction:<T>(operation:(tx:Transaction)=>T|FoundryError,write?:boolean)=>T, close:()=>void}} Database */

/** @param {string} pathname */
function inspect(pathname) {
	try { return lstatSync(pathname); }
	catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

/** @param {string} workingDirectory @param {{clock?: () => Date}} [options] @returns {Database} */
export function openDatabase(workingDirectory, options = {}) {
	const cwd = text(workingDirectory, "workingDirectory");
	const commonPath = execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	const commonMetadata = inspect(commonPath);
	if (!commonMetadata?.isDirectory() || commonMetadata.isSymbolicLink()) {
		throw new FoundryError("unsafe_storage", "Git common directory must be a real directory");
	}
	const common = realpathSync(commonPath);
	const directory = path.join(common, "foundry");
	if (!inspect(directory)) {
		try { mkdirSync(directory, { mode: 0o700 }); }
		catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		}
	}
	const anchor = inspect(directory);
	if (!anchor?.isDirectory() || anchor.isSymbolicLink() || realpathSync(directory) !== directory) {
		throw new FoundryError("unsafe_storage", "Foundry storage must be contained in the Git common directory");
	}
	const databasePath = path.join(directory, "work.sqlite");
	const filenames = ["work.sqlite", "work.sqlite-wal", "work.sqlite-shm", "work.sqlite-journal"];
	/** @type {{dev: number, ino: number} | undefined} */
	let identity;
	const verify = () => {
		const root = inspect(commonPath);
		const current = inspect(directory);
		if (!root?.isDirectory() || root.isSymbolicLink() || realpathSync(commonPath) !== common
			|| root.dev !== commonMetadata.dev || root.ino !== commonMetadata.ino
			|| !current?.isDirectory() || current.isSymbolicLink()
			|| current.dev !== anchor.dev || current.ino !== anchor.ino || realpathSync(directory) !== directory) {
			throw new FoundryError("unsafe_storage", "Foundry storage directory was replaced");
		}
		for (const filename of filenames) {
			const filePath = path.join(directory, filename);
			const metadata = inspect(filePath);
			if (!metadata) {
				if (filename === "work.sqlite" && identity) throw new FoundryError("unsafe_storage", "Database was removed");
				continue;
			}
			if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
				throw new FoundryError("unsafe_storage", "SQLite artifacts must be regular files without links");
			}
			try {
				if (path.dirname(realpathSync(filePath)) !== directory) throw new FoundryError("unsafe_storage", "Escaped storage");
			} catch (error) {
				if (filename !== "work.sqlite" && error instanceof Error && "code" in error && error.code === "ENOENT") continue;
				throw error;
			}
			if (filename === "work.sqlite") {
				if (identity && (identity.dev !== metadata.dev || identity.ino !== metadata.ino)) {
					throw new FoundryError("unsafe_storage", "Database was replaced");
				}
				identity = { dev: metadata.dev, ino: metadata.ino };
			}
		}
	};
	if (!inspect(databasePath)) {
		if (filenames.slice(1).some((filename) => inspect(path.join(directory, filename)))) {
			throw new FoundryError("unsafe_storage", "SQLite sidecars exist without a database");
		}
		try {
			closeSync(openSync(databasePath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600));
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		}
	}
	verify();
	const db = new DatabaseSync(databasePath);
	let closed = false;
	let busy = false;
	const clock = options.clock ?? (() => new Date());
	const timestamp = () => {
		const date = clock();
		if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new FoundryError("invalid_clock", "Clock must return a valid Date");
		return date.toISOString();
	};

	try {
		db.exec("PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
		db.exec("BEGIN IMMEDIATE");
		const version = db.prepare("PRAGMA user_version").get()?.user_version;
		const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'")
			.all().map(row => row.name));
		if (version !== 0 && version !== schema || version === 0 && tables.size
			|| version === schema && [...Object.keys(decoders), "dependencies", "outcomes", "evidence_admissions", "engine_pin",
				"usage", "local_attempts", "usage_aliases", "delivery_manifests"].some(table => !tables.has(table))) {
			throw new FoundryError("unsupported_store", "Reset obsolete or incomplete canonical state; only the current Foundry schema is supported");
		}
		if (version === schema && db.prepare("SELECT hash FROM engine_pin").get()?.hash !== engine) {
			throw new FoundryError("incompatible_engine", "Use the pinned Foundry engine or quiesce writers and authorize a fresh ledger");
		}
		if (version === 0) {
			db.exec("CREATE TABLE engine_pin(hash TEXT PRIMARY KEY NOT NULL)");
			db.prepare("INSERT INTO engine_pin VALUES(?)").run(engine);
		}
		for (const table of Object.keys(decoders)) {
			db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
				id TEXT PRIMARY KEY, document TEXT NOT NULL,
				goal_id TEXT, task_id TEXT, attempt_id TEXT, owner TEXT, state TEXT, kind TEXT,
				parent_id TEXT, native_id TEXT, slot INTEGER NOT NULL DEFAULT 0
			);`);
		}
		db.exec(`CREATE TABLE IF NOT EXISTS delivery_manifests (
			id TEXT PRIMARY KEY NOT NULL, goal_id TEXT NOT NULL REFERENCES goals(id), document TEXT NOT NULL);
			CREATE INDEX IF NOT EXISTS delivery_manifest_goal ON delivery_manifests(goal_id);`);
		const indexed = {
			goals: ["owner"], units: ["goal", "owner"], tasks: ["goal", "owner"], attempts: ["task"],
			collaborations: ["goal"],
			effects: ["attempt", "owner"], claims: ["attempt", "owner"], wakes: ["goal", "owner"],
			signals: ["goal", "task"], lessons: ["goal"], results: ["attempt"],
			deliveries: ["goal", "attempt", "owner"], native_usage: ["goal", "attempt"],
			factory_controls: ["owner"], goal_completions: ["goal", "task", "owner"], squads: ["goal", "task"], backlog_items: ["goal"],
		};
		for (const [table, columns] of Object.entries(indexed)) for (const column of columns) {
			db.exec(`CREATE INDEX IF NOT EXISTS ${table}_${column} ON ${table}(${column === "owner" ? column : `${column}_id`})`);
		}
		db.exec(`CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_id);
			CREATE INDEX IF NOT EXISTS tasks_ready ON tasks(state,goal_id);
			CREATE INDEX IF NOT EXISTS attempts_slots ON attempts(slot,task_id);
			CREATE INDEX IF NOT EXISTS attempts_native ON attempts(native_id);
			CREATE INDEX IF NOT EXISTS effects_outstanding ON effects(attempt_id,state,kind);
			CREATE INDEX IF NOT EXISTS effects_state ON effects(state);
			CREATE INDEX IF NOT EXISTS archive_native ON effects(json_extract(document,'$.request.nativeId')) WHERE kind='archive';
			CREATE INDEX IF NOT EXISTS archive_tree ON effects(json_extract(document,'$.request.arguments.guard.workspace.path')) WHERE kind='archive';
			CREATE INDEX IF NOT EXISTS effects_native_call ON effects(json_extract(document,'$.request.nativeToolCallId'));
			CREATE INDEX IF NOT EXISTS native_usage_native ON native_usage(native_id);
			CREATE INDEX IF NOT EXISTS usage_affinity_start ON usage_affinity(json_extract(document,'$.groupId'),json_extract(document,'$.startedAt'));
			CREATE INDEX IF NOT EXISTS claims_surface ON claims(json_extract(document,'$.surface'));
			CREATE UNIQUE INDEX IF NOT EXISTS attempts_token ON attempts(json_extract(document,'$.token'));
			CREATE UNIQUE INDEX IF NOT EXISTS wakes_target ON wakes(owner,goal_id,json_extract(document,'$.reason'));
			CREATE TABLE IF NOT EXISTS dependencies (
				task_id TEXT NOT NULL REFERENCES tasks(id), producer_id TEXT NOT NULL REFERENCES tasks(id),
				output TEXT NOT NULL, version TEXT, PRIMARY KEY(task_id,producer_id,output)
			);
			CREATE INDEX IF NOT EXISTS dependencies_producer ON dependencies(producer_id);
			CREATE TABLE IF NOT EXISTS outcomes (result_id TEXT PRIMARY KEY REFERENCES results(id), promoted INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS evidence_admissions (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
				attempt_id TEXT NOT NULL REFERENCES attempts(id), effect_id TEXT NOT NULL REFERENCES effects(id),
				check_id TEXT NOT NULL, check_version TEXT NOT NULL, document TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS evidence_attempt ON evidence_admissions(attempt_id,sequence);
			CREATE TABLE IF NOT EXISTS usage (event_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempts(id), credits REAL NOT NULL);
			CREATE TABLE IF NOT EXISTS local_attempts (attempt_id TEXT PRIMARY KEY REFERENCES attempts(id));
			CREATE INDEX IF NOT EXISTS collaborations_destination ON collaborations(json_extract(document,'$.destinationGoalId'));
			CREATE INDEX IF NOT EXISTS collaborations_consumer ON collaborations(json_extract(document,'$.consumerTaskId'));
			CREATE INDEX IF NOT EXISTS collaborations_producer ON collaborations(json_extract(document,'$.producerTaskId'));
			CREATE INDEX IF NOT EXISTS items_factory ON backlog_items(json_extract(document,'$.factoryId'),state);
			CREATE INDEX IF NOT EXISTS squads_factory ON squads(json_extract(document,'$.factoryId'));
			CREATE UNIQUE INDEX IF NOT EXISTS direction_revision ON directions(json_extract(document,'$.factoryId'),json_extract(document,'$.revision'));
			PRAGMA user_version=${schema};`);
		db.exec(`CREATE TABLE IF NOT EXISTS usage_aliases (
			alias TEXT NOT NULL, receipt_id TEXT NOT NULL REFERENCES native_usage(id) ON DELETE CASCADE,
			PRIMARY KEY(alias,receipt_id)
		);
		CREATE INDEX IF NOT EXISTS usage_aliases_receipt ON usage_aliases(receipt_id);
		CREATE TRIGGER IF NOT EXISTS native_usage_alias_insert AFTER INSERT ON native_usage BEGIN
			INSERT INTO usage_aliases SELECT NEW.id,NEW.id
				UNION SELECT value,NEW.id FROM json_each(NEW.document,'$.aliases');
		END;
		CREATE TRIGGER IF NOT EXISTS native_usage_alias_update AFTER UPDATE ON native_usage BEGIN
			DELETE FROM usage_aliases WHERE receipt_id=OLD.id;
			INSERT INTO usage_aliases SELECT NEW.id,NEW.id
				UNION SELECT value,NEW.id FROM json_each(NEW.document,'$.aliases');
		END;`);
		verify();
		db.exec("COMMIT");
	} catch (error) {
		try { db.exec("ROLLBACK"); } catch { /* Initialization may fail before BEGIN. */ }
		db.close();
		throw error;
	}

	/** @template T @param {(tx: Transaction) => T | FoundryError} operation @param {boolean} [write] @returns {T} */
	function transaction(operation, write = true) {
		if (closed) throw new FoundryError("store_closed", "Work store is closed");
		if (busy) throw new FoundryError("store_reentrant", "Work store operations cannot nest");
		busy = true;
		let begun = false;
		try {
			verify();
			db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
			begun = true;
			const result = operation(context);
			if (result !== null && (typeof result === "object" || typeof result === "function") && "then" in result) {
				throw new FoundryError("async_transaction", "Work store transactions must be synchronous");
			}
			verify();
			db.exec("COMMIT");
			begun = false;
			if (result instanceof FoundryError) throw result;
			return result;
		} catch (error) {
			if (begun) db.exec("ROLLBACK");
			throw error;
		} finally { busy = false; }
	}


	/** @template {Table} K @param {K} table @param {string} id @returns {Records[K] | undefined} */
	function optional(table, id) {
		const row = db.prepare(`SELECT document FROM ${table} WHERE id=?`).get(text(id, "id"));
		if (!row) return undefined;
		/** @type {unknown} */
		const parsed = JSON.parse(text(row.document, "stored document"));
		return decoders[table](parsed);
	}

	/** @template {Table} K @param {K} table @param {string} id @returns {Records[K]} */
	function get(table, id) {
		const value = optional(table, id);
		if (!value) throw new FoundryError("not_found", `${table} record ${id} does not exist`);
		return value;
	}

	/** @template {Table} K @param {K} table @param {string} [where] @param {import("node:sqlite").SQLInputValue[]} [parameters] @returns {Records[K][]} */
	function list(table, where = "", parameters = []) {
		return db.prepare(`SELECT document FROM ${table} ${where} ORDER BY rowid`).all(...parameters).map((row) => {
			/** @type {unknown} */
			const parsed = JSON.parse(text(row.document, "stored document"));
			return decoders[table](parsed);
		});
	}

	/** @template {Table} K @param {K} table @param {Records[K]} value */
	function put(table, value) {
		const row = record(value);
		guardRetirementWrite(context, table, row);
		const str = (/** @type {string} */ key) => row[key] === undefined ? null : text(row[key], key);
		db.prepare(`INSERT INTO ${table}(id,document,goal_id,task_id,attempt_id,owner,state,kind,parent_id,native_id,slot)
			VALUES(?,?,?,?,?,?,?,?,?,?,?)
			ON CONFLICT(id) DO UPDATE SET document=excluded.document,goal_id=excluded.goal_id,task_id=excluded.task_id,
			attempt_id=excluded.attempt_id,owner=excluded.owner,state=excluded.state,kind=excluded.kind,parent_id=excluded.parent_id,
			native_id=excluded.native_id,slot=excluded.slot`).run(
			value.id, JSON.stringify(value), str("goalId"), str("taskId"), str("attemptId"), str("owner"),
			str("state"), str("kind"), str("parentId"), str("nativeId"), row.slot === true ? 1 : 0,
		);
	}

	/** @param {Table} table @param {unknown} supplied */
	function newId(table, supplied) {
		const id = supplied === undefined ? randomUUID() : text(supplied, "id");
		if (optional(table, id)) throw new FoundryError("duplicate_id", `${table} record ${id} already exists`);
		return id;
	}

	/** @type {Transaction} */
	const context = { cwd, databasePath, db, timestamp, optional, get, list, put, newId };
	return { databasePath, transaction, close() { if (!closed) { db.close(); closed = true; } } };
}
