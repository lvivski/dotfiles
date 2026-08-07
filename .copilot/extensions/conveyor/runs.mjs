/**
 * @module runs
 *
 * Read-only inspection of persisted workflow runs: listing recent runs, retrieving paginated final
 * results, replaying partial progress when final artifacts are missing, and rendering the
 * `/conveyor` slash-command output.
 */
import { existsSync, lstatSync, statSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { formatDashboard } from "./progress.mjs";
import { hashValue } from "./persistence.mjs";
import { processIsAlive, readWorkOwner, reconcileWorkRecord, workHeartbeatAt } from "./work.mjs";
import { Ledger } from "./ledger.mjs";
import { assertJson, isTerminalStatus } from "./schema.mjs";
import { verifyHostSnapshot } from "./snapshot.mjs";

const RUN_LIST_LIMIT = 50;
const STATUS_WIDTH = 11;
const INSPECT_LIST_LIMIT = 50;
const INSPECT_LABEL_CHARS = 500;
const INSPECT_TEXT_CHARS = 2000;
const CTRL = /[\u0000-\u001f\u007f-\u009f]/g;
const HOME = homedir();

export const MAX_RESULT_CHUNK_CHARS = 32_000;
export const CONVEYOR_IMPORT_CONTRACT_VERSION = 1;

export class ConveyorResultError extends Error {}

/** @returns {string} */
export const conveyorsDir = () => process.env.CONVEYOR_DIR || join(HOME, ".copilot/conveyors");
/** @returns {string} */
export const runsDir = () => process.env.CONVEYOR_RUNS_DIR || join(conveyorsDir(), "runs");

/** @param {unknown} value @returns {value is string} */
export function isValidRunId(value) {
	return typeof value === "string" && value.length > 0 && value.length <= 255 && value !== "." && value !== ".." && !/[\\/\u0000-\u001f\u007f]/.test(value);
}

/** `list_conveyor_runs` implementation — read persisted run artifacts, newest first. */
export function listConveyorRuns() {
	const dir = runsDir();
	if (!existsSync(dir)) return `No conveyor runs in ${dir}.`;
	const entries = listRunDirs(dir);
	const rows = [];
	for (const { name, d, mtime } of entries.slice(0, RUN_LIST_LIMIT)) {
		const manifest = readJson(join(d, "manifest.json")) || {};
		const rec = runRecordOf(d) || {};
		rows.push({
			runId: name,
			status: rec.status || "?",
			conveyor: conveyorName(manifest, rec),
			aic: Number(rec.aic || 0),
			updated: rec.finishedAt || rec.updatedAt || manifest.createdAt || new Date(mtime).toISOString(),
		});
	}
	if (!rows.length) return `No conveyor runs in ${dir}.`;
	rows.sort((a, b) => timestampMs(b.updated) - timestampMs(a.updated));
	const header = `${"RUN ID".padEnd(30)} ${"STATUS".padEnd(STATUS_WIDTH)} ${"CONVEYOR".padEnd(16)} ${"AIC".padStart(7)}  UPDATED`;
	const body = rows
		.map((r) => `${r.runId.slice(0, 30).padEnd(30)} ${String(r.status).padEnd(STATUS_WIDTH)} ${String(r.conveyor).slice(0, 16).padEnd(16)} ${r.aic.toFixed(1).padStart(7)}  ${r.updated}`)
		.join("\n");
	const footer = entries.length > RUN_LIST_LIMIT ? `\n(showing newest ${RUN_LIST_LIMIT} of ${entries.length} runs)` : "";
	return `${header}\n${body}${footer}`;
}

/** @param {unknown} value @returns {number} */
function timestampMs(value) {
	const parsed = Date.parse(String(value || ""));
	return Number.isNaN(parsed) ? 0 : parsed;
}

/** @param {string} dir @returns {{ name: string, d: string, mtime: number }[]} newest dirs first. */
function listRunDirs(dir) {
	const rows = [];
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		if (!ent.isDirectory()) continue;
		const d = join(dir, ent.name);
		try {
			rows.push({ name: ent.name, d, mtime: runMtime(d) });
		} catch {
			// vanished while listing
		}
	}
	rows.sort((a, b) => b.mtime - a.mtime);
	return rows;
}

/** @param {string} d @returns {number} latest artifact mtime for a run dir. */
function runMtime(d) {
	let mtime = statSync(d).mtimeMs;
	for (const file of ["run.json", "state.json", "manifest.json"]) {
		try {
			mtime = Math.max(mtime, statSync(join(d, file)).mtimeMs);
		} catch {
			// artifact may not exist yet
		}
	}
	return mtime;
}

