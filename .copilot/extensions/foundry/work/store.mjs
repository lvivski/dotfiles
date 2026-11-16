import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decodeNativeUsage, decodeUsageAffinity } from "./usage.mjs";
import { bindCandidateOutputs, normalizeCandidateOutputs, readCandidate } from "./artifacts.mjs";
import { compileFactoryContext, decodeCompletion, decodeFactory } from "./factory.mjs";
import {
	FoundryError, array, boolean, choice, containsPath, decodeCheck, decodeEvidence,
	decodeDispatch, decodeFinding, decodeInput, decodeLimits, decodeOutput, decodeScope, decodeSource, decodeWaiting,
	digest, json, latestEvidence, narrowScope, nativeSessionName, natural, number, optionalText, record, resourcePath, strings, text,
} from "./values.mjs";

/** @typedef {import("./model.d.ts").Json} Json */
/** @typedef {import("./model.d.ts").Goal} Goal */
/** @typedef {import("./model.d.ts").Team} Team */
/** @typedef {import("./model.d.ts").Task} Task */
/** @typedef {import("./model.d.ts").Attempt} Attempt */
/** @typedef {import("./model.d.ts").Effect} Effect */
/** @typedef {import("./model.d.ts").Result} Result */
/** @typedef {import("./model.d.ts").Claim} Claim */
/** @typedef {import("./model.d.ts").Wake} Wake */
/** @typedef {import("./model.d.ts").Signal} Signal */
/** @typedef {import("./model.d.ts").Lesson} Lesson */
/** @typedef {import("./model.d.ts").Delivery} Delivery */
/** @typedef {{id?: string, title: string, projectId?: string, scope: import("./model.d.ts").Scope, limits?: import("./model.d.ts").Limits, source?: Goal["source"]}} GoalInput */
/** @typedef {{id?: string, goalId: string, parentId?: string, teamId?: string, title: string, assignment: string, dispatch?: Task["dispatch"], workType: string, scope?: unknown, checks?: import("./model.d.ts").Check[], inputs?: import("./model.d.ts").Input[]}} TaskInput */
/** @typedef {import("./model.d.ts").FactoryControl} Factory */
/** @typedef {import("./model.d.ts").GoalCompletion} Completion */
/** @typedef {{goals: Goal, teams: Team, tasks: Task, attempts: Attempt, effects: Effect, claims: Claim, wakes: Wake, signals: Signal, lessons: Lesson, results: Result, deliveries: Delivery, native_usage: import("./model.d.ts").NativeUsage, usage_affinity: import("./model.d.ts").UsageAffinity, factory_controls: Factory, goal_completions: Completion}} Records */
/** @typedef {keyof Records} Table */
const MANAGED_TASKS = `WITH RECURSIVE managed(id,goal_id) AS (
	SELECT id,goal_id FROM tasks WHERE owner=? OR goal_id IN (SELECT id FROM goals WHERE owner=?)
	UNION SELECT t.id,t.goal_id FROM tasks t JOIN managed p ON t.parent_id=p.id AND t.goal_id=p.goal_id
)`;

/** @param {unknown} value @returns {Goal} */
function decodeGoal(value) {
	const row = record(value);
	const projectId = optionalText(row.projectId, "goal.projectId");
	const source = row.source === undefined ? undefined : decodeSource(row.source);
	return {
		id: text(row.id, "goal.id"), title: text(row.title, "goal.title"), owner: text(row.owner, "goal.owner"),
		scope: decodeScope(row.scope), limits: decodeLimits(row.limits),
		credits: number(row.credits, "goal.credits"), createdAt: text(row.createdAt, "goal.createdAt"),
		...(projectId === undefined ? {} : { projectId }),
		...(source === undefined ? {} : { source }),
	};
}

/** @param {unknown} value @returns {Team} */
function decodeTeam(value) {
	const row = record(value);
	return {
		id: text(row.id, "team.id"), goalId: text(row.goalId, "team.goalId"), name: text(row.name, "team.name"),
		owner: text(row.owner, "team.owner"), context: strings(row.context),
	};
}

/** @param {unknown} value @returns {Task} */
function decodeTask(value) {
	const row = record(value);
	const parentId = optionalText(row.parentId, "task.parentId");
	const teamId = optionalText(row.teamId, "task.teamId");
	const currentAttemptId = optionalText(row.currentAttemptId, "task.currentAttemptId");
	const waiting = decodeWaiting(row.waiting);
	return {
		id: text(row.id, "task.id"), goalId: text(row.goalId, "task.goalId"), owner: text(row.owner, "task.owner"),
		title: text(row.title, "task.title"), assignment: text(row.assignment, "task.assignment"),
		...(row.dispatch === undefined ? {} : { dispatch: decodeDispatch(row.dispatch) }),
		workType: text(row.workType, "task.workType"), scope: decodeScope(row.scope),
		checks: array(row.checks, decodeCheck), inputs: array(row.inputs, decodeInput), outputs: array(row.outputs, decodeOutput),
		state: choice(row.state, /** @type {const} */ (["ready", "running", "waiting", "blocked", "failed", "done", "cancelled"]), "task.state"),
		version: natural(row.version, "task.version"),
		...(row.repairs === undefined ? {} : { repairs: natural(row.repairs, "task.repairs") }),
		...(row.repairReservation === undefined ? {} : { repairReservation: {
			attemptId: text(record(row.repairReservation).attemptId, "reserved failed attempt"),
			worker: text(record(row.repairReservation).worker, "reserved repair worker"),
		} }),
		...(parentId === undefined ? {} : { parentId }), ...(teamId === undefined ? {} : { teamId }),
		...(currentAttemptId === undefined ? {} : { currentAttemptId }), ...(waiting === undefined ? {} : { waiting }),
	};
}

/** @param {unknown} value @returns {Attempt} */
function decodeAttempt(value) {
	const row = record(value);
	const nativeId = optionalText(row.nativeId, "attempt.nativeId");
	const repairOf = optionalText(row.repairOf, "attempt.repairOf");
	return {
		id: text(row.id, "attempt.id"), taskId: text(row.taskId, "attempt.taskId"), token: text(row.token, "attempt.token"),
		creator: text(row.creator, "attempt.creator"),
		state: choice(row.state, /** @type {const} */ (["prepared", "issued", "running", "waiting", "done", "failed", "cancelled", "uncertain"]), "attempt.state"),
		taskVersion: natural(row.taskVersion, "attempt.taskVersion"), checks: array(row.checks, decodeCheck),
		inputs: array(row.inputs, decodeInput), slot: boolean(row.slot, "attempt.slot"),
		createdAt: text(row.createdAt, "attempt.createdAt"),
		...(nativeId === undefined ? {} : { nativeId }), ...(repairOf === undefined ? {} : { repairOf }),
		...(row.assignedOwner === undefined ? {} : { assignedOwner: text(row.assignedOwner, "assigned coordinator") }),
		...(row.endedBy === undefined ? {} : { endedBy: text(row.endedBy, "attempt terminator") }),
		...(row.waiting === undefined ? {} : { waiting: decodeWaiting(row.waiting) }),
	};
}

/** @param {unknown} value @returns {Effect} */
function decodeEffect(value) {
	const row = record(value);
	return {
		id: text(row.id, "effect.id"), attemptId: text(row.attemptId, "effect.attemptId"),
		kind: choice(row.kind, /** @type {const} */ (["create", "command", "stop"]), "effect.kind"),
		state: choice(row.state, /** @type {const} */ (["prepared", "issued", "settled", "uncertain"]), "effect.state"),
		owner: text(row.owner, "effect.owner"), request: json(row.request),
		...(row.result === undefined ? {} : { result: json(row.result) }),
		...(row.relatedAttemptIds === undefined ? {} : { relatedAttemptIds: strings(row.relatedAttemptIds) }),
		...(row.factoryGeneration === undefined ? {} : { factoryGeneration: natural(row.factoryGeneration, "effect activation") }),
	};
}

/** @param {unknown} value @returns {Result} */
function decodeResult(value) {
	const row = record(value);
	return {
		id: text(row.id, "result.id"), attemptId: text(row.attemptId, "result.attemptId"),
		sender: text(row.sender, "result.sender"),
		state: choice(row.state, /** @type {const} */ (["done", "failed", "blocked"]), "result.state"),
		summary: text(row.summary, "result.summary"), outputs: array(row.outputs, decodeOutput),
		evidence: array(row.evidence, decodeEvidence), findings: array(row.findings, decodeFinding),
		createdAt: text(row.createdAt, "result.createdAt"),
		...(row.reportedBy === undefined ? {} : { reportedBy: text(row.reportedBy, "result reporter") }),
	};
}

/** @param {unknown} value @returns {Claim} */
function decodeClaim(value) {
	const row = record(value);
	return { id: text(row.id, "claim.id"), attemptId: text(row.attemptId, "claim.attemptId"),
		surface: text(row.surface, "claim.surface"), resource: resourcePath(row.resource) };
}

/** @param {unknown} value @returns {Wake} */
function decodeWake(value) {
	const row = record(value);
	const sent = row.sent === undefined ? undefined : natural(row.sent, "wake.sent");
	return {
		id: text(row.id, "wake.id"), owner: text(row.owner, "wake.owner"), goalId: text(row.goalId, "wake.goalId"),
		generation: natural(row.generation, "wake.generation"), consumed: natural(row.consumed, "wake.consumed"),
		reason: text(row.reason, "wake.reason"),
		...(row.relatedReasons === undefined ? {} : { relatedReasons: strings(row.relatedReasons) }),
		...(row.inFlight === undefined ? {} : { inFlight: text(row.inFlight, "wake delivery effect") }),
		...(sent === undefined ? {} : { sent }),
		...(row.unavailable === undefined ? {} : { unavailable: {
			effectId: text(record(row.unavailable).effectId, "failed delivery"),
			generation: natural(record(row.unavailable).generation, "failed generation"),
			fallback: text(record(row.unavailable).fallback, "fallback owner"),
			message: text(record(row.unavailable).message, "delivery failure"),
		} }),
	};
}

/** @param {unknown} value @returns {Signal} */
function decodeSignal(value) {
	const row = record(value);
	const taskId = optionalText(row.taskId, "signal.taskId");
	return { id: text(row.id, "signal.id"), goalId: text(row.goalId, "signal.goalId"),
		kind: text(row.kind, "signal.kind"), summary: text(row.summary, "signal.summary"), references: strings(row.references),
		...(taskId === undefined ? {} : { taskId }),
		...(row.teamId === undefined ? {} : { teamId: text(row.teamId, "signal.teamId") }) };
}

/** @param {unknown} value @returns {Lesson} */
function decodeLesson(value) {
	const row = record(value);
	return { id: text(row.id, "lesson.id"), goalId: text(row.goalId, "lesson.goalId"),
		workType: text(row.workType, "lesson.workType"), summary: text(row.summary, "lesson.summary"),
		references: strings(row.references) };
}
/** @param {unknown} value @returns {Delivery} */
function decodeDelivery(value) {
	const row = record(value);
	return { id: text(row.id, "delivery"), goalId: text(row.goalId, "delivery goal"), wakeId: text(row.wakeId, "wake"),
		generation: natural(row.generation, "delivery generation"), owner: text(row.owner, "native sender"),
		state: choice(row.state, ["issued", "settled"], "delivery state"), request: json(row.request),
		...(row.attemptId === undefined ? {} : { attemptId: text(row.attemptId, "delivery attempt") }),
		...(row.result === undefined ? {} : { result: json(row.result) }) };
}

/** @type {{[K in Table]: (value: unknown) => Records[K]}} */
const decoders = {
	goals: decodeGoal, teams: decodeTeam, tasks: decodeTask, attempts: decodeAttempt, effects: decodeEffect,
	claims: decodeClaim, wakes: decodeWake, signals: decodeSignal, lessons: decodeLesson, results: decodeResult, deliveries: decodeDelivery,
	native_usage: decodeNativeUsage, usage_affinity: decodeUsageAffinity,
	factory_controls: decodeFactory, goal_completions: decodeCompletion,
};

