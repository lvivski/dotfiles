import { createHash } from "node:crypto";
import path from "node:path";

/** @typedef {import("./model.d.ts").Json} Json */
/** @typedef {import("./model.d.ts").Scope} Scope */

export class FoundryError extends Error {
	/** @param {string} code @param {string} message */
	constructor(code, message) {
		super(message);
		this.name = "FoundryError";
		this.code = code;
	}
}

/** @param {unknown} value @returns {Record<string, unknown>} */
export function record(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new FoundryError("invalid_record", "Expected an object");
	}
	return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @param {string} label @returns {string} */
export function text(value, label) {
	if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
		throw new FoundryError("invalid_field", `${label} must be a nonempty string`);
	}
	return value;
}

/** @param {string} value @returns {string} */
export const nativeSessionName = value => value.trim().replace(/\s+/gu, " ");

/** @param {unknown} value @param {string} label @returns {string|undefined} */
export function optionalText(value, label) {
	return value === undefined ? undefined : text(value, label);
}

/** @param {unknown} value @param {string} label @param {string} [code] @returns {number} */
export function number(value, label, code = "invalid_field") {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new FoundryError(code, `${label} must be a finite number`);
	}
	return value;
}

/** @param {unknown} value @param {string} label @returns {number} */
export function natural(value, label) {
	const result = number(value, label);
	if (!Number.isSafeInteger(result) || result < 0) {
		throw new FoundryError("invalid_field", `${label} must be a nonnegative integer`);
	}
	return result;
}

/** @param {unknown} value @param {string} label @returns {number} */
export function positive(value, label) {
	const result = natural(value, label);
	if (!result) throw new FoundryError("invalid_field", `${label} must be positive`);
	return result;
}

/** @param {Record<string, unknown>} input @param {string[]} fields @param {string} [label] @returns {void} */
export function closedFields(input, fields, label = "source") {
	const extra = Object.keys(input).filter(key => !fields.includes(key));
	if (extra.length) throw new FoundryError("unsupported_fields", `Unsupported ${label} fields: ${extra.join(", ")}`);
}

/** @param {unknown} value @param {string} label @returns {boolean} */
export function boolean(value, label) {
	if (typeof value !== "boolean") throw new FoundryError("invalid_field", `${label} must be boolean`);
	return value;
}

/** @template T @param {unknown} value @param {(value: unknown) => T} decode @returns {T[]} */
export function array(value, decode) {
	if (!Array.isArray(value)) throw new FoundryError("invalid_field", "Expected an array");
	return value.map((/** @type {unknown} */ item) => decode(item));
}

/** @template {string} T @param {unknown} value @param {readonly T[]} choices @param {string} label @returns {T} */
export function choice(value, choices, label) {
	for (const option of choices) if (value === option) return option;
	throw new FoundryError("invalid_field", `${label} must be one of ${choices.join(", ")}`);
}

/** @param {unknown} value @returns {string[]} */
export function strings(value) {
	return array(value, (item) => text(item, "item"));
}

/** @param {unknown} value @returns {Json} */
export function json(value) {
	/** @type {Set<object>} */
	const seen = new Set();
	/** @param {unknown} item @returns {Json} */
	const decode = (item) => {
		if (item === null || typeof item === "string" || typeof item === "boolean") return item;
		if (typeof item === "number" && Number.isFinite(item)) return item;
		if (typeof item !== "object" || item === null || seen.has(item)) {
			throw new FoundryError("invalid_json", "Expected finite, acyclic JSON");
		}
		seen.add(item);
		try {
			if (Array.isArray(item)) return item.map((/** @type {unknown} */ entry) => decode(entry));
			const object = record(item);
			const prototype = Object.getPrototypeOf(object);
			if (prototype !== Object.prototype && prototype !== null) {
				throw new FoundryError("invalid_json", "Expected a plain JSON object");
			}
			return Object.fromEntries(Object.entries(object).map(([key, entry]) => [key, decode(entry)]));
		} finally {
			seen.delete(item);
		}
	};
	return decode(value);
}