/** @param {string} path @returns {any} parsed JSON or null. */
function readJson(path) {
	try {
		if (!lstatSync(path).isFile()) return null;
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/** @param {any} meta @param {any} rec @returns {string} */
function conveyorName(meta, rec) {
	const explicit = meta.conveyor?.name || meta.name || rec.conveyor?.name || rec.name || rec.title;
	return explicit ? String(explicit) : "";
}

/** @param {string} runId @returns {string|null} the run dir if it exists. */
function findRunDir(runId) {
	if (!isValidRunId(runId)) return null;
	const d = join(runsDir(), runId);
	try {
		return existsSync(d) && lstatSync(d).isDirectory() ? d : null;
	} catch {
		return null;
	}
}

/** @param {unknown} value @returns {number|null} */
function finiteNumber(value) {
	const n = Number(value);
	return value == null || !Number.isFinite(n) ? null : n;
}

/** @param {unknown} value @returns {string|null} */
function resultError(value) {
	if (value == null) return null;
	const text = String(value);
	return text.length > 2000 ? `${text.slice(0, 1997)}...` : text;
}

/** @param {unknown} value @param {number} [max] @returns {string|null} */
function inspectString(value, max = INSPECT_TEXT_CHARS) {
	if (value == null) return null;
	const text = String(value).replace(CTRL, " ");
	return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

/** @param {unknown} value @returns {number|null} */
function inspectInteger(value) {
	const n = Number(value);
	return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** @param {unknown} value @returns {Record<string, number|null>} */
function inspectCounts(value) {
	const counts = value && typeof value === "object" && !Array.isArray(value) ? /** @type {any} */ (value) : {};
	return Object.fromEntries(
		["agents", "launched", "done", "failed", "cached", "skipped", "dropped", "unknownUsage"].map((key) => [key, inspectInteger(counts[key])]),
	);
}

/** @param {unknown} value @returns {{ total: number|null, spent: number|null, remaining: number|null, hit: boolean }|null} */
function inspectBudget(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const budget = /** @type {any} */ (value);
	return {
		total: finiteNumber(budget.total),
		spent: finiteNumber(budget.spent),
		remaining: finiteNumber(budget.remaining),
		hit: budget.hit === true,
	};
}

/** @param {unknown} value @returns {any[]} */
function inspectRunning(value) {
	if (!Array.isArray(value)) return [];
	return value.slice(0, INSPECT_LIST_LIMIT).map((item) => ({
		seq: inspectInteger(item?.seq),
		label: inspectString(item?.label, INSPECT_LABEL_CHARS),
		model: inspectString(item?.model, INSPECT_LABEL_CHARS),
		phase: inspectString(item?.phase, INSPECT_LABEL_CHARS),
		branchPath: inspectString(item?.branchPath, 256) || "/",
	}));
}

/** @param {unknown} value @returns {any[]} */
function inspectGroups(value) {
	if (!Array.isArray(value)) return [];
	return value.slice(0, INSPECT_LIST_LIMIT).map((item) => ({
		gid: inspectInteger(item?.gid),
		kind: inspectString(item?.kind, INSPECT_LABEL_CHARS),
		phase: inspectString(item?.phase, INSPECT_LABEL_CHARS),
		n: inspectInteger(item?.n),
	}));
}

/** @param {unknown} value @returns {any[]} */
function inspectRecent(value) {
	if (!Array.isArray(value)) return [];
	return value.slice(0, INSPECT_LIST_LIMIT).map((item) => ({
		label: inspectString(item?.label, INSPECT_LABEL_CHARS),
		status: inspectString(item?.status, 64),
		aic: finiteNumber(item?.aic),
		error: inspectString(item?.error),
	}));
}

/** @param {unknown} value @returns {any[]} */
function inspectErrors(value) {
	if (!Array.isArray(value)) return [];
	return value.slice(0, INSPECT_LIST_LIMIT).map((item) => ({
		label: inspectString(item?.label, INSPECT_LABEL_CHARS),
		error: inspectString(item?.error),
	}));
}

/** @param {unknown} value @returns {string[]} */
function inspectPaths(value) {
	if (!Array.isArray(value)) return [];
	return value
		.slice(0, INSPECT_LIST_LIMIT)
		.map((item) => inspectString(item))
		.filter((item) => item !== null);
}

/** @param {unknown} branch @returns {string|null} */
function branchPath(branch) {
	return Array.isArray(branch) && branch.every((part) => Number.isSafeInteger(part) && part >= 0) ? (branch.length ? `/${branch.join("/")}` : "/") : null;
}

/** @param {any[]} records */
function inspectInvalidations(records) {
	return records
		.filter((record) => record?.type === "branches_invalidated")
		.slice(-INSPECT_LIST_LIMIT)
		.map((record) => ({
			generation: inspectInteger(record.generation),
			branches: Array.isArray(record.branches) ? record.branches.map(branchPath).filter(Boolean) : [],
			invalidatedAt: inspectString(record.invalidatedAt, 128),
		}));
}

/** Prompt-safe, bounded progress representation. @param {any} record */
function inspectProgress(record) {
	return {
		seq: inspectInteger(record.seq),
		revision: inspectInteger(record.revision),
		recordedAt: inspectInteger(record.recordedAt),
		ev: inspectString(record.ev, 64),
		agentSeq: inspectInteger(record.agentSeq),
		gid: inspectInteger(record.gid),
		index: inspectInteger(record.index),
		n: inspectInteger(record.n),
		label: inspectString(record.label, INSPECT_LABEL_CHARS),
		model: inspectString(record.model, INSPECT_LABEL_CHARS),
		phase: inspectString(record.phase, INSPECT_LABEL_CHARS),
		phaseId: inspectString(record.phaseId, 256),
		attemptId: inspectString(record.attemptId, 255),
		branchPath: inspectString(record.branchPath, 256),
		kind: inspectString(record.kind, 64),
		status: inspectString(record.status, 64),
		error: inspectString(record.error),
		ok: record.ok === true,
		cached: record.cached === true,
		skipped: record.skipped === true,
		nanoAiu: finiteNumber(record.nanoAiu),
		outputTokens: inspectInteger(record.outputTokens),
	};
}

/** Prompt-safe, bounded usage representation. @param {any} record */
function inspectUsage(record) {
	return {
		revision: inspectInteger(record.revision),
		recordedAt: inspectInteger(record.recordedAt),
		key: inspectString(record.key, 1000),
		outcome: inspectString(record.outcome, 64),
		label: inspectString(record.label, INSPECT_LABEL_CHARS),
		sessionId: inspectString(record.sessionId, 255),
		model: inspectString(record.model, INSPECT_LABEL_CHARS),
		nanoAiu: finiteNumber(record.nanoAiu),
		unknownUsage: record.unknownUsage === 1,
		durationMs: finiteNumber(record.durationMs),
		inputTokens: inspectInteger(record.inputTokens),
		outputTokens: inspectInteger(record.outputTokens),
		cacheReadTokens: inspectInteger(record.cacheReadTokens),
		cacheWriteTokens: inspectInteger(record.cacheWriteTokens),
		reasoningTokens: inspectInteger(record.reasoningTokens),
	};
}

/** @param {...unknown} values @returns {string} */
function resultStatus(...values) {
	for (const value of values) {
		if (typeof value !== "string") continue;
		const text = value.trim();
		if (text) return text.slice(0, 64);
	}
	return "unknown";
}

/** @param {unknown} value @param {string} name @returns {number} */
function resultInteger(value, name) {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new ConveyorResultError(`${name} must be a non-negative safe integer.`);
	}
	return value;
}

/**
 * Slice text for bounded tool/notification output.
 * @param {string} text @param {number} offset @param {number} limit
 * @returns {{ text: string, nextOffset: number|null }}
 */
export function pageText(text, offset, limit) {
	const start = Math.min(offset, text.length);
	const end = Math.min(start + limit, text.length);
	return {
		text: text.slice(start, end),
		nextOffset: end < text.length ? end : null,
	};
}

/** @param {string} runId @param {string} resultPath @returns {any|undefined} */
function readResultArtifact(runId, resultPath) {
	let raw;
	try {
		const stat = lstatSync(resultPath);
		if (!stat.isFile()) throw new ConveyorResultError(`conveyor result for '${runId}' is not a regular file.`);
		raw = readFileSync(resultPath, "utf8");
	} catch (e) {
		if (e instanceof ConveyorResultError) throw e;
		if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return undefined;
		throw new ConveyorResultError(`conveyor result for '${runId}' could not be read: ${e instanceof Error ? e.message : e}`);
	}
	try {
		return JSON.parse(raw);
	} catch {
		throw new ConveyorResultError(`conveyor result for '${runId}' is malformed JSON.`);
	}
}

/**
 * Load the canonical persisted result state for a conveyor run.
 * @param {unknown} requestedRunId
 * @returns {{ runId: string, status: string, error: string|null, aic: number|null, failure: unknown, revision: number, resultAvailable: boolean, result?: unknown }}
 */
export function loadConveyorResult(requestedRunId) {
	if (!isValidRunId(requestedRunId)) throw new ConveyorResultError("runId must be a bare conveyor run id (1-255 characters, no path separators).");
	const runId = requestedRunId;
	const dir = findRunDir(runId);
	if (!dir) throw new ConveyorResultError(`no conveyor run found with id '${runId}'. Use list_conveyor_runs to find a runId.`);
	const rec = runRecordOf(dir) || {};
	if (rec.status === "running") {
		return {
			runId,
			status: "running",
			error: resultError(rec.error),
			aic: finiteNumber(rec.aic),
			failure: null,
			revision: inspectInteger(rec.revision) ?? 0,
			resultAvailable: false,
		};
	}

	const artifact = readResultArtifact(runId, join(dir, "run.json"));
	if (artifact === undefined) {
		return {
			runId,
			status: resultStatus(rec?.status),
			error: resultError(rec?.error),
			aic: finiteNumber(rec?.aic),
			failure: rec?.failure ?? null,
			revision: inspectInteger(rec?.revision) ?? 0,
			resultAvailable: false,
		};
	}

	if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
		throw new ConveyorResultError(`conveyor result for '${runId}' must be a JSON object.`);
	}
	const interruptedRevision = new Ledger(dir, {
		readOnly: true,
		mode: "summary",
	}).interruptedRevision;
	if (interruptedRevision > Number(artifact.revision || 0)) {
		return {
			runId,
			status: "interrupted",
			error: "conveyor host process exited before completion",
			aic: finiteNumber(rec?.aic),
			failure: rec?.failure ?? null,
			revision: Math.max(
				interruptedRevision,
				inspectInteger(rec?.revision) ?? 0,
			),
			resultAvailable: false,
		};
	}
	if (
		Number.isSafeInteger(rec?.revision) &&
		Number.isSafeInteger(artifact.revision) &&
		rec.revision > artifact.revision
	) {
		return {
			runId,
			status: resultStatus(rec.status),
			error: resultError(rec.error),
			aic: finiteNumber(rec.aic),
			failure: rec.failure ?? null,
			revision: rec.revision,
			resultAvailable: false,
		};
	}
	if (artifact.runId != null && artifact.runId !== runId) {
		throw new ConveyorResultError(`conveyor result artifact id does not match requested run '${runId}'.`);
	}
	if (Object.hasOwn(artifact, "result")) assertJson(artifact.result, { label: `Conveyor result '${runId}'` });
	return {
		runId,
		status: resultStatus(artifact.status, rec?.status),
		error: resultError(artifact.error),
		aic: finiteNumber(artifact.aic) ?? finiteNumber(rec?.aic),
		failure: artifact.failure ?? null,
		revision: inspectInteger(artifact.revision) ?? inspectInteger(rec?.revision) ?? 0,
		resultAvailable: Object.hasOwn(artifact, "result"),
		...(Object.hasOwn(artifact, "result") ? { result: artifact.result } : {}),
	};
}

/**
 * Read-only import seam for trusted local extensions.
 * @param {unknown} requestedRunId
 */
export function loadConveyorRunForImport(requestedRunId) {
	const loaded = loadConveyorResult(requestedRunId);
	const runId = loaded.runId;
	const dir = findRunDir(runId);
	if (!dir) throw new ConveyorResultError(`no conveyor run found with id '${runId}'.`);
	const manifest = readResultArtifact(runId, join(dir, "manifest.json"));
	if (!manifest) throw new ConveyorResultError(`conveyor run '${runId}' has no manifest.`);
	if (manifest.runId !== runId) throw new ConveyorResultError(`conveyor manifest id does not match requested run '${runId}'.`);
	const scriptPath = join(dir, "script.js");
	let script;
	try {
		if (!lstatSync(scriptPath).isFile()) throw new ConveyorResultError(`conveyor script for '${runId}' is not a regular file.`);
		script = readFileSync(scriptPath, "utf8");
	} catch (error) {
		if (error instanceof ConveyorResultError) throw error;
		throw new ConveyorResultError(`conveyor script for '${runId}' could not be read: ${error instanceof Error ? error.message : error}`);
	}
	const args = assertJson(manifest.args ?? null, { label: `Conveyor arguments '${runId}'` });
	const run = readResultArtifact(runId, join(dir, "run.json")) ?? {};
	const hostDir = join(dir, "host");
	/** @type {string|null} */
	let hostPath = null;
	try {
		const hostStat = lstatSync(hostDir);
		if (!hostStat.isDirectory() || hostStat.isSymbolicLink()) throw new Error("host path is not a real directory");
		verifyHostSnapshot(hostDir);
		hostPath = hostDir;
	} catch (error) {
		if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") {
			throw new ConveyorResultError(`conveyor host snapshot for '${runId}' is invalid: ${error instanceof Error ? error.message : error}`);
		}
	}
	return {
		...loaded,
		importContractVersion: CONVEYOR_IMPORT_CONTRACT_VERSION,
		conveyor: conveyorName(manifest, run) || null,
		args,
		argsSha256: hashValue(args),
		source: script,
		scriptSha256: createHash("sha256").update(script).digest("hex"),
		restricted: manifest.restricted === true,
		enableMcp: manifest.enableMcp === true,
		strictBudget: manifest.strictBudget === true,
		model: manifest.model ?? null,
		effort: manifest.effort ?? null,
		context: manifest.context ?? null,
		previewPlanId: manifest.planId ?? null,
		progressMode: manifest.progressMode ?? null,
		maxAgents: inspectInteger(manifest.maxAgents),
		declaredLimits: assertJson(manifest.declaredLimits ?? {}, {
			label: `Conveyor limits '${runId}'`,
		}),
		hostPath,
		preservedWorktrees: Array.isArray(run.preservedWorktrees) ? run.preservedWorktrees.map(String) : [],
	};
}

/**
 * Format-agnostic liveness seam for recovery decisions.
 *
 * This deliberately skips manifest validation: callers use it only to decide
 * whether an older persisted run is still active after a format upgrade.
 *
 * @param {unknown} requestedRunId
 */
export function getConveyorRunActivity(requestedRunId) {
	if (!isValidRunId(requestedRunId)) {
		throw new ConveyorResultError("runId must be a bare conveyor run id.");
	}
	const runId = requestedRunId;
	const dir = findRunDir(runId);
	if (!dir) return { runId, exists: false, status: "missing", active: false };
	const record = runRecordOf(dir) || {};
	const status = resultStatus(record.status);
	return {
		runId,
		exists: true,
		status,
		active: status === "running",
	};
}

/**
 * `get_conveyor_result` implementation. Returns JSON so pagination metadata remains machine-readable.
 * @param {{ runId?: unknown, offset?: unknown, limit?: unknown, format?: unknown }} input
 * @returns {string}
 */
export function getConveyorResult(input) {
	const offset = resultInteger(input?.offset ?? 0, "offset");
	const limit = resultInteger(input?.limit ?? MAX_RESULT_CHUNK_CHARS, "limit");
	if (limit < 1 || limit > MAX_RESULT_CHUNK_CHARS) {
		throw new ConveyorResultError(`limit must be between 1 and ${MAX_RESULT_CHUNK_CHARS} characters.`);
	}
	const loaded = loadConveyorResult(input?.runId);
	if (!loaded.resultAvailable) {
		const mayStillFinish = loaded.status === "running" || loaded.status === "unknown";
		return JSON.stringify(
			{
				...loaded,
				guidance: mayStillFinish
					? "Result is not available yet. Wait for the conveyor completion notification; do not poll this tool."
					: `The run is ${loaded.status} and has no result artifact. Waiting will not produce one; inspect /conveyor ${loaded.runId} or resume/re-run the conveyor.`,
			},
			null,
			2,
		);
	}
	const format = input?.format ?? "value";
	if (format !== "value" && format !== "text") throw new ConveyorResultError("format must be value or text.");
	if (format === "value") {
		const encoded = JSON.stringify(loaded.result);
		if (encoded.length > MAX_RESULT_CHUNK_CHARS) {
			throw new ConveyorResultError(`structured result exceeds ${MAX_RESULT_CHUNK_CHARS} characters; request format:'text' and paginate it.`);
		}
		return JSON.stringify({ ...loaded, format: "value" }, null, 2);
	}
	const serialized = typeof loaded.result === "string" ? loaded.result : JSON.stringify(loaded.result, null, 2);
	const page = pageText(serialized, offset, limit);
	return JSON.stringify(
		{
			...loaded,
			result: page.text,
			format: "text",
			offset,
			nextOffset: page.nextOffset,
		},
		null,
		2,
	);
}

/**
 * `inspect_conveyor_run` implementation. Returns bounded JSON metadata without result text or args.
 * String fields originate from conveyor-provided data and must be treated as untrusted.
 * @param {{ runId?: unknown }} input
 * @returns {string}
 */
export function inspectConveyorRun(input) {
	const requestedRunId = input?.runId;
	if (!isValidRunId(requestedRunId)) throw new ConveyorResultError("runId must be a bare conveyor run id (1-255 characters, no path separators).");
	const runId = requestedRunId;
	const dir = findRunDir(runId);
	if (!dir) throw new ConveyorResultError(`no conveyor run found with id '${runId}'. Use list_conveyor_runs to find a runId.`);

	const manifest = readJson(join(dir, "manifest.json")) || {};
	const state = readJson(join(dir, "state.json")) || {};
	const rec = runRecordOf(dir) || {};
	const ledger = new Ledger(dir, { readOnly: true, mode: "records", types: ["branches_invalidated"] });
	const records = ledger.records;
	const status = resultStatus(rec.status, state.status);
	let result;
	try {
		const loaded = loadConveyorResult(runId);
		result = { available: loaded.resultAvailable, status: inspectString(loaded.status, 64) };
	} catch (e) {
		if (!(e instanceof ConveyorResultError)) throw e;
		result = { available: false, error: inspectString(e.message) };
	}

	const conveyor = inspectString(conveyorName(manifest, rec), INSPECT_LABEL_CHARS);
	const resumable = status !== "running" && !!manifest.runId && existsSync(join(dir, "script.js"));
	const heartbeatAt = workHeartbeatAt(dir, state.updatedAt);
	return JSON.stringify(
		{
			runId,
			status,
			conveyor: conveyor || null,
			title: inspectString(rec.title ?? state.title ?? conveyor, INSPECT_LABEL_CHARS),
			phase: inspectString(state.phase ?? rec.phase, INSPECT_LABEL_CHARS),
			revision: Math.max(inspectInteger(state.revision) ?? 0, inspectInteger(rec.revision) ?? 0, ledger.revision),
			phases: Array.isArray(state.phases) ? state.phases.slice(0, INSPECT_LIST_LIMIT) : [],
			backend: inspectString(manifest.backend, 64),
			permissionMode: inspectString(manifest.permissionMode, 128),
			parentPermissionMode: inspectString(manifest.parentPermissionMode, 32),
			parentSessionMode: inspectString(manifest.parentSessionMode, 32),
			permissionInheritance:
				manifest.permissionInheritance && typeof manifest.permissionInheritance === "object" && !Array.isArray(manifest.permissionInheritance)
					? Object.fromEntries(
							Object.entries(manifest.permissionInheritance)
								.slice(0, 20)
								.map(([key, value]) => [inspectString(key, 128), inspectString(value, 256)]),
						)
					: null,
			resumable,
			controlActions: status === "running" ? ["pause", "cancel"] : resumable ? ["resume"] : [],
			timing: {
				startedAt: inspectString(rec.startedAt ?? state.startedAt, 128),
				updatedAt: inspectString(state.updatedAt ?? rec.updatedAt ?? manifest.createdAt, 128),
				heartbeatAt: inspectString(heartbeatAt, 128),
				heartbeatAgeMs: heartbeatAge(heartbeatAt),
				finishedAt: inspectString(rec.finishedAt, 128),
				durationMs: finiteNumber(rec.durationMs),
			},
			aic: finiteNumber(rec.aic) ?? finiteNumber(state.aic),
			budget: inspectBudget(rec.budget),
			limits: {
				declared: manifest.declaredLimits ?? {},
				approved: ledger.approvedLimits,
				consumed: ledger.consumed,
			},
			counts: inspectCounts(rec.counts ?? state.counts),
			running: status === "running" ? inspectRunning(state.running) : [],
			groups: status === "running" ? inspectGroups(state.groups) : [],
			recent: inspectRecent(state.recent),
			errors: inspectErrors(state.errors),
			error: inspectString(rec.error ?? state.error),
			invalidations: inspectInvalidations(records),
			branchPathFormat: "/ is the root; /0 and /0/2 identify nested parallel or pipeline item branches.",
			preservedWorktrees: inspectPaths(rec.preservedWorktrees),
			preservedSessions: inspectPaths(rec.preservedSessions),
			result,
			artifactsDir: inspectString(dir),
		},
		null,
		2,
	);
}

/**
 * Inspect one conveyor agent from typed ledger records.
 * @param {{ runId?: unknown, agent?: unknown, section?: unknown, offset?: unknown, limit?: unknown }} input
 */
export function inspectConveyorAgent(input) {
	const runId = input?.runId;
	if (!isValidRunId(runId)) throw new ConveyorResultError("runId must be a bare conveyor run id (1-255 characters, no path separators).");
	const dir = findRunDir(runId);
	if (!dir) throw new ConveyorResultError(`no conveyor run found with id '${runId}'. Use list_conveyor_runs to find a runId.`);
	const agent = String(input?.agent || "").trim();
	if (!agent) throw new ConveyorResultError("agent must be a durable key, sessionId, or label.");
	const section = String(input?.section || "summary");
	if (!["summary", "events", "usage"].includes(section)) throw new ConveyorResultError("section must be summary, events, or usage; use get_conveyor_agent_content for prompt or result text.");
	const offset = resultInteger(input?.offset ?? 0, "offset");
	const limit = resultInteger(input?.limit ?? MAX_RESULT_CHUNK_CHARS, "limit");
	if (limit < 1 || limit > MAX_RESULT_CHUNK_CHARS) throw new ConveyorResultError(`limit must be between 1 and ${MAX_RESULT_CHUNK_CHARS} characters.`);

	const records = new Ledger(dir, { readOnly: true, mode: "records", types: ["agent_started", "agent_usage", "result", "progress"] }).records;
	const keys = new Set();
	for (const record of records) {
		const value = record.value;
		if (record.key === agent || record.label === agent || record.sessionId === agent || value?.label === agent || value?.sessionId === agent) keys.add(record.key);
	}
	if (!keys.size) throw new ConveyorResultError(`no conveyor agent matched '${agent}' in run '${runId}'.`);
	const selected = records.filter((record) => keys.has(record.key));
	const started = selected.filter((record) => record.type === "agent_started").at(-1);
	const resultRecord = selected.filter((record) => record.type === "result").at(-1);
	const usage = selected.filter((record) => record.type === "agent_usage");
	const result = resultRecord?.value;
	if (section === "summary") {
		return JSON.stringify(
			{
				runId,
				key: started?.key ?? resultRecord?.key ?? usage[0]?.key,
				branchPath: inspectString(started?.branchPath, 256) || branchPath(started?.branch) || "/",
				label: inspectString(started?.label ?? result?.label, INSPECT_LABEL_CHARS),
				sessionId: inspectString(result?.sessionId ?? usage.at(-1)?.sessionId, 255),
				model: inspectString(result?.model ?? started?.model, INSPECT_LABEL_CHARS),
				outcome: usage.at(-1)?.outcome ?? (result?.ok ? "ok" : null),
				aic: usage.reduce((sum, record) => sum + (finiteNumber(record.nanoAiu) || 0), 0) / 1_000_000_000,
				usageUnknown: usage.some((record) => record.unknownUsage),
				attempts: usage.length,
				hasPrompt: typeof started?.prompt === "string",
				hasResult: typeof result?.content === "string",
			},
			null,
			2,
		);
	}
	if (section === "usage") {
		const pageLimit = Math.min(limit, 200);
		const page = usage.slice(offset, offset + pageLimit).map(inspectUsage);
		return JSON.stringify({ runId, agent, usage: page, offset, nextOffset: offset + page.length < usage.length ? offset + page.length : null }, null, 2);
	}
	const text = readAgentEvents(records, started?.agentSeq, started?.attemptId);
	const page = pageText(text, offset, limit);
	return JSON.stringify({ runId, agent, section, text: page.text, offset, nextOffset: page.nextOffset }, null, 2);
}

/** Permission-gated raw prompt/result retrieval. */
export function getConveyorAgentContent(input) {
	const section = String(input?.section || "");
	if (!["prompt", "result"].includes(section)) throw new ConveyorResultError("section must be prompt or result.");
	const runId = input?.runId;
	if (!isValidRunId(runId)) throw new ConveyorResultError("runId must be a bare conveyor run id.");
	const dir = findRunDir(runId);
	if (!dir) throw new ConveyorResultError(`no conveyor run found with id '${runId}'.`);
	const agent = String(input?.agent || "").trim();
	if (!agent) throw new ConveyorResultError("agent must be a durable key, sessionId, or label.");
	const records = new Ledger(dir, { readOnly: true, mode: "records", types: ["agent_started", "result"] }).records;
	const keys = new Set();
	for (const record of records) {
		const value = record.value;
		if (record.key === agent || record.label === agent || record.sessionId === agent || value?.label === agent || value?.sessionId === agent) keys.add(record.key);
	}
	if (!keys.size) throw new ConveyorResultError(`no conveyor agent matched '${agent}' in run '${runId}'.`);
	const selected = records.filter((record) => keys.has(record.key));
	const started = selected.filter((record) => record.type === "agent_started").at(-1);
	const result = selected.filter((record) => record.type === "result" && record.kind === "agent").at(-1)?.value;
	const text = section === "prompt" ? String(started?.prompt ?? "") : String(result?.content ?? "");
	const offset = resultInteger(input?.offset ?? 0, "offset");
	const limit = resultInteger(input?.limit ?? MAX_RESULT_CHUNK_CHARS, "limit");
	const page = pageText(text, offset, limit);
	return JSON.stringify({ runId, agent, section, text: page.text, offset, nextOffset: page.nextOffset }, null, 2);
}

/** Page durable Conveyor progress by revision-backed sequence. */
export function getConveyorProgress(input) {
	const runId = input?.runId;
	if (!isValidRunId(runId)) throw new ConveyorResultError("runId must be a bare conveyor run id.");
	const dir = findRunDir(runId);
	if (!dir) throw new ConveyorResultError(`no conveyor run found with id '${runId}'.`);
	const limit = Math.min(500, Math.max(1, resultInteger(input?.limit ?? 200, "limit")));
	const afterSeq = input?.afterSeq == null ? null : resultInteger(input.afterSeq, "afterSeq");
	const beforeSeq = input?.beforeSeq == null ? null : resultInteger(input.beforeSeq, "beforeSeq");
	if (afterSeq != null && beforeSeq != null) throw new ConveyorResultError("afterSeq and beforeSeq are mutually exclusive.");
	const ledger = new Ledger(dir, { readOnly: true, mode: "records", types: ["progress"] });
	const entries = ledger.records;
	const ledgerRecords = entries.filter((record) => record.type === "progress" && record.record);
	const allRecords = ledgerRecords
		.map((entry) => inspectProgress({
			...entry.record,
			seq: entry.revision,
			revision: entry.revision,
			recordedAt: entry.recordedAt,
		}))
		.sort((a, b) => Number(a.seq) - Number(b.seq));
	const scoped = input?.phaseId ? allRecords.filter((record) => record.phaseId === input.phaseId) : allRecords;
	let records = scoped;
	if (afterSeq != null) records = records.filter((record) => Number(record.seq) > afterSeq).slice(0, limit);
	else if (beforeSeq != null) records = records.filter((record) => Number(record.seq) < beforeSeq).slice(-limit);
	else records = records.slice(-limit);
	const oldest = records[0];
	const newest = records.at(-1);
	return JSON.stringify({
		runId,
		records,
		oldestSeq: oldest?.seq ?? null,
		newestSeq: newest?.seq ?? null,
		revision: ledger.revision,
		hasMoreOlder: oldest != null && scoped.some((record) => Number(record.seq) < Number(oldest.seq)),
		hasMoreNewer: newest != null && scoped.some((record) => Number(record.seq) > Number(newest.seq)),
	}, null, 2);
}

/** @param {any[]} records @param {unknown} agentSeq @param {unknown} attemptId */
function readAgentEvents(records, agentSeq, attemptId) {
	if (!Number.isSafeInteger(agentSeq)) return "";
	return records
		.filter((record) => record.type === "progress" && record.record)
		.filter((record) => record.record.agentSeq === agentSeq && record.record.attemptId === attemptId)
		.map((record) => inspectProgress({ ...record.record, seq: record.revision, revision: record.revision, recordedAt: record.recordedAt }))
		.map((event) => JSON.stringify(event))
		.join("\n");
}

/** @returns {string|null} the most recently updated run id, or null. */
function latestRunId() {
	const dir = runsDir();
	if (!existsSync(dir)) return null;
	return listRunDirs(dir)[0]?.name || null;
}

/**
 * The best available record for a run: live state, terminal run, or ledger replay.
 * @param {string} runDir @returns {any}
 */
function runRecordOf(runDir) {
	const state = reconcileWorkRecord(readJson(join(runDir, "state.json")), runDir);
	const owner = readWorkOwner(runDir);
	const terminal = readJson(join(runDir, "run.json"));
	const heartbeat = state ? heartbeatAge(state.heartbeatAt ?? state.updatedAt) : null;
	const ownerLive = !!owner
		&& state?.status === "running"
		&& processIsAlive(owner.pid)
		&& heartbeat != null
		&& heartbeat <= 30_000;
	if (state?.status === "interrupted") return state;
	if (terminal && isTerminalStatus(terminal.status)) {
		const ledger = new Ledger(runDir, { readOnly: true, mode: "summary" });
		if (!ledger.interruptedRevision || Number(terminal.revision || 0) >= ledger.interruptedRevision) return terminal;
		if (ownerLive) {
			return state?.status === "running"
				? state
				: { status: "running", revision: ledger.revision, updatedAt: new Date().toISOString() };
		}
		return {
			status: "interrupted",
			revision: ledger.revision,
			error: "conveyor host process exited before completion",
		};
	}
	if (ownerLive) {
		return state?.status === "running"
			? state
			: { status: "running", revision: Number(terminal?.revision || 0), updatedAt: new Date().toISOString() };
	}
	if (state?.status === "running") {
		return {
			...state,
			status: "interrupted",
			error: "conveyor has no current owner heartbeat",
		};
	}
	if (state) return state;
	if (owner && !processIsAlive(owner.pid)) {
		return { status: "interrupted", error: "conveyor host process exited before completion" };
	}
	return replayLedger(runDir);
}


/** @param {unknown} value */
function heartbeatAge(value) {
	const timestamp = timestampMs(value);
	return timestamp > 0 ? Math.max(0, Date.now() - timestamp) : null;
}

/** Reconstruct a minimal record from ledger progress when state/run json are missing. @param {string} runDir */
function replayLedger(runDir) {
	const progress = new Ledger(runDir, { readOnly: true, mode: "records", types: ["progress"] }).records.filter((entry) => entry.record);
	if (!progress.length) return null;
	/** @type {any} */
	let meta = {};
	/** @type {{ nanoAiu?: unknown, status?: unknown, error?: unknown, agents?: unknown, launched?: unknown, done?: unknown, failed?: unknown, cached?: unknown, skipped?: unknown, dropped?: unknown, aic?: unknown, t?: unknown }|null} */
	let end = null;
	for (const entry of progress) {
		const rec = entry.record;
		if (rec.ev === "run_start") meta = { ...(rec.meta || {}) };
		else if (rec.ev === "run_end") end = rec;
	}
	if (!end) {
		return {
			status: "interrupted",
			conveyor: meta,
			counts: null,
			aic: 0,
			error: "conveyor has no active owner or terminal record",
		};
	}
	const nanoAiu = Number(end.nanoAiu ?? 0);
	return {
		status: end.status || "complete",
		error: end.error || null,
		conveyor: meta,
		counts: { agents: end.agents, launched: end.launched, done: end.done, failed: end.failed, cached: end.cached, skipped: end.skipped, dropped: end.dropped || 0 },
		aic: end.aic != null ? Number(end.aic || 0) : nanoAiu / 1_000_000_000,
		updatedAt: progressTimestamp(end.t),
	};
}

/** @param {unknown} value epoch milliseconds, as every progress event records. */
function progressTimestamp(value) {
	if (value == null) return undefined;
	const raw = Number(value);
	if (!Number.isFinite(raw)) return undefined;
	const date = new Date(raw);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * @param {string} runId @param {any} rec @param {string} dir @returns {string}
 */
function formatRunSummary(runId, rec, dir) {
	const c = rec?.counts;
	return [
		`conveyor run ${runId}`,
		`status: ${rec?.status ?? "?"}`,
		rec?.conveyor?.name ? `conveyor: ${rec.conveyor.name}` : "",
		c ? `agents: ${c.agents} (done ${c.done}, cached ${c.cached}, skipped ${c.skipped}, failed ${c.failed}, dropped ${c.dropped || 0})` : "",
		rec?.aic != null ? `AIC: ${Number(rec.aic).toFixed(1)}` : "",
		rec?.durationMs != null ? `duration: ${(rec.durationMs / 1000).toFixed(1)}s` : "",
		rec?.preservedWorktrees?.length ? `preserved worktrees: ${rec.preservedWorktrees.join(", ")}` : "",
		rec?.preservedSessions?.length ? `preserved sessions: ${rec.preservedSessions.join(", ")}` : "",
		rec?.error ? `error: ${rec.error}` : "",
		`artifacts: ${dir}`,
		`result: ${join(dir, "run.json")}`,
	]
		.filter(Boolean)
		.join("\n");
}

/** @param {string} runId @param {string} dir @returns {string|null} dashboard text when state.json exists. */
function formatRunDashboard(runId, dir) {
	const state = reconcileWorkRecord(readJson(join(dir, "state.json")), dir);
	if (!state) return null;
	return formatDashboard({ ...state, runId: state.runId || runId });
}

/**
 * `/conveyor` command dispatcher. Renders read-only run inspection via `ctx.log`.
 *   /conveyor | /conveyor latest | /conveyor <runId> | /conveyor runs
 *   /conveyor result <id> | /conveyor artifacts <id>
 * @param {string} argsStr @param {{ log: (message: string, ephemeral?: boolean, level?: "info"|"warning"|"error") => void }} ctx
 */
export function conveyorCommand(argsStr, ctx) {
	const parts = String(argsStr || "").trim().split(/\s+/).filter(Boolean);
	const sub = parts[0] || "latest";
	const log = (/** @type {string} */ s) => ctx.log(s);

	if (sub === "runs") return void log(listConveyorRuns());

	if (sub === "result" || sub === "artifacts") {
		const id = parts[1] || latestRunId();
		if (!id) return void log("conveyor: no conveyor runs yet.");
		const dir = findRunDir(id);
		if (!dir) return void log(`conveyor: no run found with id '${id}'. Try /conveyor runs.`);
		if (sub === "result") {
			try {
				const loaded = loadConveyorResult(id);
				if (!loaded.resultAvailable) return void log("conveyor: no result yet (run may still be in progress).");
				const text = typeof loaded.result === "string" ? loaded.result : JSON.stringify(loaded.result, null, 2);
				return void log(text || "(empty result)");
			} catch (e) {
				if (e instanceof ConveyorResultError) return void log(`conveyor: ${e.message}`);
				throw e;
			}
		}
		const files = readdirSync(dir).sort().map((f) => `  ${join(dir, f)}`);
		return void log(`conveyor artifacts for ${id}:\n${files.join("\n")}`);
	}

	const id = sub === "latest" ? latestRunId() : sub;
	if (!id) return void log("conveyor: no conveyor runs yet. Start one with run_conveyor.");
	const dir = findRunDir(id);
	if (!dir) return void log(`conveyor: no run found with id '${id}'. Try /conveyor runs.`);
	log(formatRunDashboard(id, dir) || formatRunSummary(id, runRecordOf(dir), dir));
}