/** @param {string} pathname */
function inspect(pathname) {
	try { return lstatSync(pathname); }
	catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

/** @param {Json} before @param {Json} after @param {boolean} [issuing] */
function sameRequest(before, after, issuing = false) {
	if (digest(before) === digest(after)) return true;
	if (!issuing || before === null || after === null || typeof before !== "object" || typeof after !== "object"
		|| Array.isArray(before) || Array.isArray(after)) return false;
	const { nativeToolCallId: oldCallId, ...oldRequest } = before;
	const { nativeToolCallId: newCallId, ...newRequest } = after;
	return oldCallId === undefined && (newCallId === null || (typeof newCallId === "string" && newCallId.length > 0))
		&& digest(oldRequest) === digest(newRequest);
}

/**
 * Native calls happen outside this store. Every operation below is synchronous,
 * and its short transaction guards only the affected records.
 * @param {string} workingDirectory
 * @param {{clock?: () => Date}} [options]
 */
export function openWorkStore(workingDirectory, options = {}) {
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
		if (version !== 0 && version !== 2 || version === 0 && tables.size
			|| version === 2 && [...Object.keys(decoders), "dependencies", "outcomes", "evidence_admissions",
				"usage", "local_attempts", "usage_aliases"].some(table => !tables.has(table))) {
			throw new FoundryError("unsupported_store", "Reset obsolete or incomplete canonical state; only the current Foundry schema is supported");
		}
		for (const table of Object.keys(decoders)) {
			db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
				id TEXT PRIMARY KEY, document TEXT NOT NULL,
				goal_id TEXT, task_id TEXT, attempt_id TEXT, owner TEXT, state TEXT, kind TEXT,
				parent_id TEXT, native_id TEXT, slot INTEGER NOT NULL DEFAULT 0
			);`);
		}
		const indexed = {
			goals: ["owner"], teams: ["goal", "owner"], tasks: ["goal", "owner"], attempts: ["task"],
			effects: ["attempt", "owner"], claims: ["attempt", "owner"], wakes: ["goal", "owner"],
			signals: ["goal", "task"], lessons: ["goal"], results: ["attempt"],
			deliveries: ["goal", "attempt", "owner"], native_usage: ["goal", "attempt"],
			factory_controls: ["owner"], goal_completions: ["goal", "task", "owner"],
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
			PRAGMA user_version=2;`);
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

	/** @template T @param {() => T | FoundryError} operation @param {boolean} [write] @returns {T} */
	function transaction(operation, write = true) {
		if (closed) throw new FoundryError("store_closed", "Work store is closed");
		if (busy) throw new FoundryError("store_reentrant", "Work store operations cannot nest");
		busy = true;
		let begun = false;
		try {
			verify();
			db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
			begun = true;
			const result = operation();
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
	/** @param {string[]} identities */
	function usageReceipts(identities) {
		const matches = list("native_usage", `WHERE id IN (SELECT receipt_id FROM usage_aliases
			WHERE alias IN (SELECT value FROM json_each(?)))`, [JSON.stringify(identities)]);
		if (matches.length > 1) throw new FoundryError("usage_identity_conflict", "Multiple prior receipts share one actual native billing identity");
		return matches[0];
	}
	/** @template {Table} K @param {K} table @param {Records[K]} value */
	function put(table, value) {
		const row = record(value);
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
	/** @param {Task} task @returns {Task[]} */
	function ancestors(task) {
		const result = [];
		const seen = new Set([task.id]);
		let parentId = task.parentId;
		while (parentId) {
			if (seen.has(parentId)) throw new FoundryError("corrupt_tree", "Delegation must be a tree");
			seen.add(parentId);
			const parent = get("tasks", parentId);
			if (parent.goalId !== task.goalId) throw new FoundryError("corrupt_tree", "Parent belongs to another goal");
			result.push(parent);
			parentId = parent.parentId;
		}
		return result;
	}
	/** @param {Task} task @param {string} actor */
	function authorized(task, actor) {
		text(actor, "actor");
		if (task.owner === actor || get("goals", task.goalId).owner === actor) return true;
		return db.prepare(`${MANAGED_TASKS} SELECT id FROM managed WHERE id=?`).get(actor, actor, task.id) !== undefined;
	}
	/** @param {Task} task @param {string} actor */
	function requireOwner(task, actor) {
		if (!authorized(task, actor)) throw new FoundryError("forbidden", "Only the task owner or its accountable ancestors may manage this task");
	}
	/** @param {Task} task @param {string} actor */
	function assignedExecution(task, actor) {
		const attempt = task.currentAttemptId ? get("attempts", task.currentAttemptId) : undefined;
		return task.repairReservation?.worker === actor || attempt?.nativeId === actor && attempt.taskVersion === task.version;
	}
	/** @param {string} taskId @param {string} actor @param {boolean} execution */
	function accessibleTask(taskId, actor, execution) {
		const task = get("tasks", taskId);
		if (!authorized(task, actor) && !(execution && assignedExecution(task, actor))) {
			throw new FoundryError("foreign_task", "This native session does not own the task or its assigned execution");
		}
		return task;
	}
	/** @param {Goal} goal @param {string} actor */
	function requireGoalOwner(goal, actor) {
		if (goal.owner !== text(actor, "actor")) throw new FoundryError("forbidden", "Only the goal owner may manage this goal");
	}
	/** @param {Goal} goal @param {string} actor */
	function goalMember(goal, actor) {
		text(actor, "actor");
		return goal.owner === actor || db.prepare(`SELECT id FROM tasks WHERE goal_id=? AND owner=?
			UNION SELECT id FROM teams WHERE goal_id=? AND owner=?
			UNION SELECT t.id FROM attempts a JOIN tasks t ON t.id=a.task_id WHERE t.goal_id=? AND a.native_id=? LIMIT 1`)
			.get(goal.id, actor, goal.id, actor, goal.id, actor) !== undefined;
	}
	/** @param {Attempt} attempt @param {string} actor */
	function requireReporter(attempt, actor) {
		if (attempt.nativeId !== actor && attempt.creator !== actor) requireOwner(get("tasks", attempt.taskId), actor);
	}
	/** @param {Task} task */
	function uncancelled(task) {
		if (task.state === "cancelled" || ancestors(task).some((parent) => parent.state === "cancelled")) {
			throw new FoundryError("cancelled", "This task's subtree is cancelled");
		}
	}
	/** @param {Attempt} attempt @returns {Task} */
	function current(attempt) {
		const task = get("tasks", attempt.taskId);
		uncancelled(task);
		if (task.currentAttemptId !== attempt.id || task.version !== attempt.taskVersion) {
			throw new FoundryError("stale_attempt", "This attempt is no longer current");
		}
		return task;
	}
	/** @param {Task} task @param {number} [generation] @param {boolean} [allowClosed] */
	function requireAdmission(task, generation, allowClosed = false) {
		const completion = optional("goal_completions", task.goalId);
		if (!completion) return undefined;
		const factory = get("factory_controls", completion.factoryId);
		if (get("tasks", completion.taskId).state === "cancelled") {
			throw new FoundryError("job_cancelled", "This bounded job is cancelled; settle its existing work without admitting new execution");
		}
		if (completion.closed && !allowClosed) throw new FoundryError("job_closed", "Accepted bounded jobs admit no new execution; reopen explicitly before starting or resuming work");
		const nativeId = task.currentAttemptId ? get("attempts", task.currentAttemptId).nativeId : undefined;
		if (factory.state !== "active" || factory.pausedWorkers.includes(task.owner)
			|| nativeId !== undefined && factory.pausedWorkers.includes(nativeId)) {
			throw new FoundryError("factory_paused", "Factory execution is paused; only an explicit user-requested restart can admit work");
		}
		if (generation !== undefined && generation !== factory.generation) {
			throw new FoundryError("stale_activation", "This prepared operation belongs to a revoked activation");
		}
		if (!task.dispatch) throw new FoundryError("assignment_snapshot_required", "Factory execution requires its admitted assignment snapshot; reset obsolete state rather than reconstructing policy at dispatch");
		return factory;
	}
	/** @param {Completion} completion */
	function productionClosure(completion) {
		const tasks = [get("tasks", completion.taskId)];
		const seen = new Set(tasks.map(task => task.id));
		for (const task of tasks) for (const input of task.inputs) {
			const producer = get("tasks", input.taskId);
			if (producer.goalId !== completion.goalId) continue;
			if (input.version !== undefined) throw new FoundryError("pinned_required_producer", "Mutable in-job required production must float; historical pins are not current-job acceptance");
			if (!seen.has(producer.id)) { seen.add(producer.id); tasks.push(producer); }
		}
		return tasks;
	}
	/** @param {Completion} completion */
	function completionStatus(completion) {
		const accepted = completion.accepted;
		const delivered = completion.closed && accepted?.revision === completion.revision
			&& accepted.tasks.every(item => {
				const task = get("tasks", item.id);
				return task.state === "done" && task.version === item.version
					&& digest(json(resolvedInputs(task) ?? null)) === digest(json(item.inputs));
			});
		const attempts = list("attempts", "WHERE task_id IN (SELECT id FROM tasks WHERE goal_id=?)", [completion.goalId]);
		const settled = attempts.every(attempt => !attempt.slot && attempt.waiting?.kind !== "input" && !outstanding(attempt, true))
			&& !list("claims", "WHERE attempt_id IN (SELECT a.id FROM attempts a JOIN tasks t ON a.task_id=t.id WHERE t.goal_id=?)", [completion.goalId]).length;
		const cancelled = get("tasks", completion.taskId).state === "cancelled"
			&& list("tasks", "WHERE goal_id=?", [completion.goalId]).every(task => ["done", "failed", "cancelled"].includes(task.state));
		return { goalId: completion.goalId, factoryId: completion.factoryId, taskId: completion.taskId, delivered: Boolean(delivered), settled, cancelled,
			closed: completion.closed, revision: completion.revision };
	}
	/** @param {import("./model.d.ts").Input} input @returns {import("./model.d.ts").Output|undefined} */
	function inputOutput(input) {
		const producer = get("tasks", input.taskId);
		if (producer.state === "cancelled") return undefined;
		const current = producer.state === "done" ? producer.outputs.find(output => output.name === input.output
			&& (input.version === undefined || output.version === input.version)) : undefined;
		if (current || input.version === undefined) return current;
		const published = list("results", `WHERE state='done'
			AND attempt_id IN (SELECT id FROM attempts WHERE task_id=?)
			AND id IN (SELECT result_id FROM outcomes WHERE promoted=1)`, [producer.id]);
		return published.flatMap(result => result.outputs).find(output => output.name === input.output && output.version === input.version);
	}
	/** @param {Task} task @returns {import("./model.d.ts").Input[] | undefined} */
	function resolvedInputs(task) {
		const resolved = [];
		for (const input of task.inputs) {
			const output = inputOutput(input);
			if (!output) return undefined;
			resolved.push({ taskId: input.taskId, output: input.output, version: output.version });
		}
		return resolved;
	}
	/** @param {string} owner @param {string} goalId @param {string} reason */
	function wake(owner, goalId, reason) {
		const existing = list("wakes", "WHERE owner=? AND goal_id=?", [owner, goalId])[0];
		const relatedReasons = [...new Set([
			...(existing && existing.generation > existing.consumed ? existing.relatedReasons ?? [existing.reason] : []),
			reason,
		])];
		const result = existing ? { ...existing, reason, relatedReasons, generation: existing.generation + 1 }
			: { id: randomUUID(), owner, goalId, reason, relatedReasons, generation: 1, consumed: 0, sent: 0 };
		put("wakes", result);
		return result;
	}
	/** @param {Attempt} attempt @param {boolean} [substantive] */
	function outstanding(attempt, substantive = false) {
		return attemptEffects(attempt.id, "AND state IN ('issued','uncertain')")
			.some((effect) => !substantive || effect.kind === "command" || effect.kind === "create");
	}
	/** @param {Attempt} attempt @param {"paused"|"stalled"} [cause] */
	function parkPausedExecution(attempt, cause = "paused") {
		const task = get("tasks", attempt.taskId);
		const completion = optional("goal_completions", task.goalId);
		if (!completion || !attempt.nativeId || task.currentAttemptId !== attempt.id || task.version !== attempt.taskVersion
			|| task.state !== "running" || outstanding(attempt, true)) return;
		const factory = get("factory_controls", completion.factoryId);
		if (factory.state !== "paused" && !factory.pausedWorkers.includes(attempt.nativeId)) return;
		task.state = "blocked";
		task.waiting = { kind: "factory", cause, reason: cause === "paused" ? "factory_paused" : "continuation_stalled" };
		attempt.state = "waiting";
		attempt.waiting = task.waiting;
		put("tasks", task);
		put("attempts", attempt);
		releaseSlot(attempt);
		notifyOutcome(task);
	}
	/** @param {string} attemptId @param {string} [where] */
	function attemptEffects(attemptId, where = "") {
		return list("effects", `WHERE (attempt_id=? OR EXISTS (
			SELECT 1 FROM json_each(document,'$.relatedAttemptIds') WHERE value=?)) ${where}`, [attemptId, attemptId]);
	}
	/** @param {Attempt} attempt @param {string} reason */
	function retirePrepared(attempt, reason) {
		for (const effect of list("effects", "WHERE attempt_id=? AND state='prepared' AND kind IN ('create','command')", [attempt.id])) {
			effect.state = "settled";
			effect.result = { neverIssued: true, reason };
			put("effects", effect);
		}
	}
	/** @param {string} goalId */
	function wakeCapacity(goalId) {
		const goal = get("goals", goalId);
		if (goal.limits.workers === undefined || !hasSlot(goal) || !budgetAvailable(goal)) return;
		for (const task of list("tasks", "WHERE goal_id=? AND state IN ('ready','waiting')", [goalId])) {
			if (runnable(task)) wake(task.repairReservation?.worker ?? task.owner, task.goalId, "capacity");
		}
	}
	/** @param {Wake} notification @returns {string[]} */
	function wakeTargets(notification) {
		if (notification.reason === "capacity") {
			const goal = get("goals", notification.goalId);
			if (!hasSlot(goal) || !budgetAvailable(goal)) return [];
			return list("tasks", "WHERE goal_id=? AND state IN ('ready','waiting')", [notification.goalId])
				.filter(runnable).map((task) => task.repairReservation?.worker ?? task.owner);
		}
		const prefix = notification.reason.split(":", 1)[0];
		const taskId = notification.reason.slice(prefix.length + 1);
		if (prefix === "signal") {
			const signal = optional("signals", taskId);
			if (!signal) return [];
			return [signalOwner(signal)];
		}
		if (prefix === "unavailable") {
			const failed = optional("wakes", taskId);
			return failed?.unavailable ? [fallbackOwner(failed)] : [];
		}
		if (prefix === "team") return [get("teams", taskId).owner];
		const task = optional("tasks", taskId);
		if (!task) return [];
		if (prefix === "reassignment" || prefix === "revision") return [task.owner];
		if (prefix === "repair") return task.state === "ready" ? [task.repairReservation?.worker ?? task.owner] : [];
		if (prefix !== "output") return [notification.owner];
		const parent = task.parentId ? get("tasks", task.parentId) : undefined;
		const recipients = parent?.goalId === notification.goalId ? [parent.owner]
			: !parent && task.goalId === notification.goalId ? [get("goals", task.goalId).owner] : [];
		for (const row of db.prepare("SELECT DISTINCT task_id FROM dependencies WHERE producer_id=?").all(task.id)) {
			const consumer = get("tasks", text(row.task_id, "consumer"));
			if (consumer.goalId === notification.goalId && runnable(consumer)) recipients.push(consumer.owner);
		}
		return recipients;
	}
	/** @param {Signal} signal */
	function signalOwner(signal) {
		if (signal.teamId) return get("teams", signal.teamId).owner;
		if (!signal.taskId) return get("goals", signal.goalId).owner;
		const task = get("tasks", signal.taskId);
		return task.parentId ? get("tasks", task.parentId).owner
			: task.teamId ? get("teams", task.teamId).owner : get("goals", task.goalId).owner;
	}
	/** @param {Wake} notification */
	function fallbackOwner(notification) {
		for (const task of list("tasks", "WHERE goal_id=? AND owner=?", [notification.goalId, notification.owner])) {
			const parent = ancestors(task).find(parent => parent.owner !== notification.owner && parent.state !== "cancelled");
			if (parent) return parent.owner;
		}
		return get("goals", notification.goalId).owner;
	}
	/** @param {string} owner @param {Wake} notification */
	function wakeOwnerFallback(owner, notification) { wake(owner, notification.goalId, `unavailable:${notification.id}`); }
	/** @param {Task} task @param {string} newOwner @param {string} actor @param {boolean} [teamHandoff] */
	function transfer(task, newOwner, actor, teamHandoff = false) {
		if (!teamHandoff && get("goals", task.goalId).owner !== text(actor, "actor")
			&& !ancestors(task).some(parent => parent.owner === actor)) {
			throw new FoundryError("forbidden", "Only an accountable owner or ancestor may transfer this subtree");
		}
		requireOwner(task, actor);
		uncancelled(task);
		const previousOwner = task.owner;
		task.owner = text(newOwner, "newOwner");
		if (task.repairReservation && task.owner !== previousOwner) delete task.repairReservation;
		if (task.currentAttemptId && task.owner !== previousOwner) {
			const attempt = get("attempts", task.currentAttemptId);
			if (preparedDispatch(task)) revise(task, actor);
			else { attempt.assignedOwner = task.owner; put("attempts", attempt); }
		}
		put("tasks", task);
		wake(task.owner, task.goalId, `reassignment:${task.id}`);
		return task;
	}
	/** @param {string} goalId */
	function rerouteWakes(goalId) {
		for (const notification of list("wakes", "WHERE goal_id=?", [goalId])) {
			if (notification.generation <= notification.consumed) continue;
			const targets = new Set();
			for (const reason of notification.relatedReasons ?? [notification.reason]) {
				for (const owner of wakeTargets({ ...notification, reason })) {
					targets.add(owner);
					if (owner !== notification.owner) wake(owner, goalId, reason);
				}
			}
			if (!targets.has(notification.owner)) {
				notification.consumed = notification.generation;
				put("wakes", notification);
			}
		}
	}
	/** @param {Attempt} attempt */
	function releaseOwnedClaims(attempt) {
		if (attempt.nativeId === undefined || !["done", "failed", "cancelled"].includes(attempt.state) || attempt.endedBy !== attempt.nativeId
			|| outstanding(attempt, true) || get("tasks", attempt.taskId).repairReservation?.attemptId === attempt.id) return;
		db.prepare("DELETE FROM claims WHERE json_extract(document,'$.attemptId')=?").run(attempt.id);
	}
	/** @param {Attempt} attempt @param {boolean} [notify] @param {boolean} [preserveClaims] */
	function releaseSlot(attempt, notify = true, preserveClaims = false) {
		if (attempt.slot && !outstanding(attempt, true)
			&& ["done", "failed", "cancelled", "waiting"].includes(attempt.state)) {
			attempt.slot = false;
			put("attempts", attempt);
			if (notify) wakeCapacity(get("tasks", attempt.taskId).goalId);
		}
		if (!preserveClaims) releaseOwnedClaims(attempt);
	}
	/** @param {Goal} goal */
	function budgetAvailable(goal) {
		return (goal.limits.credits === undefined || goal.credits < goal.limits.credits)
			&& (goal.limits.deadline === undefined || Date.parse(timestamp()) < Date.parse(goal.limits.deadline));
	}
	/** @param {Goal} goal */
	function hasSlot(goal) {
		if (goal.limits.workers === undefined) return true;
		const count = db.prepare("SELECT count(*) AS n FROM attempts a JOIN tasks t ON t.id=a.task_id WHERE t.goal_id=? AND a.slot=1").get(goal.id)?.n;
		return natural(count, "active slots") < goal.limits.workers;
	}
	/** @param {Task} task */
	function resumable(task) {
		if (task.state !== "waiting" || !task.currentAttemptId || get("attempts", task.currentAttemptId).slot) return false;
		if (task.waiting?.kind === "capacity" || task.waiting?.kind === "factory") return true;
		if (task.waiting?.kind !== "children") return false;
		if (task.inputs.length) return resolvedInputs(task) !== undefined;
		const children = list("tasks", "WHERE parent_id=?", [task.id]);
		return children.length > 0 && children.every((child) => ["done", "failed", "blocked", "cancelled"].includes(child.state));
	}
	/** @param {Task} task */
	function runnable(task) {
		return (task.state === "ready" || resumable(task)) && !ancestors(task).some((parent) => parent.state === "cancelled")
			&& resolvedInputs(task) !== undefined;
	}
	/** @param {Task} task */
	function preparedDispatch(task) {
		if (task.state !== "running" || !task.currentAttemptId) return false;
		const attempt = get("attempts", task.currentAttemptId);
		return attempt.state === "prepared" && attempt.slot && attempt.nativeId === undefined
			&& !ancestors(task).some((parent) => parent.state === "cancelled")
			&& !list("effects", "WHERE attempt_id=? AND kind='create' AND state<>'prepared'", [attempt.id]).length;
	}
	/** @param {Task} task @returns {FoundryError | undefined} */
	function allocate(task) {
		requireAdmission(task);
		const goal = get("goals", task.goalId);
		if (!budgetAvailable(goal)) throw new FoundryError("limit_exhausted", "The goal's observed credits or absolute deadline are exhausted");
		if (!hasSlot(goal)) {
			wake(task.repairReservation?.worker ?? task.owner, goal.id, "capacity");
			return new FoundryError("capacity_wait", `Goal ${goal.id} has no free worker slot; wait for its capacity wake`);
		}
		return undefined;
	}
	/** @param {string} taskId @param {string} actor @param {string} [localRepairOf] @returns {Attempt | FoundryError} */
	function prepare(taskId, actor, localRepairOf) {
		const task = get("tasks", taskId);
		if (task.repairReservation && (localRepairOf !== task.repairReservation.attemptId || actor !== task.repairReservation.worker)) {
			throw new FoundryError("repair_reserved", "This repair is reserved for its existing native worker");
		}
		if (localRepairOf === undefined) requireOwner(task, actor);
		else {
			const previous = get("attempts", localRepairOf);
			if (previous.nativeId !== actor || previous.state !== "failed" || task.currentAttemptId !== previous.id
				|| task.version !== previous.taskVersion + 1) throw new FoundryError("foreign_execution", "Repair must retain its exact failed worker and current task");
		}
		uncancelled(task);
		if (task.currentAttemptId && task.state === "running") {
			const existing = get("attempts", task.currentAttemptId);
			if (existing.state === "prepared" && existing.slot) {
				const factory = requireAdmission(task);
				const creation = attemptEffects(existing.id).find(effect => effect.kind === "create");
				if (factory && creation && creation.factoryGeneration !== factory.generation && preparedDispatch(task)) {
					revise(task, actor);
				} else {
					requireAdmission(task, creation?.factoryGeneration);
					return existing;
				}
			}
		}
		if (task.state !== "ready") throw new FoundryError("invalid_transition", "Only a ready task can start a new attempt");
		const inputs = resolvedInputs(task);
		if (inputs === undefined) throw new FoundryError("inputs_unavailable", "Required named producer outputs and versions are not available");
		const denied = allocate(task);
		if (denied) return denied;
		const attempt = decodeAttempt({ id: randomUUID(), taskId, token: randomUUID(), creator: actor,
			state: "prepared", taskVersion: task.version, checks: task.checks, inputs, slot: true,
			createdAt: timestamp(), ...(task.currentAttemptId ? { repairOf: task.currentAttemptId } : {}),
			...(localRepairOf !== undefined && task.owner !== actor ? { assignedOwner: task.owner } : {}) });
		task.currentAttemptId = attempt.id;
		task.state = "running";
		delete task.waiting;
		delete task.repairReservation;
		put("attempts", attempt);
		put("tasks", task);
		if (localRepairOf !== undefined) {
			for (const claim of list("claims", "WHERE json_extract(document,'$.attemptId')=?", [localRepairOf])) {
				db.prepare("DELETE FROM claims WHERE id=?").run(claim.id);
				put("claims", { ...claim, id: randomUUID(), attemptId: attempt.id });
			}
		}
		return attempt;
	}
	/** @param {string} attemptId @param {string} nativeId @param {string} actor @param {Json} [receipt] @param {boolean} [local] @returns {Attempt} */
	function bind(attemptId, nativeId, actor, receipt, local = false) {
		const attempt = get("attempts", attemptId);
		const task = get("tasks", attempt.taskId);
		requireReporter(attempt, text(actor, "actor"));
		text(nativeId, "nativeId");
		const stale = task.currentAttemptId !== attemptId || task.version !== attempt.taskVersion;
		if (stale && attempt.nativeId !== undefined) {
			if (attempt.nativeId !== nativeId) throw new FoundryError("binding_conflict", "A historical native identity cannot be rebound");
			return attempt;
		}
		const creation = optional("effects", `create:${attemptId}`);
		if (stale && (attempt.state !== "cancelled" || !creation || creation.state === "prepared"
			|| creation.result !== undefined && record(creation.result).neverIssued === true)) {
			throw new FoundryError("stale_attempt", "Cannot bind an unissued superseded attempt");
		}
		if (attempt.nativeId && attempt.nativeId !== nativeId) throw new FoundryError("binding_conflict", "Attempt is already bound to another native identity");
		const firstBinding = !attempt.nativeId;
		if (firstBinding && !local && list("attempts", "WHERE native_id=? AND id NOT IN (SELECT attempt_id FROM local_attempts)", [nativeId])
			.some((other) => other.taskId !== task.id)) throw new FoundryError("binding_conflict", "Native identity already owns another task");
		attempt.nativeId = nativeId;
		if (!stale && firstBinding && attempt.assignedOwner === undefined) task.owner = nativeId;
		for (const effect of list("effects", "WHERE attempt_id=? AND kind='create' AND state<>'settled'", [attemptId])) {
			effect.state = "settled";
			effect.result = receipt === undefined ? { nativeId } : json(receipt);
			put("effects", effect);
		}
		if (stale) attempt.state = "cancelled";
		else if (task.state === "cancelled" || ancestors(task).some((parent) => parent.state === "cancelled")) {
			task.state = "cancelled";
			attempt.state = "cancelled";
		} else if (firstBinding) attempt.state = task.state === "waiting" ? "waiting" : "running";
		put("tasks", task);
		put("attempts", attempt);
		for (const observation of list("native_usage", "WHERE native_id=? AND goal_id IS NULL", [nativeId])) settleUsage(observation);
		if (firstBinding && !stale) rerouteWakes(task.goalId);
		if (attempt.state === "cancelled") scheduleStop(attempt, actor);
		releaseSlot(get("attempts", attemptId));
		return get("attempts", attemptId);
	}
	/** @param {Attempt} attempt @param {string} actor */
	function scheduleStop(attempt, actor, reason = "cancelled") {
		if (!attempt.nativeId) return;
		const local = db.prepare("SELECT attempt_id FROM local_attempts WHERE attempt_id=?").get(attempt.id) !== undefined;
		const commands = attemptEffects(attempt.id, "AND kind='command' AND state IN ('issued','uncertain')");
		if (local && !commands.length && attempt.nativeId === actor) return;
		const id = `stop:${attempt.id}:${attempt.nativeId}`;
		if (!optional("effects", id)) put("effects", {
			id, attemptId: attempt.id, kind: "stop", state: "prepared",
			owner: actor,
			request: { nativeId: attempt.nativeId, reason,
				effectIds: commands.map((effect) => effect.id) },
		});
	}
	/** @param {Task} task @param {Attempt} attempt @param {Result} result */
	function canPromote(task, attempt, result) {
		if (task.currentAttemptId !== attempt.id || task.version !== attempt.taskVersion
			|| task.state === "cancelled" || ancestors(task).some((parent) => parent.state === "cancelled")
			|| attempt.nativeId !== result.sender || !["running", "waiting"].includes(task.state)
			|| ["done", "failed", "cancelled"].includes(attempt.state)
			|| checksDigest(task.checks) !== checksDigest(attempt.checks)) return false;
		if (optional("goal_completions", task.goalId)) {
			const completion = get("goal_completions", task.goalId);
			const factory = get("factory_controls", completion.factoryId);
			if (factory.state !== "active" || factory.pausedWorkers.includes(task.owner)
				|| attempt.nativeId !== undefined && factory.pausedWorkers.includes(attempt.nativeId)) return false;
			if (result.state === "done" && result.outputs.some(output => output.kind === "code")
				&& (!attempt.checks.length || attempt.checks.some(check => !check.artifactFiles?.length))) {
				throw new FoundryError("unattended_acceptance", "Factory code delivery requires executable checks bound to its evaluated files");
			}
		}
		const inputs = resolvedInputs(task);
		if (!inputs || digest(json(inputs)) !== digest(json(attempt.inputs))) return false;
		const observations = admittedEvidence(attempt.id);
		const admitted = new Map(observations.map(evidence => [evidence.id, evidence]));
		const latest = latestEvidence(observations);
		if (result.evidence.some((evidence) => {
			const check = attempt.checks.find((item) => item.id === evidence.checkId && item.version === evidence.checkVersion);
			const actual = admitted.get(evidence.id);
			return evidence.attemptId !== attempt.id || !check
				|| !actual || digest(json(actual)) !== digest(json(evidence));
		})) return false;
		if (result.state === "done" && attempt.checks.some((check) => {
			const evidence = latest.get(JSON.stringify([check.id, check.version]));
			return !evidence || evidence.outcome !== "passed" || !result.evidence.some((item) => item.id === evidence.id);
		})) return false;
		if (result.state === "done") for (const input of attempt.inputs) {
			const output = inputOutput(input);
			if (output) readCandidate(output.reference, output.version, databasePath);
		}
		const completion = optional("goal_completions", task.goalId);
		if (result.state === "done" && completion?.taskId === task.id) {
			const closure = productionClosure(completion);
			if (closure.some(producer => producer.id !== task.id && producer.state !== "done")) return false;
			completion.accepted = { revision: completion.revision, tasks: closure.map(producer => ({
				id: producer.id, version: producer.version, inputs: resolvedInputs(producer) ?? [],
			})) };
			completion.closed = true;
			put("goal_completions", completion);
		}
		return true;
	}
	/** @param {Task} task */
	function notifyOutcome(task) {
		const owner = task.parentId ? get("tasks", task.parentId).owner : get("goals", task.goalId).owner;
		wake(owner, task.goalId, `output:${task.id}`);
	}
	/** @param {Result} result @param {boolean} [quiet] */
	function promote(result, quiet = false) {
		const attempt = get("attempts", result.attemptId);
		const task = get("tasks", attempt.taskId);
		if (!canPromote(task, attempt, result)) return false;
		if (result.state === "done") {
			result.outputs = bindCandidateOutputs(attempt.checks, admittedEvidence(attempt.id), result.outputs, databasePath);
			for (const output of result.outputs) {
				const published = inputOutput({ taskId: task.id, output: output.name, version: output.version });
				if (published && digest(json(published)) !== digest(json(output))) {
					throw new FoundryError("output_version_conflict", "A published output version cannot change its reference or meaning");
				}
			}
		}
		task.state = result.state;
		delete task.waiting;
		if (result.state === "done") task.outputs = result.outputs;
		attempt.state = result.state === "done" ? "done" : "failed";
		attempt.endedBy = result.reportedBy ?? result.sender;
		put("tasks", task);
		put("attempts", attempt);
		releaseSlot(attempt, !quiet, quiet && result.state === "failed");
		if (!quiet) notifyOutcome(task);
		if (result.state === "done") {
			const consumers = db.prepare("SELECT DISTINCT task_id FROM dependencies WHERE producer_id=?").all(task.id);
			for (const row of consumers) {
				const consumer = get("tasks", text(row.task_id, "consumer"));
				if (runnable(consumer)) wake(consumer.owner, consumer.goalId, `output:${task.id}`);
			}
		}
		return true;
	}
	/** @param {string} attemptId @param {string} [effectId] @returns {import("./model.d.ts").Evidence[]} */
	function admittedEvidence(attemptId, effectId) {
		return db.prepare(`SELECT document FROM evidence_admissions WHERE attempt_id=?
			${effectId === undefined ? "" : "AND effect_id=?"} ORDER BY sequence`)
			.all(...(effectId === undefined ? [attemptId] : [attemptId, effectId])).map((row) => {
			/** @type {unknown} */
			const parsed = JSON.parse(text(row.document, "admitted evidence"));
			return decodeEvidence(parsed);
		});
	}
	/** @param {import("./model.d.ts").Check[]} checks */
	function checksDigest(checks) {
		return digest(json(checks.map(({ requirement: _prose, ...check }) => check).sort((a, b) => a.id.localeCompare(b.id))));
	}
	/** @param {import("./model.d.ts").Check[]} checks @param {import("./model.d.ts").Scope} scope */
	function checkArtifactScope(checks, scope) {
		for (const name of checks.flatMap(check => check.artifactFiles ?? [])) {
			if (name === "." || name.split("/")[0] === ".git" || !scope.paths.some(base => containsPath(base, name))) {
				throw new FoundryError("artifact_scope", `Declared artifact must be an implementation file inside this task's paths: ${name}`);
			}
		}
	}
	/** @param {Effect} effect */
	function admitEffectEvidence(effect) {
		if (effect.kind !== "command" || effect.state !== "settled" || effect.result === null
			|| typeof effect.result !== "object" || Array.isArray(effect.result) || effect.result.evidence === undefined) return;
		const observations = Array.isArray(effect.result.evidence) ? effect.result.evidence : [effect.result.evidence];
		for (const value of observations) {
			const evidence = decodeEvidence(value);
			const existing = db.prepare("SELECT document FROM evidence_admissions WHERE id=?").get(evidence.id);
			if (existing) {
				/** @type {unknown} */
				const parsed = JSON.parse(text(existing.document, "admitted evidence"));
				if (digest(json(decodeEvidence(parsed))) !== digest(json(evidence))) {
					throw new FoundryError("evidence_identity_conflict", "An observation identity cannot change its assigned attempt or content");
				}
				continue;
			}
			db.prepare("INSERT INTO evidence_admissions(id,attempt_id,effect_id,check_id,check_version,document) VALUES(?,?,?,?,?,?)")
				.run(evidence.id, evidence.attemptId, effect.id, evidence.checkId, evidence.checkVersion, JSON.stringify(evidence));
		}
	}

	/** @param {GoalInput} input @param {string} actor @returns {Goal} */
	function insertGoal(input, actor) {
		text(actor, "actor");
		if (list("tasks", "WHERE owner=?", [actor]).some((task) => get("goals", task.goalId).owner !== actor)
			|| list("attempts", "WHERE native_id=?", [actor]).some((attempt) => get("goals", get("tasks", attempt.taskId).goalId).owner !== actor)) {
			throw new FoundryError("forbidden", "Delegated workers cannot create root goals");
		}
		const goal = decodeGoal({ ...record(input), id: newId("goals", input.id), owner: actor,
			limits: input.limits ?? {}, credits: 0, createdAt: timestamp() });
		put("goals", goal);
		return goal;
	}
	/** @param {TaskInput} input @param {string} actor @returns {Task} */
	function insertTask(input, actor) {
		const goal = get("goals", input.goalId);
		const completion = optional("goal_completions", goal.id);
		if (completion) {
			requireAdmission(get("tasks", completion.taskId));
			if (completion.closed) throw new FoundryError("job_closed", "Reopen this bounded job explicitly before admitting new required work");
		}
		const parent = input.parentId === undefined ? undefined : get("tasks", input.parentId);
		if (parent) {
			requireOwner(parent, actor);
			uncancelled(parent);
			if (parent.goalId !== goal.id) throw new FoundryError("invalid_parent", "Parent must belong to the task's goal");
			if (!parent.scope.delegation) throw new FoundryError("delegation_forbidden", "This parent cannot delegate");
		} else requireGoalOwner(goal, actor);
		if (input.teamId !== undefined && get("teams", input.teamId).goalId !== goal.id) {
			throw new FoundryError("invalid_team", "Team must belong to the task's goal");
		}
		const task = decodeTask({ ...record(input), id: newId("tasks", input.id), owner: actor,
			scope: narrowScope(parent?.scope ?? goal.scope, input.scope), checks: input.checks ?? [],
			inputs: input.inputs ?? [], outputs: [], state: "ready", version: 1, currentAttemptId: undefined, waiting: undefined });
		if (completion && !task.dispatch) {
			const factory = get("factory_controls", completion.factoryId);
			task.dispatch = compileFactoryContext(factory.definition, factory.source);
		}
		if (completion && task.scope.mode !== goal.scope.mode) {
			throw new FoundryError("continuation_conflict", "Factory tasks must retain their one accepted continuation mode; ordinary goals still support mode narrowing");
		}
		if (!task.scope.workTypes.includes("*") && !task.scope.workTypes.includes(task.workType)) {
			throw new FoundryError("work_type_forbidden", "Task work type is outside its scope");
		}
		if (new Set(task.checks.map((check) => check.id)).size !== task.checks.length) {
			throw new FoundryError("duplicate_check", "Check identities must be unique");
		}
		checkArtifactScope(task.checks, task.scope);
		for (const input of task.inputs) {
			if (input.taskId === task.id) throw new FoundryError("dependency_cycle", "A task cannot consume itself");
			get("tasks", input.taskId);
			const cycle = db.prepare(`WITH RECURSIVE upstream(id) AS (
				SELECT producer_id FROM dependencies WHERE task_id=?
				UNION SELECT d.producer_id FROM dependencies d JOIN upstream u ON d.task_id=u.id
			) SELECT id FROM upstream WHERE id=? LIMIT 1`).get(input.taskId, task.id);
			if (cycle) throw new FoundryError("dependency_cycle", "Artifact dependencies must be acyclic");
		}
		put("tasks", task);
		for (const input of task.inputs) db.prepare("INSERT INTO dependencies(task_id,producer_id,output,version) VALUES(?,?,?,?)")
			.run(task.id, input.taskId, input.output, input.version ?? null);
		return task;
	}
	/** @param {Task} task @param {string} actor */
	function revise(task, actor) {
		if (task.currentAttemptId) {
			const attempt = get("attempts", task.currentAttemptId);
			if (task.waiting?.kind === "input") attempt.waiting = task.waiting;
			if (!["done", "failed", "cancelled"].includes(attempt.state) || outstanding(attempt, true)) {
				attempt.state = "cancelled";
				attempt.endedBy = actor;
				put("attempts", attempt);
				retirePrepared(attempt, "superseded");
				scheduleStop(attempt, actor, "superseded");
			}
			releaseSlot(attempt);
		}
		task.version++;
		task.state = "ready";
		task.outputs = [];
		delete task.waiting;
		delete task.repairReservation;
		put("tasks", task);
		wake(task.owner, task.goalId, `revision:${task.id}`);
	}

	/** @param {import("./model.d.ts").NativeUsage} observation */
	function settleUsage(observation) {
		let attempts = observation.attemptIds.map(id => get("attempts", id));
		if (!attempts.length && observation.token) {
			const candidate = list("attempts", "WHERE json_extract(document,'$.token')=? AND native_id=?",
				[observation.token, observation.nativeId])[0];
			if (candidate) attempts = [candidate];
		}
		if (attempts.some(attempt => attempt.nativeId !== observation.nativeId)) {
			throw new FoundryError("foreign_usage", "Usage can only debit its actual native execution");
		}
		const goalIds = [...new Set(attempts.map(attempt => get("tasks", attempt.taskId).goalId))];
		if (goalIds.length === 1) {
			observation.goalId = goalIds[0];
			observation.attemptIds = attempts.map(attempt => attempt.id);
			if (attempts.length === 1) observation.attemptId = attempts[0].id;
		}
		if (observation.goalId && observation.credits !== undefined && observation.debitedCredits === undefined) {
			const manual = db.prepare("SELECT attempt_id,credits FROM usage WHERE event_id IN (SELECT value FROM json_each(?))")
				.all(JSON.stringify(observation.aliases));
			if (manual.length > 1 || manual.some(row => row.credits !== observation.credits
				|| !observation.attemptIds.includes(text(row.attempt_id, "usage attempt")))) {
				throw new FoundryError("usage_identity_conflict", "The same native charge has conflicting manual observations");
			}
			if (!manual.length) {
				const goal = get("goals", observation.goalId);
				goal.credits = number(goal.credits + observation.credits, "total observed credits");
				put("goals", goal);
			}
			observation.debitedCredits = observation.credits;
		}
		put("native_usage", observation);
		return observation;
	}

	/** @param {string} taskId @param {string} actor @param {string} [localRepairOf] @returns {Attempt|FoundryError} */
	function startLocal(taskId, actor, localRepairOf) {
		const task = get("tasks", taskId);
		if (task.repairReservation) localRepairOf = task.repairReservation.attemptId;
		if (localRepairOf === undefined) requireOwner(task, actor);
		uncancelled(task);
		if (task.currentAttemptId) {
			const existing = get("attempts", task.currentAttemptId);
			if (existing.nativeId === actor && db.prepare("SELECT attempt_id FROM local_attempts WHERE attempt_id=?").get(existing.id)
				&& task.state === "running" && existing.state === "running" && existing.slot) return existing;
		}
		const attempt = prepare(taskId, actor, localRepairOf);
		if (attempt instanceof FoundryError) return attempt;
		if (list("effects", "WHERE attempt_id=? AND kind='create'", [attempt.id]).length) {
			throw new FoundryError("invalid_transition", "A prepared native creation cannot be silently converted to local execution");
		}
		db.prepare("INSERT INTO local_attempts(attempt_id) VALUES(?)").run(attempt.id);
		return bind(attempt.id, actor, actor, undefined, true);
	}

	/** @param {Omit<Result, "createdAt" | "sender">} input @param {string} actor @param {string} [reportedSender] @param {boolean} [quiet] */
	function saveResult(input, actor, reportedSender, quiet = false) {
		text(actor, "actor");
		const attempt = get("attempts", input.attemptId);
		const task = get("tasks", attempt.taskId);
		const sender = reportedSender === undefined ? actor : text(reportedSender, "reportedSender");
		if (reportedSender !== undefined) requireOwner(task, actor);
		else if (attempt.nativeId) requireReporter(attempt, actor);
		else if (list("tasks", "WHERE owner=?", [actor]).length && !authorized(task, actor)) {
			throw new FoundryError("forbidden", "A sibling cannot report another worker's result");
		}
		const existing = optional("results", input.id);
		const result = decodeResult({ ...record(input), sender,
			reportedBy: existing === undefined ? actor : existing.reportedBy, createdAt: existing?.createdAt ?? timestamp() });
		if (new Set(result.outputs.map((output) => output.name)).size !== result.outputs.length
			|| new Set(result.evidence.map((evidence) => evidence.id)).size !== result.evidence.length) {
			throw new FoundryError("duplicate_evidence", "Output names and evidence identities must be unique within a result");
		}
		if (existing) {
			const alreadyPromoted = db.prepare("SELECT promoted FROM outcomes WHERE result_id=?").get(existing.id)?.promoted === 1;
			if (alreadyPromoted && result.state === "done") {
				const reported = new Set(existing.evidence.map(evidence => evidence.id));
				result.outputs = normalizeCandidateOutputs(attempt.checks,
					admittedEvidence(attempt.id).filter(evidence => reported.has(evidence.id)), result.outputs, databasePath);
			}
			if (digest(json(existing)) !== digest(json(result))) throw new FoundryError("result_identity_conflict", "A result identity cannot be reused for a different observation");
			const promoted = alreadyPromoted || promote(existing, quiet);
			put("results", existing);
			db.prepare("UPDATE outcomes SET promoted=? WHERE result_id=?").run(promoted ? 1 : 0, existing.id);
			return { result: existing, promoted };
		}
		const promoted = promote(result, quiet);
		put("results", result);
		db.prepare("INSERT INTO outcomes(result_id,promoted) VALUES(?,?)").run(result.id, promoted ? 1 : 0);
		return { result, promoted };
	}

	/** @param {string} taskId @param {string} expectedAttemptId @param {string} actor @param {boolean} [notify] @param {boolean} [execution] */
	function retry(taskId, expectedAttemptId, actor, notify = true, execution = false) {
		const task = get("tasks", taskId);
		if (!execution || get("attempts", expectedAttemptId).nativeId !== actor) requireOwner(task, actor);
		uncancelled(task);
		const factory = requireAdmission(task);
		if (task.currentAttemptId !== text(expectedAttemptId, "expectedAttemptId") || !["failed", "blocked"].includes(task.state)) {
			throw new FoundryError("stale_attempt", "Repair requires the current failed or blocked attempt");
		}
		const goal = get("goals", task.goalId);
		const repairs = task.repairs ?? 0;
		if (factory?.unchangedFailures !== undefined) {
			/** @param {Attempt} attempt */
			const fingerprint = attempt => {
				const evidence = db.prepare(`SELECT e.document FROM evidence_admissions e JOIN effects f ON e.effect_id=f.id
					WHERE e.attempt_id=? AND json_extract(f.document,'$.factoryGeneration')=? ORDER BY e.sequence`)
					.all(attempt.id, factory.generation).map(row => decodeEvidence(/** @type {unknown} */ (JSON.parse(text(row.document, "failure evidence")))));
				const latest = [...latestEvidence(evidence).values()];
				const failures = latest.filter(item => item.outcome === "failed");
				return failures.length ? digest(json({ inputs: attempt.inputs, failures: failures.map(item => ({ check: item.checkId, version: item.checkVersion,
					candidate: item.candidate?.version ?? null, blocker: item.blocker ?? null }))
					.sort((a, b) => a.check.localeCompare(b.check)) })) : undefined;
			};
			let attempt = get("attempts", expectedAttemptId);
			const currentFailure = fingerprint(attempt);
			let unchanged = currentFailure === undefined ? 0 : 1;
			while (currentFailure && attempt.repairOf) {
				attempt = get("attempts", attempt.repairOf);
				if (fingerprint(attempt) !== currentFailure) break;
				unchanged++;
			}
			if (unchanged >= factory.unchangedFailures) throw new FoundryError("stagnation", "Unchanged evaluated failures reached the authorized stop rule; explicit restart or revised work is required");
		}
		if (goal.limits.repairs !== undefined && repairs >= goal.limits.repairs) {
			throw new FoundryError("repair_limit", "The explicitly allowed additional attempts are exhausted");
		}
		const completion = optional("goal_completions", task.goalId);
		if (completion && factory?.aggregateRepairs !== undefined) {
			if (completion.repairs >= factory.aggregateRepairs) throw new FoundryError("repair_limit", "The goal's explicit aggregate repair allowance is exhausted");
			completion.repairs++;
			put("goal_completions", completion);
		}
		task.state = "ready";
		task.version++;
		task.repairs = repairs + 1;
		if (execution) task.repairReservation = { attemptId: expectedAttemptId, worker: actor };
		task.outputs = [];
		delete task.waiting;
		put("tasks", task);
		if (notify) wake(task.owner, task.goalId, `repair:${task.id}`);
		return task;
	}

	/** @param {Delivery} delivery @param {Json} result */
	function finishDelivery(delivery, result) {
		put("deliveries", { ...delivery, state: "settled", result });
	}

	/** @param {GoalInput} input @param {Array<Omit<TaskInput,"goalId">>} tasks @param {string} factoryId @param {string} completionTaskId @param {string} actor @param {number} [generation] @param {boolean} [validation] */
	function admitFactoryJob(input, tasks, factoryId, completionTaskId, actor, generation, validation = false) {
		const factory = get("factory_controls", factoryId);
		if (factory.owner !== actor || factory.state !== "active") throw new FoundryError("factory_paused", "Only the active factory's actual coordinator can admit source work");
		if (generation !== undefined && factory.generation !== generation) throw new FoundryError("stale_activation", "Source observation belongs to a revoked activation");
		const accepted = record(record(factory.definition).goal);
		const scope = narrowScope(decodeScope(accepted.scope), input.scope);
		if (scope.mode !== record(accepted.scope).mode || input.projectId !== accepted.projectId
			|| digest(json(input.limits ?? {})) !== digest(json(decodeLimits(accepted.limits ?? {})))) {
			throw new FoundryError("factory_policy_mismatch", "Job mode, project and per-job limits must retain their accepted factory policy");
		}
		const existing = input.id === undefined ? undefined : optional("goals", input.id);
		if (existing) {
			const completion = get("goal_completions", existing.id);
			if (completion.factoryId !== factoryId || digest(json(existing.source ?? null)) !== digest(json(input.source ?? null))) {
				throw new FoundryError("source_conflict", "A source event identity cannot change its accepted definition");
			}
			return { goal: existing, tasks: list("tasks", "WHERE goal_id=?", [existing.id]), replay: true };
		}
		const unsettled = list("goal_completions", "WHERE json_extract(document,'$.factoryId')=?", [factoryId])
			.filter(completion => { const status = completionStatus(completion); return !(status.delivered || status.cancelled) || !status.settled; });
		if (!validation && unsettled.length >= factory.maximumJobs) throw new FoundryError("factory_capacity", "The factory's explicitly authorized active-job bound is exhausted");
		const goal = insertGoal({ ...input, scope }, actor);
		const admitted = tasks.map(task => insertTask({ ...task, goalId: goal.id }, actor));
		const final = get("tasks", completionTaskId);
		if (final.goalId !== goal.id || !final.checks.length) throw new FoundryError("unattended_acceptance", "Factory completion requires its own executable acceptance checks");
		if (admitted.some(task => task.scope.mode !== goal.scope.mode)) {
			throw new FoundryError("continuation_conflict", "Factory tasks must retain one accepted continuation mode");
		}
		const completion = decodeCompletion({ id: goal.id, goalId: goal.id, owner: actor, taskId: final.id,
			factoryId, revision: 1, closed: false, requiredInputs: final.inputs, repairs: 0 });
		productionClosure(completion);
		put("goal_completions", completion);
		return { goal, tasks: admitted, replay: false };
	}

	return {
		databasePath,
		/** @param {string} id @param {string} actor */
		factory(id, actor) {
			return transaction(() => {
				const factory = get("factory_controls", id);
				if (factory.owner !== actor) throw new FoundryError("forbidden", "Only the actual factory owner can manage its policy");
				return factory;
			}, false);
		},
		/** @param {string} actor */
		factoryViews(actor) {
			return transaction(() => list("factory_controls", "WHERE owner=?", [actor]).map(factory => ({
				id: factory.id, state: factory.state, generation: factory.generation, source: factory.source,
				reason: factory.reason, heartbeat: factory.heartbeat === undefined ? undefined : {
					state: factory.heartbeat.state, id: factory.heartbeat.id, minutes: factory.heartbeat.request.every_minutes,
				},
			})), false);
		},
		/** @param {Omit<Factory,"owner"|"state"|"generation"|"pausedWorkers"|"reminders">} input @param {string} actor @param {{goal:GoalInput,tasks:Array<Omit<TaskInput,"goalId">>,completionTaskId:string}} initial */
		activateFactory(input, actor, initial) {
			return transaction(() => {
				const existing = optional("factory_controls", input.id);
				if (existing && (existing.owner !== actor || digest(existing.definition) !== digest(input.definition)
					|| digest(json(existing.source)) !== digest(json(input.source)))) {
					throw new FoundryError("factory_conflict", "Factory identity cannot change its native owner or accepted policy snapshot");
				}
				const factory = decodeFactory({ ...input, owner: actor, state: "active",
					generation: (existing?.generation ?? 0) + 1, pausedWorkers: [], reminders: {},
					...(existing?.heartbeat === undefined ? {} : { heartbeat: existing.heartbeat }),
					...(existing?.sourceCursor === undefined ? {} : { sourceCursor: existing.sourceCursor }) });
				put("factory_controls", factory);
				for (const completion of list("goal_completions", "WHERE json_extract(document,'$.factoryId')=?", [factory.id])) {
					for (const task of list("tasks", "WHERE goal_id=? AND state='blocked'", [completion.goalId])) {
						if (!task.currentAttemptId || task.waiting?.kind !== "factory") continue;
						const attempt = get("attempts", task.currentAttemptId);
						if (attempt.state !== "waiting" || outstanding(attempt, true)) continue;
						task.state = "waiting";
						put("tasks", task);
						wake(attempt.nativeId ?? task.owner, task.goalId, "capacity");
					}
				}
				if (record(factory.definition).source !== undefined) {
					db.exec("SAVEPOINT factory_template");
					try { admitFactoryJob(initial.goal, initial.tasks, factory.id, initial.completionTaskId, actor, factory.generation, true); }
					finally { db.exec("ROLLBACK TO factory_template; RELEASE factory_template"); }
					return { factory, tasks: [], replay: false };
				}
				return { factory, ...admitFactoryJob(initial.goal, initial.tasks, factory.id, initial.completionTaskId, actor, factory.generation) };
			});
		},
		/** @param {string} actor @param {string} reason @param {string} [factoryId] */
		pauseFactories(actor, reason, factoryId) {
			return transaction(() => {
				const completions = list("goal_completions", factoryId === undefined ? "" : "WHERE json_extract(document,'$.factoryId')=?", factoryId === undefined ? [] : [factoryId]);
				const changed = new Map();
				for (const factory of list("factory_controls", "WHERE owner=?", [actor])) {
					if (factoryId !== undefined && factory.id !== factoryId) continue;
					factory.state = "paused";
					factory.generation++;
					factory.reason = text(reason, "pause reason");
					put("factory_controls", factory);
					changed.set(factory.id, factory);
				}
				for (const completion of completions) {
					const factory = get("factory_controls", completion.factoryId);
					if (factory.owner !== actor && !list("attempts", "WHERE native_id=? AND task_id IN (SELECT id FROM tasks WHERE goal_id=?)", [actor, completion.goalId]).length) continue;
					if (factory.owner !== actor) factory.pausedWorkers = [...new Set([...factory.pausedWorkers, actor])];
					factory.reason = text(reason, "pause reason");
					put("factory_controls", factory);
					changed.set(factory.id, factory);
					for (const task of list("tasks", "WHERE goal_id=?", [completion.goalId])) {
						if (!task.currentAttemptId) continue;
						const attempt = get("attempts", task.currentAttemptId);
						if (factory.owner !== actor && attempt.nativeId !== actor) continue;
						if (attempt.state === "prepared") revise(task, actor);
						else retirePrepared(attempt, "factory paused");
						if (attempt.nativeId === actor) parkPausedExecution(attempt);
					}
				}
				if (factoryId !== undefined && !changed.size) throw new FoundryError("forbidden", "This caller cannot pause that factory");
				return [...changed.values()];
			});
		},
		/** @param {string} goalId @param {string} actor */
		reopenCompletion(goalId, actor) {
			return transaction(() => {
				const completion = get("goal_completions", goalId);
				const factory = get("factory_controls", completion.factoryId);
				if (factory.owner !== actor) throw new FoundryError("forbidden", "Only the factory owner can reopen its bounded job");
				const task = get("tasks", completion.taskId);
				requireAdmission(task, undefined, true);
				if (!completion.closed) return completion;
				completion.closed = false;
				completion.revision++;
				delete completion.accepted;
				put("goal_completions", completion);
				revise(task, actor);
				return completion;
			});
		},
		/** @param {GoalInput} input @param {Array<Omit<TaskInput,"goalId">>} tasks @param {string} factoryId @param {string} completionTaskId @param {string} actor @param {number} [generation] */
		admitFactoryJob(input, tasks, factoryId, completionTaskId, actor, generation) {
			return transaction(() => admitFactoryJob(input, tasks, factoryId, completionTaskId, actor, generation));
		},
		/** @param {string} factoryId @param {string} actor @param {number} generation @param {string|undefined} cursor */
		updateSourceCursor(factoryId, actor, generation, cursor) {
			return transaction(() => {
				const factory = get("factory_controls", factoryId);
				if (factory.owner !== actor || factory.state !== "active" || factory.generation !== generation) {
					throw new FoundryError("stale_activation", "Do not move an intake cursor after its actual owner or activation changed");
				}
				if (cursor === undefined) delete factory.sourceCursor;
				else factory.sourceCursor = text(cursor, "native intake cursor");
				put("factory_controls", factory);
				return factory;
			});
		},
		/** @param {string} actor @param {string} [goalId] */
		advance(actor, goalId) {
			return transaction(() => list("goal_completions", goalId === undefined ? "" : "WHERE goal_id=?", goalId === undefined ? [] : [goalId])
				.filter(completion => goalMember(get("goals", completion.goalId), actor)).map(completion => {
					const factory = get("factory_controls", completion.factoryId);
					const status = completionStatus(completion);
					const own = list("tasks", "WHERE goal_id=?", [completion.goalId]).filter(task => task.owner === actor
						|| task.repairReservation?.worker === actor || task.currentAttemptId !== undefined && get("attempts", task.currentAttemptId).nativeId === actor);
					const input = own.some(task => task.waiting?.kind === "input");
					const actions = own.filter(task => !factory.pausedWorkers.includes(task.owner)
						&& !factory.pausedWorkers.includes(actor)).flatMap(task => {
						if (task.state === "running" && task.currentAttemptId) {
							const attempt = get("attempts", task.currentAttemptId);
							if (attempt.nativeId === actor && !outstanding(attempt, true)) return [{ taskId: task.id, kind: "execute" }];
							if (preparedDispatch(task)) return [{ taskId: task.id, kind: "dispatch" }];
						}
						if (!runnable(task) || !hasSlot(get("goals", task.goalId)) || !budgetAvailable(get("goals", task.goalId))) return [];
						if (task.repairReservation) return task.repairReservation.worker === actor ? [{ taskId: task.id, kind: "repair" }] : [];
						if (task.state === "waiting") return task.currentAttemptId && get("attempts", task.currentAttemptId).nativeId === actor
							? [{ taskId: task.id, kind: "resume" }] : [];
						return task.owner === actor ? [{ taskId: task.id, kind: "dispatch" }] : [];
					});
					return { ...status, generation: factory.generation, mechanism: factory.mechanism,
						disposition: factory.state === "paused" || factory.pausedWorkers.includes(actor) ? "paused"
							: status.cancelled ? "cancelled" : status.delivered ? "delivered" : input ? "needs-input" : actions.length ? "actionable" : "waiting",
						actions: factory.state === "active" && !input ? actions : [] };
				}), false);
		},
		/** @param {string} factoryId @param {string} actor @param {number} generation @param {boolean} [reentry] */
		remindFactory(factoryId, actor, generation, reentry = false) {
			return transaction(() => {
				const factory = get("factory_controls", factoryId);
				if (factory.state !== "active" || factory.generation !== generation || factory.pausedWorkers.includes(actor)
					|| factory.mechanism !== "stop-hook") return;
				const own = list("tasks", `WHERE (owner=? OR json_extract(document,'$.currentAttemptId') IN (SELECT id FROM attempts WHERE native_id=?))
					AND goal_id IN (SELECT goal_id FROM goal_completions WHERE json_extract(document,'$.factoryId')=?)`, [actor, actor, factoryId])
					.filter(task => ["running", "ready", "waiting"].includes(task.state));
				if (!own.length || own.some(task => task.waiting?.kind === "input")) return;
				if (list("wakes", "WHERE owner=? AND json_extract(document,'$.sent')>json_extract(document,'$.consumed')", [actor]).length) return;
				const marker = digest(json(own.map(task => ({ id: task.id, version: task.version, state: task.state,
					evidence: [...new Map((task.currentAttemptId ? admittedEvidence(task.currentAttemptId) : []).map(item => [
						JSON.stringify([item.checkId, item.checkVersion]),
						{ checkId: item.checkId, checkVersion: item.checkVersion, outcome: item.outcome, candidate: item.candidate?.version ?? null },
					])).values()] }))));
				const previous = factory.reminders[actor];
				const count = previous?.generation === generation ? previous.count + 1 : 1;
				factory.reminders[actor] = { marker, count, generation };
				if (count > factory.blocks || reentry && previous?.generation === generation && previous.marker === marker) {
					factory.pausedWorkers = [...new Set([...factory.pausedWorkers, actor])];
					factory.reason = "continuation_stalled";
					if (factory.owner === actor) { factory.state = "paused"; factory.generation++; }
					put("factory_controls", factory);
					for (const task of own) {
						if (task.currentAttemptId) {
							const attempt = get("attempts", task.currentAttemptId);
							if (attempt.nativeId === actor) parkPausedExecution(attempt, "stalled");
						}
					}
					return { paused: true, reason: "continuation_stalled" };
				}
				put("factory_controls", factory);
				return { decision: /** @type {const} */ ("block"), reason: `Foundry continuation ${factory.id}:${generation}. Read foundry_advance and execute only its current locally owned actions. This reminder grants no authority.` };
			});
		},
		/** @param {string} factoryId @param {Factory["heartbeat"]} heartbeat @param {string} actor @param {number} generation */
		recordHeartbeat(factoryId, heartbeat, actor, generation) {
			return transaction(() => {
				const factory = get("factory_controls", factoryId);
				if (factory.owner !== actor || factory.generation !== generation) {
					throw new FoundryError("stale_activation", "Native heartbeat binding must retain its actual owner and current activation");
				}
				if (heartbeat?.state === "issued") {
					if (factory.state !== "active") throw new FoundryError("factory_paused", "Paused factories cannot issue a heartbeat");
					if (factory.heartbeat) throw new FoundryError("heartbeat_pending", "Reconcile the original native heartbeat instead of issuing another");
					if (list("factory_controls", "WHERE owner=?", [actor]).some(other => other.id !== factoryId && other.heartbeat)) {
						throw new FoundryError("heartbeat_conflict", "One actual session can have only one owned factory heartbeat");
					}
				}
				if (heartbeat === undefined) delete factory.heartbeat;
				else factory.heartbeat = heartbeat;
				put("factory_controls", factory);
				return factory;
			});
		},
		/** @param {string} taskId @param {string} actor @param {boolean} [execution] */
		taskForCaller(taskId, actor, execution = false) {
			return transaction(() => accessibleTask(taskId, actor, execution), false);
		},
		close() {
			if (!closed) { db.close(); closed = true; }
		},
		/** @param {GoalInput} input @param {string} actor @returns {Goal} */
		createGoal(input, actor) {
			return transaction(() => insertGoal(input, actor));
		},
		/** @param {GoalInput} input @param {Array<Omit<TaskInput, "goalId">>} tasks @param {string} actor */
		createGoalWithTasks(input, tasks, actor) {
			return transaction(() => {
				const goal = insertGoal(input, actor);
				return { goal, tasks: tasks.map(task => insertTask({ ...task, goalId: goal.id }, actor)) };
			});
		},
		/** @param {{id?: string, goalId: string, name: string, context?: string[]}} input @param {string} actor @returns {Team} */
		createTeam(input, actor) {
			return transaction(() => {
				const goal = get("goals", input.goalId);
				if (goal.owner !== text(actor, "actor")
					&& !list("tasks", "WHERE goal_id=? AND owner=?", [goal.id, actor])
						.some((task) => task.scope.delegation && task.state !== "cancelled"
							&& !ancestors(task).some((parent) => parent.state === "cancelled"))) {
					throw new FoundryError("forbidden", "A team must be owned by the goal coordinator or an authorized local coordinator");
				}
				const team = decodeTeam({ ...record(input), id: newId("teams", input.id), owner: actor, context: input.context ?? [] });
				put("teams", team);
				return team;
			});
		},
		/** @param {TaskInput} input @param {string} actor @returns {Task} */
		createTask(input, actor) {
			return transaction(() => insertTask(input, actor));
		},
		/** @param {string} id */
		getGoal(id) { return transaction(() => get("goals", id), false); },
		/** @param {string} id */
		getTask(id) { return transaction(() => get("tasks", id), false); },
		/** @param {string} taskId @param {string} actor */
		ownsTask(taskId, actor) { return transaction(() => authorized(get("tasks", taskId), actor), false); },
		/** @param {string} goalId @param {string} actor */
		isNativeMember(goalId, actor) {
			return transaction(() => goalMember(get("goals", goalId), actor), false);
		},
		/** @param {string} id */
		getTeam(id) { return transaction(() => get("teams", id), false); },
		/** @param {string} id */
		getDelivery(id) { return transaction(() => get("deliveries", id), false); },
		/** @param {string} actor @param {string} [goalId] */
		pendingDeliveries(actor, goalId) {
			return transaction(() => list("wakes", `WHERE json_extract(document,'$.inFlight') IS NOT NULL
				${goalId === undefined ? "" : "AND goal_id=?"}`, goalId === undefined ? [] : [goalId])
				.map(wake => get("deliveries", text(wake.inFlight, "in-flight delivery")))
				.filter(delivery => delivery.owner === actor && delivery.state === "issued"), false);
		},
		/** @param {string} actor @param {string} [goalId] */
		openInputRequests(actor, goalId) {
			return transaction(() => list("attempts", "WHERE json_extract(document,'$.waiting.kind')='input'")
				.filter(attempt => {
					const task = get("tasks", attempt.taskId);
					return (goalId === undefined || task.goalId === goalId) && (attempt.nativeId === actor || authorized(task, actor));
				}), false);
		},
		/** Only invoked with explicitly observed native input clearance. @param {string} nativeId @param {string} actor */
		clearNativeInputs(nativeId, actor) {
			return transaction(() => {
				for (const attempt of list("attempts", "WHERE native_id=? AND json_extract(document,'$.waiting.kind')='input'", [nativeId])) {
					requireReporter(attempt, actor);
					delete attempt.waiting;
					put("attempts", attempt);
					const task = get("tasks", attempt.taskId);
					if (task.currentAttemptId === attempt.id && task.version === attempt.taskVersion
						&& task.state === "waiting" && task.waiting?.kind === "input") {
						task.waiting = { kind: "capacity", reason: "The actual native input request was answered" };
						put("tasks", task);
						wakeCapacity(task.goalId);
					}
				}
			});
		},
		/** @param {import("./model.d.ts").Input} input */
		outputForInput(input) { return transaction(() => inputOutput(decodeInput(input)), false); },
		/** @param {string} id */
		getAttempt(id) { return transaction(() => get("attempts", id), false); },
		/** @param {string} id */
		getEffect(id) { return transaction(() => get("effects", id), false); },
		/** @param {string} shellId @param {string} actor */
		commandForShell(shellId, actor) {
			return transaction(() => {
				const effects = list("effects", "WHERE kind='command' AND owner=? AND json_extract(document,'$.request.shellId')=?", [actor, shellId]);
				if (effects.length > 1) throw new FoundryError("effect_identity_conflict", "A command shell cannot identify multiple native operations");
				return effects[0];
			}, false);
		},
		pendingEffects() {
			return transaction(() => list("effects", "WHERE state IN ('prepared','issued','uncertain')"), false);
		},
		/** @param {string} attemptId */
		effectsForAttempt(attemptId) {
			return transaction(() => attemptEffects(attemptId), false);
		},
		/** @param {string} callId */
		effectByNativeCall(callId) {
			return transaction(() => {
				const effects = list("effects", `WHERE state IN ('issued','uncertain') AND (json_extract(document,'$.request.nativeToolCallId')=?
				OR (state IN ('issued','uncertain') AND EXISTS (
					SELECT 1 FROM json_each(document,'$.result.followUpCallIds') WHERE value=?
				)))`, [callId, callId]);
				return effects.length === 1 ? effects[0] : undefined;
			}, false);
		},
		/** @param {string} name */
		attemptByCreationName(name) {
			return transaction(() => {
				let effects = list("effects", "WHERE kind='create' AND json_extract(document,'$.request.name')=?", [name]);
				const suffix = nativeSessionName(name).match(/ [0-9a-f]{8}$/u)?.[0];
				if (!effects.length && suffix) effects = list("effects",
					"WHERE kind='create' AND json_extract(document,'$.request.name') LIKE ?", [`%${suffix}`])
					.filter(effect => typeof record(effect.request).name === "string"
						&& nativeSessionName(text(record(effect.request).name, "native name")) === nativeSessionName(name));
				return effects.length === 1 ? get("attempts", effects[0].attemptId) : undefined;
			}, false);
		},
		/** @param {string} actor */
		executingAttempts(actor) {
			return transaction(() => list("attempts", `WHERE native_id=? AND slot=1 AND state='running'
				AND id IN (SELECT json_extract(document,'$.currentAttemptId') FROM tasks WHERE state='running')`, [actor]), false);
		},
		/** @param {string} token */
		attemptByToken(token) {
			return transaction(() => list("attempts", "WHERE json_extract(document,'$.token')=?", [text(token, "token")])[0], false);
		},
		/** @param {string} [goalId] @param {boolean} [history] @returns {import("./model.d.ts").Snapshot} */
		snapshot(goalId, history = true) {
			return transaction(() => {
				if (goalId !== undefined) get("goals", goalId);
				const parameters = goalId === undefined ? [] : [goalId];
				const goalWhere = goalId === undefined ? "" : "WHERE goal_id=?";
				const attemptWhere = goalId === undefined ? "" : "WHERE task_id IN (SELECT id FROM tasks WHERE goal_id=?)";
				const effectWhere = goalId === undefined ? "" : "WHERE attempt_id IN (SELECT a.id FROM attempts a JOIN tasks t ON t.id=a.task_id WHERE t.goal_id=?)";
				const goals = list("goals", goalId === undefined ? "" : "WHERE id=?", parameters);
				const tasks = list("tasks", goalWhere, parameters);
				const attempts = list("attempts", history ? attemptWhere
					: `WHERE id IN (SELECT json_extract(document,'$.currentAttemptId') FROM tasks ${goalWhere})`, parameters);
				return { goals, tasks, attempts,
					factories: list("factory_controls").filter(factory => goalId === undefined
						|| optional("goal_completions", goalId)?.factoryId === factory.id),
					completions: list("goal_completions", goalWhere, parameters).map(completionStatus),
					teams: list("teams", goalWhere, parameters),
					wakes: list("wakes", goalWhere, parameters),
					effects: history ? list("effects", effectWhere, parameters) : [],
					claims: history ? list("claims", effectWhere, parameters) : [],
					signals: list("signals", goalWhere, parameters),
					lessons: list("lessons", goalWhere, parameters),
				};
			}, false);
		},
		/** @param {string} actor @param {string} [goalId] @param {string} [taskId] */
		contextSnapshot(actor, goalId, taskId) {
			return transaction(() => {
				if (goalId !== undefined && !goalMember(get("goals", goalId), actor)) throw new FoundryError("foreign_goal", "This caller has no assignment in the requested goal");
				if (taskId !== undefined && goalId !== undefined && accessibleTask(taskId, actor, true).goalId !== goalId) {
					throw new FoundryError("foreign_task", "The requested task belongs to another goal");
				}
				if (taskId !== undefined && goalId === undefined) accessibleTask(taskId, actor, true);
				const ownWakes = list("wakes", `WHERE owner=? AND json_extract(document,'$.generation')>json_extract(document,'$.consumed')
					${goalId === undefined ? "" : "AND goal_id=?"}`, goalId === undefined ? [actor] : [actor, goalId]);
				const causes = ownWakes.flatMap(wake => wake.relatedReasons ?? [wake.reason]);
				const affected = JSON.stringify(causes.filter(reason => reason.startsWith("output:")).map(reason => reason.slice(7)));
				const visible = db.prepare(`${MANAGED_TASKS}, pending(id) AS (
					SELECT DISTINCT a.task_id FROM attempts a JOIN tasks t ON t.id=a.task_id
					JOIN effects e ON (a.id=e.attempt_id OR a.id IN (SELECT value FROM json_each(e.document,'$.relatedAttemptIds')))
					WHERE e.kind='command' AND e.state IN ('issued','uncertain')
						AND (a.native_id=? OR a.task_id IN (SELECT id FROM managed))
						AND (?='' OR t.id=? OR t.parent_id=?)
				) SELECT t.id FROM tasks t WHERE (? IS NULL OR t.goal_id=?)
					AND (t.id IN pending OR t.id=? OR t.parent_id=?
						OR json_extract(t.document,'$.repairReservation.worker')=?
						OR (t.id IN (SELECT id FROM managed) AND (t.owner=? OR t.parent_id IN (SELECT id FROM tasks WHERE owner=?)
							OR t.parent_id IS NULL OR t.id IN (SELECT value FROM json_each(?)))))
					AND (t.state NOT IN ('done','cancelled') OR t.id=? OR t.id IN pending
						OR t.id IN (SELECT value FROM json_each(?)))`)
					.all(actor, actor, actor, taskId ?? "", taskId ?? "", taskId ?? "", goalId ?? null, goalId ?? null,
						taskId ?? "", taskId ?? "", actor, actor, actor, affected, taskId ?? "", affected);
				const tasks = list("tasks", "WHERE id IN (SELECT value FROM json_each(?))",
					[JSON.stringify(visible.map(row => text(row.id, "visible task")))]);
				const ids = JSON.stringify(tasks.map(task => task.id));
				const effects = list("effects", `WHERE kind='command' AND state IN ('issued','uncertain')
					AND (attempt_id IN (SELECT id FROM attempts WHERE task_id IN (SELECT value FROM json_each(?)))
						OR EXISTS (SELECT 1 FROM json_each(document,'$.relatedAttemptIds') related JOIN attempts a ON a.id=related.value
							WHERE a.task_id IN (SELECT value FROM json_each(?))))`, [ids, ids]);
				const goalIds = [...new Set([...tasks.map(task => task.goalId), ...ownWakes.map(wake => wake.goalId), ...(goalId ? [goalId] : [])])];
				const goals = list("goals", "WHERE id IN (SELECT value FROM json_each(?))", [JSON.stringify(goalIds)]);
				const attempts = list("attempts", `WHERE task_id IN (SELECT value FROM json_each(?))
					AND (id IN (SELECT json_extract(document,'$.currentAttemptId') FROM tasks WHERE id IN (SELECT value FROM json_each(?)))
						OR id IN (SELECT attempt_id FROM effects WHERE kind='command' AND state IN ('issued','uncertain'))
						OR id IN (SELECT value FROM effects,json_each(document,'$.relatedAttemptIds')
							WHERE kind='command' AND state IN ('issued','uncertain')))`, [ids, ids]);
				const goalJson = JSON.stringify(goalIds);
				const teams = list("teams", "WHERE goal_id IN (SELECT value FROM json_each(?)) AND (owner=? OR id IN (SELECT json_extract(value,'$.teamId') FROM json_each(?)))",
					[goalJson, actor, JSON.stringify(tasks)]);
				const signals = list("signals", `WHERE goal_id IN (SELECT value FROM json_each(?))
					AND (id IN (SELECT value FROM json_each(?)) OR id IN (
						SELECT id FROM signals WHERE goal_id IN (SELECT value FROM json_each(?))
						AND (task_id=? OR json_extract(document,'$.teamId') IN (SELECT value FROM json_each(?))
							OR (task_id IS NULL AND goal_id IN (SELECT id FROM goals WHERE owner=?)))
						ORDER BY rowid DESC LIMIT 20))`,
					[goalJson, JSON.stringify(causes.filter(reason => reason.startsWith("signal:")).map(reason => reason.slice(7))),
						goalJson, taskId ?? "", JSON.stringify(teams.map(team => team.id)), actor]);
				const lessons = list("lessons", `WHERE id IN (SELECT id FROM lessons WHERE goal_id IN (SELECT value FROM json_each(?))
					${taskId === undefined ? "" : "AND json_extract(document,'$.workType')=(SELECT json_extract(document,'$.workType') FROM tasks WHERE id=?)"}
					ORDER BY rowid DESC LIMIT 20)`, taskId === undefined ? [goalJson] : [goalJson, taskId]);
				const wakes = list("wakes", `WHERE goal_id IN (SELECT value FROM json_each(?))
					AND json_extract(document,'$.generation')>json_extract(document,'$.consumed')`, [goalJson]);
				const ready = tasks.filter(task => (task.repairReservation ? task.repairReservation.worker === actor : authorized(task, actor))
					&& (runnable(task) || preparedDispatch(task)));
				return { goals, tasks, attempts, teams, signals, lessons, wakes, effects, ready, claims: [] };
			}, false);
		},
		/** @param {string} actor @param {string} [goalId] @param {boolean} [dispatchOnly] @returns {Task[]} */
		readyTasks(actor, goalId, dispatchOnly = false) {
			return transaction(() => {
				text(actor, "actor");
				if (goalId !== undefined) get("goals", goalId);
				return list("tasks", `WHERE state IN ('ready','waiting','running') ${goalId === undefined ? "" : "AND goal_id=?"}`, goalId === undefined ? [] : [goalId]).filter((task) => (goalId === undefined || task.goalId === goalId)
					&& (task.repairReservation ? task.repairReservation.worker === actor : authorized(task, actor))
					&& (!dispatchOnly || !task.repairReservation && task.state !== "waiting"
						&& (!optional("goal_completions", task.goalId) || task.owner === actor))
					&& (runnable(task) || preparedDispatch(task)));
			}, false);
		},
		/** @param {string} taskId @param {string} actor @returns {Attempt} */
		prepareAttempt(taskId, actor) {
			return transaction(() => prepare(taskId, actor));
		},
		/** @param {string} taskId @param {string} actor @returns {Attempt} */
		startLocalTask(taskId, actor) {
			return transaction(() => startLocal(taskId, actor));
		},
		/** @param {string} attemptId @param {string} actor @param {string} effectId @param {Json} request @returns {Effect} */
		issueAttempt(attemptId, actor, effectId, request) {
			return transaction(() => {
				const attempt = get("attempts", attemptId);
				const task = current(attempt);
				requireOwner(task, actor);
				text(effectId, "effectId");
				const existing = optional("effects", effectId);
				const factory = requireAdmission(task, existing?.factoryGeneration);
				const safeRequest = json(request);
				if (existing) {
					if (existing.attemptId !== attemptId || existing.kind !== "create"
						|| !sameRequest(existing.request, safeRequest, existing.state === "prepared")) {
						throw new FoundryError("effect_identity_conflict", "Effect identity is already used for another request");
					}
					if (existing.state !== "prepared") return existing;
				}
				if (!attempt.slot || attempt.nativeId || attempt.state !== "prepared"
					|| list("effects", "WHERE attempt_id=? AND kind='create' AND state<>'prepared'", [attemptId]).length) {
					throw new FoundryError("already_issued", "Creation may already have happened; reconcile it, never issue another create");
				}
				const other = list("effects", "WHERE attempt_id=? AND kind='create'", [attemptId]).find((effect) => effect.id !== effectId);
				if (other) throw new FoundryError("already_issued", "This attempt already has a creation identity");
				const effect = decodeEffect({ id: effectId, attemptId, kind: "create", state: "issued", owner: actor, request: safeRequest,
					...(factory === undefined ? {} : { factoryGeneration: factory.generation }) });
				attempt.state = "issued";
				put("effects", effect);
				put("attempts", attempt);
				return effect;
			});
		},
		/** @param {string} effectId @param {string} actor @param {Json} receipt */
		rejectCreation(effectId, actor, receipt) {
			return transaction(() => {
				const effect = get("effects", effectId);
				const attempt = get("attempts", effect.attemptId);
				const task = get("tasks", attempt.taskId);
				if (effect.kind !== "create" || effect.owner !== actor || attempt.nativeId !== undefined
					|| !["issued", "uncertain"].includes(effect.state)) throw new FoundryError("refusal_mismatch", "A pre-start refusal must match the actual issued creation and its creator");
				effect.state = "settled";
				effect.result = json({ neverIssued: true, nativeRefusal: receipt });
				put("effects", effect);
				if (attempt.state !== "cancelled") attempt.state = "failed";
				attempt.endedBy = actor;
				if (task.currentAttemptId === attempt.id && task.version === attempt.taskVersion && task.state !== "cancelled") {
					task.state = "blocked";
					put("tasks", task);
					notifyOutcome(task);
				}
				put("attempts", attempt);
				releaseSlot(attempt);
				return effect;
			});
		},
		/** @param {string} attemptId @param {string} nativeId @param {string} actor @param {Json} [receipt] @returns {Attempt} */
		bindAttempt(attemptId, nativeId, actor, receipt) {
			return transaction(() => bind(attemptId, nativeId, actor, receipt));
		},
		/** @param {{id: string, attemptId: string, kind: Effect["kind"], state: Effect["state"], request: Json, result?: Json, factoryGeneration?:number, relatedAttemptIds?:string[]}} input @param {string} actor @returns {Effect} */
		recordEffect(input, actor) {
			return transaction(() => {
				const attempt = get("attempts", input.attemptId);
				requireReporter(attempt, text(actor, "actor"));
				const existing = optional("effects", input.id);
				const effect = decodeEffect({ ...record(input), owner: existing?.owner ?? actor });
				if (["command", "create"].includes(effect.kind) && (!existing || existing.state === "prepared")
					&& effect.state !== "settled") {
					const factory = requireAdmission(get("tasks", attempt.taskId), existing?.factoryGeneration);
					if (factory) effect.factoryGeneration = factory.generation;
				} else if (existing?.factoryGeneration !== undefined) effect.factoryGeneration = existing.factoryGeneration;
				if (existing && digest(json(existing.relatedAttemptIds ?? [])) !== digest(json(effect.relatedAttemptIds ?? []))) {
					throw new FoundryError("effect_identity_conflict", "Shared command attribution is immutable");
				}
				if (effect.relatedAttemptIds?.length) {
					if (effect.kind !== "command" || existing && digest(json(existing.relatedAttemptIds ?? [])) !== digest(json(effect.relatedAttemptIds))) {
						throw new FoundryError("effect_identity_conflict", "Shared command attribution is immutable");
					}
					for (const id of effect.relatedAttemptIds) {
						const related = get("attempts", id);
						if (related.nativeId !== attempt.nativeId || related.nativeId !== actor) {
							throw new FoundryError("foreign_execution", "A shared native command can only belong to this caller's actual attempts");
						}
						if (!existing || existing.state === "prepared" && effect.state === "issued") {
							requireAdmission(current(related));
							if (!related.slot) throw new FoundryError("capacity_required", "Every possible executing unit requires a slot");
						}
					}
				}
				if (existing && (existing.attemptId !== effect.attemptId || existing.kind !== effect.kind
					|| !sameRequest(existing.request, effect.request, existing.state === "prepared" && effect.state === "issued"))) {
					throw new FoundryError("effect_identity_conflict", "An effect identity cannot change its attempt or request");
				}
				if (existing?.state === "settled") {
					if (effect.state !== "settled" || digest(json(existing.result ?? null)) !== digest(json(effect.result ?? null))) {
						throw new FoundryError("effect_already_settled", "Settled effects are immutable");
					}
					return existing;
				}
				if (existing && existing.state !== "prepared" && effect.state === "prepared") {
					throw new FoundryError("invalid_transition", "An issued effect cannot become unissued");
				}
				if (effect.kind === "create" && (!existing || existing.state === "prepared") && effect.state !== "prepared") {
					throw new FoundryError("issuance_required", "Creation issuance must use issueAttempt at the native call boundary");
				}
				if (effect.kind === "create" && !existing && list("effects", "WHERE attempt_id=? AND kind='create'", [attempt.id]).length) {
					throw new FoundryError("already_issued", "Attempt already has a creation identity");
				}
				if ((effect.state === "issued" || effect.state === "uncertain") && (!existing || existing.state === "prepared")
					&& effect.kind !== "stop") {
					const task = current(attempt);
					if (effect.kind !== "command" || attempt.nativeId !== actor) requireOwner(task, actor);
					if ((effect.kind === "command" || effect.kind === "create") && (!attempt.slot || !["prepared", "issued", "running"].includes(attempt.state))) {
						throw new FoundryError("capacity_required", "Substantive execution requires an active worker slot");
					}
				}
				if (effect.kind === "command" && effect.state === "settled" && effect.result !== null
					&& typeof effect.result === "object" && !Array.isArray(effect.result) && effect.result.evidence !== undefined) {
					if (!existing || !["issued", "uncertain"].includes(existing.state)) {
						throw new FoundryError("unissued_evidence", "Check evidence must settle a known issued native operation");
					}
					const observations = Array.isArray(effect.result.evidence) ? effect.result.evidence : [effect.result.evidence];
					for (const value of observations) {
						const evidence = decodeEvidence(value);
						const check = attempt.checks.find((item) => item.id === evidence.checkId && item.version === evidence.checkVersion);
						if (evidence.attemptId !== attempt.id || !check) {
							throw new FoundryError("evidence_mismatch", "Admitted evidence must match this operation's assigned attempt and evaluator");
						}
					}
				}
				put("effects", effect);
				admitEffectEvidence(effect);
				if (effect.kind === "command" && effect.state === "settled") {
					for (const id of [attempt.id, ...effect.relatedAttemptIds ?? []]) parkPausedExecution(get("attempts", id));
				}
				if (effect.kind === "create" && effect.state === "uncertain" && !attempt.nativeId
					&& attempt.state !== "cancelled") {
					attempt.state = "uncertain";
					put("attempts", attempt);
				}
				releaseSlot(attempt);
				for (const id of effect.relatedAttemptIds ?? []) releaseSlot(get("attempts", id));
				return effect;
			});
		},
		/**
		 * reportedSender is a separately supplied, native-verified identity for
		 * parent-local reporting; it is never read from the result payload.
		 * @param {Omit<Result, "createdAt" | "sender">} input @param {string} actor
		 * @param {string} [reportedSender] @returns {{result: Result, promoted: boolean}}
		 */
		recordResult(input, actor, reportedSender) {
			return transaction(() => saveResult(input, actor, reportedSender));
		},
		/** @param {Omit<Result, "createdAt" | "sender">} input @param {string} actor */
		recordResultAndRepair(input, actor) {
			return transaction(() => {
				const previouslyPromoted = db.prepare("SELECT promoted FROM outcomes WHERE result_id=?").get(input.id)?.promoted === 1;
				const recorded = saveResult(input, actor, undefined, input.state === "failed");
				const old = get("attempts", input.attemptId);
				const task = get("tasks", old.taskId);
				if (old.nativeId !== actor) throw new FoundryError("foreign_execution", "A local repair must retain the actual reporting worker");
				const announce = () => {
					releaseOwnedClaims(get("attempts", old.id));
					if (recorded.promoted && recorded.result.state === "failed" && !previouslyPromoted) {
						notifyOutcome(task);
						wakeCapacity(task.goalId);
					}
				};
				if (!recorded.promoted || recorded.result.state !== "failed") {
					announce();
					return { ...recorded, continuation: { state: "not-repaired", code: "unpromoted_failure" } };
				}
				const latest = latestEvidence(recorded.result.evidence);
				if (!old.checks.some(check => latest.get(JSON.stringify([check.id, check.version]))?.outcome === "failed")) {
					announce();
					return { ...recorded, continuation: { state: "not-repaired", code: "checked_failure_required" } };
				}
				const resumeRepair = task.repairReservation?.attemptId === old.id && task.repairReservation.worker === actor
					&& task.currentAttemptId === old.id && task.version === old.taskVersion + 1 && task.state === "ready";
				if (!resumeRepair && (task.currentAttemptId !== old.id || task.version !== old.taskVersion)) {
					const currentAttempt = task.currentAttemptId ? get("attempts", task.currentAttemptId) : undefined;
					return { ...recorded, continuation: currentAttempt?.repairOf === old.id && currentAttempt.nativeId === actor
						? { state: currentAttempt.state, attempt: currentAttempt }
						: { state: "not-repaired", code: "already-recorded-or-superseded" } };
				}
				if (outstanding(old, true)) {
					announce();
					return { ...recorded, continuation: { state: "waiting", code: "command_settlement_required" } };
				}
				if (!budgetAvailable(get("goals", task.goalId))) {
					announce();
					return { ...recorded, continuation: { state: "blocked", code: "limit_exhausted",
						message: "The goal's observed credits or absolute deadline are exhausted" } };
				}
				try { if (!resumeRepair) retry(task.id, old.id, actor, false, true); }
				catch (error) {
					if (!(error instanceof FoundryError) || !["repair_limit", "stagnation"].includes(error.code)) throw error;
					announce();
					return { ...recorded, continuation: { state: "blocked", code: error.code, message: error.message } };
				}
				let next;
				try { next = startLocal(task.id, actor, old.id); }
				catch (error) {
					if (!(error instanceof FoundryError) || error.code !== "limit_exhausted") throw error;
					announce();
					return { ...recorded, continuation: { state: "blocked", code: error.code, message: error.message } };
				}
				if (next instanceof FoundryError) announce();
				return { ...recorded, continuation: next instanceof FoundryError
					? { state: "waiting", code: next.code, message: next.message, taskId: task.id }
					: { state: next.state, attempt: next } };
			});
		},
		/** @param {string} taskId @param {string} expectedAttemptId @param {string} actor @returns {Task} */
		retryTask(taskId, expectedAttemptId, actor) {
			return transaction(() => retry(taskId, expectedAttemptId, actor));
		},
		/** @param {string} taskId @param {string} actor @param {Task["waiting"]} waiting @returns {Task} */
		waitTask(taskId, actor, waiting) {
			return transaction(() => {
				const task = get("tasks", taskId);
				const attempt = task.currentAttemptId ? get("attempts", task.currentAttemptId) : undefined;
				if (attempt?.nativeId !== actor) requireOwner(task, actor);
				uncancelled(task);
				if (!attempt || !["running", "waiting"].includes(task.state)) {
					throw new FoundryError("invalid_transition", "Only an active task can wait");
				}
				const decoded = decodeWaiting(waiting);
				if (!decoded) throw new FoundryError("invalid_field", "Waiting must name its reason");
				task.state = "waiting";
				task.waiting = decoded;
				attempt.state = "waiting";
				attempt.waiting = decoded;
				put("tasks", task);
				put("attempts", attempt);
				releaseSlot(attempt);
				return task;
			});
		},
		/** @param {string} taskId @param {string} actor @returns {Attempt} */
		resumeTask(taskId, actor) {
			return transaction(() => {
				const task = get("tasks", taskId);
				const attempt = task.currentAttemptId ? get("attempts", task.currentAttemptId) : undefined;
				if (attempt?.nativeId !== actor) requireOwner(task, actor);
				uncancelled(task);
				requireAdmission(task);
				if (!attempt || !["running", "waiting"].includes(task.state)) {
					throw new FoundryError("invalid_transition", "Only a current running or waiting attempt can resume");
				}
				current(attempt);
				if (resolvedInputs(task) === undefined) throw new FoundryError("inputs_unavailable", "Required inputs are not available");
				if (!attempt.slot) {
					const denied = allocate(task);
					if (denied) {
						task.waiting = { kind: "capacity", reason: denied.message };
						put("tasks", task);
						return denied;
					}
				}
				attempt.slot = true;
				const creations = list("effects", "WHERE attempt_id=? AND kind='create' AND state<>'prepared'", [attempt.id]);
				attempt.state = attempt.nativeId ? "running"
					: creations.some((effect) => effect.state === "uncertain") ? "uncertain"
						: creations.length ? "issued" : "prepared";
				task.state = "running";
				delete task.waiting;
				delete task.repairReservation;
				delete attempt.waiting;
				put("tasks", task);
				put("attempts", attempt);
				return attempt;
			});
		},
		/** @param {string} taskId @param {string} actor @returns {Task[]} */
		cancelTask(taskId, actor) {
			return transaction(() => {
				const root = get("tasks", taskId);
				requireOwner(root, actor);
				const rows = db.prepare(`WITH RECURSIVE subtree(id) AS (
					SELECT id FROM tasks WHERE id=? UNION SELECT t.id FROM tasks t JOIN subtree s ON t.parent_id=s.id
				) SELECT id FROM subtree`).all(taskId);
				const tasks = rows.map((row) => get("tasks", text(row.id, "task.id")));
				for (const task of tasks) {
					const waiting = task.waiting;
					task.state = "cancelled";
					task.outputs = [];
					delete task.waiting;
					delete task.repairReservation;
					put("tasks", task);
					// Superseded executions can still have known effects or live native workers.
					for (const attempt of list("attempts", "WHERE task_id=?", [task.id])) {
						if (["done", "failed", "cancelled"].includes(attempt.state) && !outstanding(attempt, true)) continue;
						if (attempt.id === task.currentAttemptId && waiting?.kind === "input") attempt.waiting = waiting;
						attempt.state = "cancelled";
						attempt.endedBy = actor;
						put("attempts", attempt);
						retirePrepared(attempt, "cancelled");
						scheduleStop(attempt, actor);
						releaseSlot(attempt);
					}
				}
				return tasks;
			});
		},
		/** @param {{attemptId: string, surface: string, resource: string}} input @param {string} actor @returns {Claim} */
		claim(input, actor) {
			return transaction(() => {
				const attempt = get("attempts", input.attemptId);
				const task = current(attempt);
				requireAdmission(task);
				requireOwner(task, actor);
				const surface = text(input.surface, "surface");
				const resource = resourcePath(input.resource);
				if (!task.scope.paths.some((base) => containsPath(base, resource))) {
					throw new FoundryError("scope_widening", "Claim is outside the task's path scope");
				}
				if (!attempt.slot) throw new FoundryError("capacity_required", "A write claim requires admitted execution");
				if (!["prepared", "issued", "running"].includes(attempt.state)) {
					throw new FoundryError("invalid_transition", "A terminal or waiting attempt cannot acquire new write claims");
				}
				for (const claim of list("claims", "WHERE json_extract(document,'$.surface')=?", [surface])) {
					if (claim.attemptId === attempt.id && claim.resource === resource) return claim;
					if (claim.attemptId !== attempt.id && (containsPath(claim.resource, resource) || containsPath(resource, claim.resource))) {
						throw new FoundryError("claim_conflict", `Surface ${surface} is already claimed at ${claim.resource}`);
					}
				}
				const claim = { id: randomUUID(), attemptId: attempt.id, surface, resource };
				put("claims", claim);
				return claim;
			});
		},
		/** @param {string} claimId @param {string} actor @returns {Claim} */
		releaseClaim(claimId, actor) {
			return transaction(() => {
				const claim = get("claims", claimId);
				const attempt = get("attempts", claim.attemptId);
				requireReporter(attempt, actor);
				if (outstanding(attempt, true)) throw new FoundryError("effects_outstanding", "This attempt's substantive issued effects must settle before releasing its claim");
				db.prepare("DELETE FROM claims WHERE id=?").run(claimId);
				return claim;
			});
		},
		/** @param {string} actor @param {string} [goalId] */
		retryFailedStops(actor, goalId) {
			return transaction(() => {
				for (const failed of list("effects", `WHERE kind='stop' AND state='settled' AND json_extract(document,'$.result.accepted')=0
					AND attempt_id IN (SELECT id FROM attempts WHERE state='cancelled')`)) {
					if (failed.result === undefined || failed.result === null
						|| typeof failed.result !== "object" || Array.isArray(failed.result)) continue;
					const result = record(failed.result);
					if (result.accepted !== false || result.unavailable === true) continue;
					const attempt = get("attempts", failed.attemptId);
					const task = get("tasks", attempt.taskId);
					if ((goalId !== undefined && task.goalId !== goalId) || !authorized(task, actor) || attempt.state !== "cancelled") continue;
					const stops = list("effects", "WHERE attempt_id=? AND kind='stop'", [attempt.id]);
					if (stops.some(stop => stop.result !== undefined && stop.result !== null
						&& typeof stop.result === "object" && !Array.isArray(stop.result) && stop.result.unavailable === true)) continue;
					if (stops.some(stop => stop.state !== "settled" || (stop.result !== undefined && stop.result !== null
						&& typeof stop.result === "object" && !Array.isArray(stop.result) && stop.result.accepted === true))) continue;
					put("effects", decodeEffect({ ...failed, id: `${failed.id}:retry:${stops.length}`,
						state: "prepared", owner: actor, result: undefined }));
				}
			});
		},
		/** @param {string} owner @returns {Wake[]} */
		pendingWakes(owner) {
			return transaction(() => list("wakes", "WHERE owner=? AND json_extract(document,'$.generation')>json_extract(document,'$.consumed')", [text(owner, "owner")]), false);
		},
		/** @param {string} actor @param {boolean} [capacity] @param {boolean} [includeInFlight] */
		outgoingWakes(actor, capacity = false, includeInFlight = false) {
			return transaction(() => list("wakes", `WHERE owner<>? ${includeInFlight ? "" : "AND json_extract(document,'$.inFlight') IS NULL"}
				AND json_extract(document,'$.unavailable') IS NULL
				AND json_extract(document,'$.generation')>MAX(COALESCE(json_extract(document,'$.sent'),0),json_extract(document,'$.consumed'))
				AND (goal_id IN (SELECT id FROM goals WHERE owner=? UNION SELECT goal_id FROM tasks WHERE owner=?
					UNION SELECT goal_id FROM teams WHERE owner=?
					UNION SELECT t.goal_id FROM attempts a JOIN tasks t ON a.task_id=t.id WHERE a.native_id=?)
					OR (? AND EXISTS(SELECT 1 FROM json_each(document,'$.relatedReasons') WHERE value='capacity')))`,
				[actor, actor, actor, actor, actor, capacity ? 1 : 0]), false);
		},
		/** @param {string} wakeId */
		wakeHasCurrentRecipient(wakeId) {
			return transaction(() => {
				const notification = get("wakes", wakeId);
				return (notification.relatedReasons ?? [notification.reason])
					.some(reason => wakeTargets({ ...notification, reason }).includes(notification.owner));
			}, false);
		},
		/** @param {string} wakeId @param {number} generation @param {string|undefined} attemptId @param {Json} request @param {string} actor @returns {Delivery|undefined} */
		claimWakeDelivery(wakeId, generation, attemptId, request, actor) {
			return transaction(() => {
				const wake = get("wakes", wakeId);
				const completion = optional("goal_completions", wake.goalId);
				if (completion) {
					const factory = get("factory_controls", completion.factoryId);
					if (factory.state !== "active" || factory.pausedWorkers.includes(wake.owner)) return;
				}
				if (attemptId === undefined) {
					if (!goalMember(get("goals", wake.goalId), actor)) throw new FoundryError("foreign_wake", "Bookkeeping cannot deliver another goal's messages");
				} else {
					const attempt = get("attempts", attemptId);
					requireReporter(attempt, actor);
					const task = current(attempt);
					if (attempt.nativeId !== actor) requireOwner(task, actor);
					if (!goalMember(get("goals", wake.goalId), actor)
						&& !(wake.relatedReasons ?? [wake.reason]).some(reason => reason === `output:${task.id}` || reason === "capacity")) {
						throw new FoundryError("foreign_wake", "This reporter cannot deliver unrelated goals' messages");
					}
				}
				natural(generation, "generation");
				if (generation > wake.generation) throw new FoundryError("wake_generation", "Cannot send an unseen generation");
				if (wake.inFlight || generation <= Math.max(wake.consumed, wake.sent ?? 0)
					|| (wake.sent ?? 0) > wake.consumed) return;
				const delivery = decodeDelivery({ id: `wake:${wake.id}:${randomUUID()}`, wakeId, goalId: wake.goalId,
					generation, owner: actor, state: "issued", request,
					...(attemptId === undefined ? {} : { attemptId }) });
				wake.inFlight = delivery.id;
				put("deliveries", delivery);
				put("wakes", wake);
				return delivery;
			});
		},
		/** Native queue acceptance settles only the claimed generation, never a concurrent update.
		 * @param {string} wakeId @param {string} effectId @param {number} generation @param {Json} result @param {boolean} accepted @param {string} actor @param {boolean} [unavailable] @returns {Wake}
		 */
		settleWakeDelivery(wakeId, effectId, generation, result, accepted, actor, unavailable = false) {
			return transaction(() => {
				const wake = get("wakes", wakeId);
				const delivery = get("deliveries", effectId);
				const consumed = delivery.result === undefined ? undefined : record(delivery.result);
				if (delivery.state === "settled" && consumed?.consumedBy === wake.owner
					&& delivery.wakeId === wakeId && delivery.generation === generation && delivery.owner === actor) {
					if (accepted) wake.sent = Math.max(wake.sent ?? 0, generation);
					put("wakes", wake);
					return wake;
				}
				if (wake.inFlight !== effectId || delivery.wakeId !== wakeId || delivery.generation !== generation
					|| delivery.state !== "issued" || delivery.owner !== actor) {
					throw new FoundryError("wake_delivery_conflict", "This is not the outstanding native wake delivery");
				}
				natural(generation, "generation");
				if (generation > wake.generation) throw new FoundryError("wake_generation", "Cannot settle an unseen generation");
				finishDelivery(delivery, result);
				delete wake.inFlight;
				if (accepted) { wake.sent = Math.max(wake.sent ?? 0, generation); delete wake.unavailable; }
				else if (unavailable) {
					const fallback = fallbackOwner(wake);
					const envelope = record(result);
					wake.unavailable = { effectId, generation, fallback,
						message: typeof envelope.textResultForLlm === "string" && envelope.textResultForLlm
							? envelope.textResultForLlm : "The native recipient is unavailable" };
					if (fallback !== wake.owner) wakeOwnerFallback(fallback, wake);
				}
				put("wakes", wake);
				return wake;
			});
		},
		/** @param {string} wakeId @param {number} generation @param {string} actor @returns {Wake} */
		consumeWake(wakeId, generation, actor) {
			return transaction(() => {
				const wake = get("wakes", wakeId);
				if (wake.owner !== text(actor, "actor")) throw new FoundryError("forbidden", "Only the addressed owner may consume this wake");
				natural(generation, "generation");
				if (generation > wake.generation) throw new FoundryError("wake_generation", "Cannot consume an unseen wake generation");
				wake.consumed = Math.max(wake.consumed, generation);
				if (wake.inFlight) {
					const delivery = get("deliveries", wake.inFlight);
					if (delivery.generation <= wake.consumed && delivery.state === "issued") {
						finishDelivery(delivery, json({ consumedBy: actor, generation: wake.consumed }));
						delete wake.inFlight;
					}
				}
				put("wakes", wake);
				return wake;
			});
		},
		/** @param {string} wakeId @param {number} generation @param {string} actor @returns {Wake} */
		markWakeSent(wakeId, generation, actor) {
			return transaction(() => {
				const wake = get("wakes", wakeId);
				text(actor, "actor");
				const producers = (wake.relatedReasons ?? [wake.reason]).filter(reason => reason.startsWith("output:"))
					.map(reason => optional("tasks", reason.slice("output:".length)));
				if (wake.owner !== actor && !goalMember(get("goals", wake.goalId), actor)
					&& !producers.some(producer => producer && goalMember(get("goals", producer.goalId), actor))) {
					throw new FoundryError("forbidden", "Only a legitimate goal member or the affected output's publisher may acknowledge native delivery");
				}
				natural(generation, "generation");
				if (generation > wake.generation) throw new FoundryError("wake_generation", "Cannot acknowledge an unseen generation");
				wake.sent = Math.max(wake.sent ?? 0, generation);
				if (wake.inFlight) {
					const delivery = get("deliveries", wake.inFlight);
					if (delivery.generation === generation && delivery.state === "issued") {
						finishDelivery(delivery, json({ nativeQueueAcknowledgedBy: actor, generation }));
						delete wake.inFlight;
					}
				}
				put("wakes", wake);
				return wake;
			});
		},
		/** @param {string} taskId @param {string} newOwner @param {string} actor @returns {Task} */
		reassignTask(taskId, newOwner, actor) {
			return transaction(() => {
				const task = transfer(get("tasks", taskId), newOwner, actor);
				rerouteWakes(task.goalId);
				return task;
			});
		},
		/** @param {string} teamId @param {string} newOwner @param {string} actor */
		reassignTeam(teamId, newOwner, actor) {
			return transaction(() => {
				const team = get("teams", teamId);
				if (team.owner !== actor) requireGoalOwner(get("goals", team.goalId), actor);
				const previousOwner = team.owner;
				team.owner = text(newOwner, "new team coordinator");
				for (const task of list("tasks", "WHERE goal_id=? AND owner=? AND json_extract(document,'$.teamId')=?", [team.goalId, previousOwner, team.id])) {
					if (task.state !== "cancelled") transfer(task, newOwner, actor, true);
				}
				put("teams", team);
				rerouteWakes(team.goalId);
				wake(team.owner, team.goalId, `team:${team.id}`);
				return team;
			});
		},
		/** @param {{taskId:string,expectedVersion:number,checks?:import("./model.d.ts").Check[],inputs?:import("./model.d.ts").Input[]}} input @param {string} actor */
		evolveTask(input, actor) {
			return transaction(() => {
				const task = get("tasks", input.taskId);
				requireOwner(task, actor);
				uncancelled(task);
				if (task.version !== natural(input.expectedVersion, "expected task version")) throw new FoundryError("stale_task", "Only this task's current definition may evolve");
				const checks = input.checks === undefined ? task.checks : input.checks.map(decodeCheck);
				if (new Set(checks.map(check => check.id)).size !== checks.length) throw new FoundryError("duplicate_check", "Check identities must be unique");
				checkArtifactScope(checks, task.scope);
				for (const check of task.checks.filter(check => check.origin !== "derived")) {
					const replacement = checks.find(item => item.id === check.id);
					if (!replacement || digest(json(replacement)) !== digest(json(check))) {
						throw new FoundryError("protected_check", "User, contract and standing obligations cannot be relaxed or relabeled through derived evolution");
					}
				}
				if (checks.some(check => ["user", "contract"].includes(check.origin) && !task.checks.some(previous => previous.id === check.id))) {
					throw new FoundryError("protected_check", "Internal evolution cannot invent a new user or accepted-contract obligation");
				}
				const inputs = input.inputs === undefined ? task.inputs : input.inputs.map(decodeInput);
				const completion = optional("goal_completions", task.goalId);
				if (completion) {
					requireAdmission(task);
					if (completion.closed) throw new FoundryError("job_closed", "Explicitly reopen the job before changing a required definition");
					if (task.id === completion.taskId && completion.requiredInputs.some(required =>
						!inputs.some(input => digest(json(input)) === digest(json(required))))) {
						throw new FoundryError("protected_input", "Accepted completion requirements cannot be removed through derived evolution");
					}
					for (const input of inputs) if (get("tasks", input.taskId).goalId === task.goalId && input.version !== undefined) {
						throw new FoundryError("pinned_required_producer", "Factory required production must float");
					}
				}
				if (digest(json({ checks, inputs })) === digest(json({ checks: task.checks, inputs: task.inputs }))) return { task, affected: [] };
				for (const input of inputs) {
					get("tasks", input.taskId);
					const cycle = db.prepare(`WITH RECURSIVE upstream(id) AS (
						SELECT ? UNION SELECT producer_id FROM dependencies JOIN upstream ON task_id=upstream.id
					) SELECT id FROM upstream WHERE id=? LIMIT 1`).get(input.taskId, task.id);
					if (cycle) throw new FoundryError("dependency_cycle", "Artifact dependencies must remain acyclic");
				}
				const affected = [task];
				const seen = new Set([task.id]);
				for (const producer of affected) {
					if (!producer.outputs.length) continue;
					for (const row of db.prepare("SELECT DISTINCT task_id FROM dependencies WHERE producer_id=? AND version IS NULL").all(producer.id)) {
						const consumer = get("tasks", text(row.task_id, "consumer"));
						if (!seen.has(consumer.id) && consumer.state !== "cancelled") { seen.add(consumer.id); affected.push(consumer); }
					}
				}
				task.checks = checks;
				task.inputs = inputs;
				db.prepare("DELETE FROM dependencies WHERE task_id=?").run(task.id);
				for (const input of inputs) db.prepare("INSERT INTO dependencies(task_id,producer_id,output,version) VALUES(?,?,?,?)")
					.run(task.id, input.taskId, input.output, input.version ?? null);
				for (const item of affected) revise(item, actor);
				return { task: get("tasks", task.id), affected: affected.map(item => item.id) };
			});
		},
		/** @param {string} id @param {string} observedAt @returns {import("./model.d.ts").UsageAffinity|undefined} */
		usageAffinity(id, observedAt) {
			const observed = Date.parse(text(observedAt, "native event timestamp"));
			if (!Number.isFinite(observed)) throw new FoundryError("invalid_field", "Native usage must retain its actual timestamp");
			return transaction(() => list("usage_affinity", `WHERE id=(SELECT id FROM usage_affinity
				WHERE json_extract(document,'$.groupId')=? AND json_extract(document,'$.startedAt')<=?
				ORDER BY json_extract(document,'$.startedAt') DESC,rowid DESC LIMIT 1)`,
				[text(id, "affinity group"), new Date(observed).toISOString()])[0], false);
		},
		/** @param {string} id @param {string} actor @param {string} [token] @param {{id: string,timestamp: string}} [request] */
		captureUsageAffinity(id, actor, token, request) {
			return transaction(() => {
				const attempts = list("attempts", "WHERE native_id=? AND state IN ('prepared','issued','running','waiting','uncertain')", [text(actor, "native session")])
					.filter(attempt => {
						const task = get("tasks", attempt.taskId);
						return task.currentAttemptId === attempt.id && task.version === attempt.taskVersion;
					});
				const assignment = token ? list("attempts", "WHERE json_extract(document,'$.token')=?", [token])[0] : undefined;
				const activeToken = token && (!assignment || (!assignment.nativeId || assignment.nativeId === actor)
					&& !["done", "failed", "cancelled"].includes(assignment.state)
					&& get("tasks", assignment.taskId).currentAttemptId === assignment.id) ? token : undefined;
				if (!attempts.length && !activeToken) {
					const previous = list("usage_affinity", `WHERE id=(SELECT id FROM usage_affinity
						WHERE json_extract(document,'$.groupId')=? ORDER BY json_extract(document,'$.startedAt') DESC,rowid DESC LIMIT 1)`, [id])[0];
					if (previous && !previous.attemptIds.length && !previous.token) return previous;
				}
				const affinity = decodeUsageAffinity({ id: `${id}:${request ? text(request.id, "native turn event") : randomUUID()}`,
					groupId: id, startedAt: request?.timestamp ?? timestamp(),
					nativeId: actor, attemptIds: attempts.map(attempt => attempt.id), token: activeToken });
				const existing = optional("usage_affinity", affinity.id);
				if (existing) {
					if (existing.nativeId !== actor || existing.groupId !== affinity.groupId || existing.startedAt !== affinity.startedAt) {
						throw new FoundryError("usage_identity_conflict", "A captured native request cannot change its execution identity");
					}
					return existing;
				}
				put("usage_affinity", affinity);
				return affinity;
			});
		},
		/** @param {import("./model.d.ts").NativeUsage} input @param {string} actor @param {boolean} [idle] */
		recordNativeUsage(input, actor, idle = false) {
			return transaction(() => {
				const incoming = decodeNativeUsage(input);
				if (incoming.nativeId !== actor) throw new FoundryError("foreign_usage", "Only the actual native session can observe its usage");
				delete incoming.goalId;
				delete incoming.attemptId;
				delete incoming.debitedCredits;
				const existing = usageReceipts([incoming.id, ...incoming.aliases]);
				if (!existing && idle) return;
				if (!existing) return settleUsage(incoming);
				if (existing.nativeId !== incoming.nativeId || existing.sourceSessionId !== incoming.sourceSessionId
					|| existing.sequence !== undefined && incoming.sequence !== undefined && existing.sequence !== incoming.sequence
					|| existing.credits !== undefined && incoming.credits !== undefined && existing.credits !== incoming.credits) {
					throw new FoundryError("usage_identity_conflict", "An actual native receipt cannot change its source, sequence or amount");
				}
				const observation = decodeNativeUsage({ ...existing,
					sequence: existing.sequence ?? incoming.sequence,
					aliases: [...new Set([...existing.aliases, ...incoming.aliases])],
					credits: existing.credits ?? incoming.credits,
					billing: existing.billing === "complete" ? "complete" : incoming.billing === "unavailable" ? existing.billing : incoming.billing });
				return settleUsage(observation);
			});
		},
		/** @param {string} actor @param {string[]} goalIds */
		accounting(actor, goalIds) {
			return transaction(() => {
				const ids = goalIds.filter(id => goalMember(get("goals", id), actor));
				const totals = db.prepare(`SELECT count(*) AS receipts,
					COALESCE(sum(json_extract(document,'$.billing')<>'complete'),0) AS missing,
					COALESCE(sum(goal_id IS NULL),0) AS unallocated,
					COALESCE(sum(goal_id IS NULL AND json_extract(document,'$.credits') IS NOT NULL),0) AS unallocated_known,
					COALESCE(sum(CASE WHEN goal_id IS NULL THEN json_extract(document,'$.credits') ELSE 0 END),0) AS unallocated_credits
					FROM native_usage WHERE goal_id IN (SELECT value FROM json_each(?))
						OR (goal_id IS NULL AND EXISTS (SELECT 1 FROM json_each(native_usage.document,'$.attemptIds') ids
							JOIN attempts a ON a.id=ids.value JOIN tasks t ON t.id=a.task_id
							WHERE t.goal_id IN (SELECT value FROM json_each(?))))
						OR (goal_id IS NULL AND EXISTS (SELECT 1 FROM attempts a JOIN tasks t ON t.id=a.task_id
							WHERE json_extract(a.document,'$.token')=json_extract(native_usage.document,'$.token')
								AND (a.native_id IS NULL OR a.native_id=native_usage.native_id)
								AND t.goal_id IN (SELECT value FROM json_each(?))))`)
					.get(JSON.stringify(ids), JSON.stringify(ids), JSON.stringify(ids));
				if (!totals) throw new FoundryError("accounting_invariant", "Native accounting totals are unavailable");
				return { unit: "observed native AI credits", complete: false, captureComplete: false,
					capturedReceipts: natural(totals.receipts, "native receipts"), missingBilling: natural(totals.missing, "missing billing"),
					unallocatedReceipts: natural(totals.unallocated, "unallocated receipts"),
					unallocatedCredits: natural(totals.unallocated_known, "known unallocated charges") > 0
						? number(totals.unallocated_credits, "unallocated credits") : null,
					byGoal: ids.map(goalId => {
						const receipts = db.prepare(`SELECT count(json_extract(document,'$.credits')) AS known,
							COALESCE(sum(json_extract(document,'$.billing')<>'complete'),0) AS missing
							FROM native_usage WHERE goal_id=?`).get(goalId);
						if (!receipts) throw new FoundryError("accounting_invariant", "Goal accounting totals are unavailable");
						const manual = db.prepare("SELECT count(*) AS n FROM usage WHERE attempt_id IN (SELECT id FROM attempts WHERE task_id IN (SELECT id FROM tasks WHERE goal_id=?))").get(goalId)?.n;
						const known = natural(receipts.known, "known native charges") > 0 || natural(manual, "manual observations") > 0;
						return { goalId, reportedCredits: known ? get("goals", goalId).credits : null,
							billing: !known ? "unavailable" : natural(receipts.missing, "missing goal billing") === 0 ? "complete" : "partial" };
					}),
					note: "Totals cover the requested goals and their correlated ambiguous receipts, not unrelated session spend. Unobserved restart/history gaps and uncorrelated charges stay incomplete; recorded workers and post-paid credits are not hard model/spend limits." };
			}, false);
		},
		/** @param {string} attemptId @param {number} credits @param {string} eventId @param {string} actor @returns {Goal} */
		recordUsage(attemptId, credits, eventId, actor) {
			return transaction(() => {
				const attempt = get("attempts", attemptId);
				requireReporter(attempt, text(actor, "actor"));
				const amount = number(credits, "credits");
				if (amount < 0) throw new FoundryError("invalid_field", "Observed spending cannot be negative or refunded");
				text(eventId, "eventId");
				const goal = get("goals", get("tasks", attempt.taskId).goalId);
				const native = usageReceipts([eventId]);
				if (native?.credits !== undefined) {
					if (native.credits !== amount || !native.attemptIds.includes(attemptId)) {
						throw new FoundryError("usage_identity_conflict", "The manual observation conflicts with this actual native charge");
					}
					if (native.debitedCredits !== undefined) return goal;
					const recorded = settleUsage(native);
					if (recorded.debitedCredits !== undefined) return get("goals", goal.id);
				}
				const existing = db.prepare("SELECT attempt_id,credits FROM usage WHERE event_id=?").get(eventId);
				if (existing) {
					if (existing.attempt_id !== attemptId || existing.credits !== amount) {
						throw new FoundryError("usage_identity_conflict", "Usage event identity cannot change its attempt or observed amount");
					}
					return goal;
				}
				db.prepare("INSERT INTO usage(event_id,attempt_id,credits) VALUES(?,?,?)").run(eventId, attemptId, amount);
				goal.credits = number(goal.credits + amount, "total credits");
				put("goals", goal);
				return goal;
			});
		},
		/** @param {Omit<Signal,"id"> & {id?: string}} input @param {string} actor @returns {Signal} */
		recordSignal(input, actor) {
			return transaction(() => {
				const goal = get("goals", input.goalId);
				if (!goalMember(goal, actor)) throw new FoundryError("forbidden", "Only actual goal members may record its non-governing signals");
				if (input.taskId) {
					const task = get("tasks", input.taskId);
					if (task.goalId !== goal.id) throw new FoundryError("invalid_task", "Signal task must belong to its goal");
				}
				if (input.teamId && get("teams", input.teamId).goalId !== goal.id) throw new FoundryError("invalid_team", "Feedback team must belong to the goal");
				const candidate = decodeSignal({ ...record(input), id: input.id ?? randomUUID() });
				const existing = input.id === undefined ? list("signals", "WHERE goal_id=?", [goal.id]).find((signal) => {
					const { id: _left, ...left } = signal;
					const { id: _right, ...right } = candidate;
					return digest(json(left)) === digest(json(right));
				}) : optional("signals", candidate.id);
				if (existing) {
					if (input.id !== undefined && digest(json(existing)) !== digest(json(candidate))) throw new FoundryError("signal_identity_conflict", "Signal identities are immutable");
					return existing;
				}
				put("signals", candidate);
				wake(signalOwner(candidate), goal.id, `signal:${candidate.id}`);
				return candidate;
			});
		},
		/** @param {Omit<Lesson,"id"> & {id?: string}} input @param {string} actor @returns {Lesson} */
		recordLesson(input, actor) {
			return transaction(() => {
				const goal = get("goals", input.goalId);
				if (goal.owner !== actor && !list("tasks", "WHERE goal_id=? AND owner=?", [goal.id, actor])
					.some((task) => task.scope.workTypes.includes("*") || task.scope.workTypes.includes(input.workType))) requireGoalOwner(goal, actor);
				const candidate = decodeLesson({ ...record(input), id: input.id ?? randomUUID() });
				const existing = input.id === undefined ? list("lessons", "WHERE goal_id=? AND json_extract(document,'$.workType')=?", [goal.id, candidate.workType]).find((lesson) => {
					const { id: _left, ...left } = lesson;
					const { id: _right, ...right } = candidate;
					return digest(json(left)) === digest(json(right));
				}) : optional("lessons", candidate.id);
				if (existing) {
					if (input.id !== undefined && digest(json(existing)) !== digest(json(candidate))) throw new FoundryError("lesson_identity_conflict", "Lesson identities are immutable");
					return existing;
				}
				put("lessons", candidate);
				return candidate;
			});
		},
		/** @param {string} attemptId @returns {Result[]} */
		resultsForAttempt(attemptId) {
			return transaction(() => { get("attempts", attemptId); return list("results", "WHERE attempt_id=?", [attemptId]); }, false);
		},
		/** @param {string} attemptId @param {string} [effectId] @returns {import("./model.d.ts").Evidence[]} */
		evidenceForAttempt(attemptId, effectId) {
			return transaction(() => { get("attempts", attemptId); return admittedEvidence(attemptId, effectId); }, false);
		},
		/** @param {string} goalId @param {string} workType @returns {Lesson[]} */
		lessonsFor(goalId, workType) {
			return transaction(() => {
				get("goals", goalId);
				return list("lessons", "WHERE goal_id=? AND json_extract(document,'$.workType')=?", [goalId, text(workType, "workType")]);
			}, false);
		},
	};
}