/** @param {Json} value @returns {string} */
export function encoding(value) {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(encoding).join(",")}]`;
	return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${encoding(value[key])}`).join(",")}}`;
}

/** @param {Json} value @returns {string} */
export function digest(value) {
	return createHash("sha256").update(encoding(json(value))).digest("hex");
}

/** @param {unknown} value @returns {string} */
export function resourcePath(value) {
	const raw = text(value, "path").replaceAll("\\", "/");
	if (raw === "*") return ".";
	if (path.posix.isAbsolute(raw) || raw.split("/").includes("..")) {
		throw new FoundryError("invalid_path", "Paths must stay within their declared surface");
	}
	return path.posix.normalize(raw).replace(/\/$/, "") || ".";
}

/** @param {string} parent @param {string} child @returns {boolean} */
export function containsPath(parent, child) {
	return parent === "." || parent === child || child.startsWith(`${parent}/`);
}

/** @param {unknown} value @returns {Scope} */
export function decodeScope(value) {
	const item = record(value);
	return {
		mode: choice(item.mode, /** @type {const} */ (["autopilot", "interactive"]), "scope.mode"),
		delegation: boolean(item.delegation, "scope.delegation"),
		workTypes: strings(item.workTypes),
		paths: array(item.paths, resourcePath),
		restrictions: strings(item.restrictions),
	};
}

/** @param {Scope} parent @param {unknown} value @returns {Scope} */
export function narrowScope(parent, value) {
	const overrides = value === undefined ? {} : record(value);
	const scope = decodeScope({
		mode: overrides.mode === undefined ? parent.mode : overrides.mode,
		delegation: overrides.delegation === undefined ? parent.delegation : overrides.delegation,
		workTypes: overrides.workTypes === undefined ? parent.workTypes : overrides.workTypes,
		paths: overrides.paths === undefined ? parent.paths : overrides.paths,
		restrictions: [...new Set([...parent.restrictions, ...strings(overrides.restrictions === undefined ? [] : overrides.restrictions)])],
	});
	if ((parent.mode === "interactive" && scope.mode !== "interactive")
		|| (!parent.delegation && scope.delegation)
		|| scope.workTypes.some((type) => !parent.workTypes.includes("*") && !parent.workTypes.includes(type))
		|| scope.paths.some((child) => !parent.paths.some((base) => containsPath(base, child)))) {
		throw new FoundryError("scope_widening", "A task may inherit or narrow, never expand, its parent's scope");
	}
	return scope;
}

/** @param {unknown} value @returns {import("./model.d.ts").Limits} */
export function decodeLimits(value) {
	const item = record(value);
	const workers = item.workers === undefined ? undefined : natural(item.workers, "limits.workers");
	const repairs = item.repairs === undefined ? undefined : natural(item.repairs, "limits.repairs");
	const credits = item.credits === undefined ? undefined : number(item.credits, "limits.credits");
	const deadline = optionalText(item.deadline, "limits.deadline");
	if (credits !== undefined && credits < 0) throw new FoundryError("invalid_field", "Credits cannot be negative");
	if (deadline !== undefined && !Number.isFinite(Date.parse(deadline))) {
		throw new FoundryError("invalid_field", "Deadline must be an absolute date");
	}
	return {
		...(workers === undefined ? {} : { workers }),
		...(repairs === undefined ? {} : { repairs }),
		...(credits === undefined ? {} : { credits }),
		...(deadline === undefined ? {} : { deadline }),
	};
}

/** @param {unknown} value @returns {NonNullable<import("./model.d.ts").Goal["source"]>} */
export function decodeSource(value) {
	const item = record(value);
	const sha256 = text(item.sha256, "source.sha256");
	if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new FoundryError("invalid_field", "Invalid source SHA-256");
	return { reference: text(item.reference, "source.reference"), sha256 };
}

/** @param {unknown} value @returns {import("./model.d.ts").Check} */
export function decodeCheck(value) {
	const item = record(value);
	const command = text(item.command, "assigned check procedure");
	const pathname = optionalText(item.path, "check.path");
	const oracleFiles = item.oracleFiles === undefined ? undefined : array(item.oracleFiles, (entry) => {
		const oracle = record(entry);
		const sha256 = text(oracle.sha256, "oracle.sha256");
		if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new FoundryError("invalid_field", "Invalid oracle SHA-256");
		return { path: text(oracle.path, "oracle.path"), sha256 };
	});
	const artifactFiles = item.artifactFiles === undefined ? undefined : array(item.artifactFiles, resourcePath).sort();
	if (artifactFiles && (!artifactFiles.length || new Set(artifactFiles).size !== artifactFiles.length)) {
		throw new FoundryError("invalid_field", "Artifact files must be a nonempty unique file set");
	}
	return {
		id: text(item.id, "check.id"),
		origin: choice(item.origin, /** @type {const} */ (["user", "contract", "standing", "derived"]), "check.origin"),
		requirement: text(item.requirement, "check.requirement"),
		kind: choice(item.kind, /** @type {const} */ (["command", "artifact", "judgment"]), "check.kind"),
		version: text(item.version, "check.version"),
		command,
		...(pathname === undefined ? {} : { path: pathname }),
		...(oracleFiles === undefined ? {} : { oracleFiles }),
		...(artifactFiles === undefined ? {} : { artifactFiles }),
	};
}

/** @param {unknown} value @returns {import("./model.d.ts").Candidate} */
export function decodeCandidate(value) {
	const item = record(value);
	const files = array(item.files, value => {
		const file = record(value);
		const sha256 = text(file.sha256, "candidate file hash");
		const mode = natural(file.mode, "candidate file mode");
		if (!/^[a-f0-9]{64}$/.test(sha256) || mode > 0o777) throw new FoundryError("invalid_field", "Invalid candidate file identity");
		return { path: resourcePath(file.path), sha256, mode };
	}).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	const version = text(item.version, "candidate version");
	if (!files.length || new Set(files.map(file => file.path)).size !== files.length || digest(json(files)) !== version) {
		throw new FoundryError("candidate_identity_mismatch", "Candidate version must identify its exact declared files");
	}
	return { reference: text(item.reference, "candidate reference"), version, files };
}

/** @param {unknown} value @returns {import("./model.d.ts").Input} */
export function decodeInput(value) {
	const item = record(value);
	const version = optionalText(item.version, "input.version");
	return {
		taskId: text(item.taskId, "input task"),
		output: text(item.output, "input.output"),
		...(version === undefined ? {} : { version }),
	};
}

/** @param {import("./model.d.ts").Evidence[]} evidence in canonical admission order @returns {Map<string,import("./model.d.ts").Evidence>} */
export function latestEvidence(evidence) {
	return new Map(evidence.map(item => [JSON.stringify([item.checkId, item.checkVersion]), item]));
}

/** @param {unknown} value @returns {import("./model.d.ts").Output} */
export function decodeOutput(value) {
	const item = record(value);
	return {
		name: text(item.name, "output.name"),
		kind: choice(item.kind, /** @type {const} */ (["code", "analysis", "design", "review", "measurement", "artifact"]), "output.kind"),
		reference: text(item.reference, "output.reference"),
		version: text(item.version, "output.version"),
	};
}

/** @param {unknown} value @returns {import("./model.d.ts").Evidence} */
export function decodeEvidence(value) {
	const item = record(value);
	return {
		id: text(item.id, "evidence.id"), attemptId: text(item.attemptId, "evidence.attemptId"),
		checkId: text(item.checkId, "evidence.checkId"), checkVersion: text(item.checkVersion, "evidence.checkVersion"),
		outcome: choice(item.outcome, /** @type {const} */ (["passed", "failed", "pending"]), "evidence.outcome"),
		reference: text(item.reference, "evidence.reference"), summary: text(item.summary, "evidence.summary"),
		source: choice(item.source, /** @type {const} */ (["runner-receipt"]), "evidence.source"),
		...(item.candidate === undefined ? {} : { candidate: decodeCandidate(item.candidate) }),
		...(item.blocker === undefined ? {} : { blocker: choice(item.blocker, /** @type {const} */ (["input-artifact"]), "evidence.blocker") }),
	};
}

/** @param {unknown} value @returns {import("./model.d.ts").Finding} */
export function decodeFinding(value) {
	const item = record(value);
	const checkId = optionalText(item.checkId, "finding.checkId");
	const obligation = item.obligation === undefined ? undefined : choice(item.obligation,
		/** @type {const} */ (["regression", "crash", "data-loss", "security", "interface"]), "finding.obligation");
	const expected = optionalText(item.expected, "finding.expected");
	const observed = optionalText(item.observed, "finding.observed");
	return {
		summary: text(item.summary, "finding.summary"), evidenceIds: strings(item.evidenceIds),
		...(checkId === undefined ? {} : { checkId }),
		...(obligation === undefined ? {} : { obligation }),
		...(expected === undefined ? {} : { expected }),
		...(observed === undefined ? {} : { observed }),
	};
}

/** @param {unknown} value @returns {import("./model.d.ts").Task["waiting"]} */
export function decodeWaiting(value) {
	if (value === undefined) return undefined;
	const item = record(value);
	const requestId = optionalText(item.requestId, "waiting.requestId");
	const kind = choice(item.kind, /** @type {const} */ (["children", "input", "capacity", "factory", "events"]), "waiting.kind");
	return {
		kind,
		reason: text(item.reason, "waiting.reason"),
		...(kind === "factory" ? { cause: choice(item.cause, /** @type {const} */ (["paused", "stalled"]), "waiting.cause") } : {}),
		...(requestId === undefined ? {} : { requestId }),
	};
}

/** @param {unknown} value @returns {NonNullable<import("./model.d.ts").Task["dispatch"]>} */
export function decodeDispatch(value) {
	const item = record(value);
	return { context: strings(item.context), generator: boolean(item.generator, "dispatch.generator"),
		...(item.agent === undefined ? {} : { agent: text(item.agent, "dispatch.agent") }),
		...(item.baseBranch === undefined ? {} : { baseBranch: text(item.baseBranch, "dispatch.baseBranch") }) };
}
