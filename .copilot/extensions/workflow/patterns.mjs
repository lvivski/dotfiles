/**
 * @module patterns
 *
 * Composable orchestration helpers (`structured` / `verify`). Each takes the
 * {@link import("./runtime.mjs").Runtime} as its first arg and routes every model call through
 * `rt.agent`, so they inherit progress, cache, resume, budget, and AIC accounting.
 * Fail-closed semantics are preserved: `verify` returns a failed verdict when the verifier errors
 * rather than throwing or silently passing.
 *
 * Anything richer (merging, ranking, classifying, generate-and-filter) is a prompt plus `agent()`,
 * written in the harness.
 */

import { stableStringify } from "./json.mjs";

/** @typedef {import("./runtime.mjs").Runtime} Runtime */
/** @typedef {import("./agent.mjs").AgentResult} AgentResult */

/** @typedef {{ value: any, ok: boolean, error: string, raw: AgentResult, attempts: number }} Structured */
/** @typedef {{ passed: boolean, score: number|null, reasons: string, raw: AgentResult, ok: boolean, error: string }} Verdict */
/** @typedef {{ passed: boolean, passedCount: number, failedCount: number, erroredCount: number, reviewers: number, reasons: string, dissent: string, verdicts: Verdict[], ok: boolean, error: string }} Consensus */

/** Sentinel distinguishing "no JSON found" from a legitimately parsed `null`. */
const NOT_FOUND = Symbol("not-found");
const MAX_SCAN = 1_000_000; // cap embedded-JSON scanning to avoid pathological input
const MAX_DEPTH = 200; // cap nesting depth while locating a balanced value

/** @param {any} x @returns {string} text view (AgentResult -> its content). */
export function asText(x) {
	if (x && typeof x === "object" && typeof x.content === "string") return x.content;
	return String(x);
}

/** @param {string} s @returns {string} whitespace-collapsed, lowercased. */
const norm = (s) => (s || "").split(/\s+/).filter(Boolean).join(" ").toLowerCase();

/** @param {any} x @returns {number|null} */
const asFloat = (x) => {
	const n = Number(x);
	return Number.isFinite(n) ? n : null;
};

/**
 * Find the end index (exclusive) of a balanced JSON value starting at `open` in `text`, honoring
 * string/escape state. Returns -1 if unbalanced or too deep.
 * @param {string} text @param {number} open
 */
function balancedEnd(text, open) {
	const openCh = text[open];
	const closeCh = openCh === "{" ? "}" : "]";
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = open; i < text.length; i++) {
		const c = text[i];
		if (inStr) {
			if (esc) esc = false;
			else if (c === "\\") esc = true;
			else if (c === '"') inStr = false;
			continue;
		}
		if (c === '"') inStr = true;
		else if (c === openCh) {
			if (++depth > MAX_DEPTH) return -1;
		} else if (c === closeCh && --depth === 0) return i + 1;
	}
	return -1;
}

/**
 * Extract the last top-level JSON value (object OR array OR final-line scalar) from model output.
 * Prefers the final non-empty line parsed whole (the model's actual answer); otherwise scans for
 * embedded `{`/`[` values and keeps the last that decodes. Returns {@link NOT_FOUND} if none.
 * @param {string} text
 * @returns {any}
 */
export function extractLastJson(text) {
	if (!text) return NOT_FOUND;
	const lines = text.split(/\r?\n/);
	for (let i = lines.length - 1; i >= 0; i--) {
		const s = lines[i].trim().replace(/^`+|`+$/g, "").trim();
		if (!s) continue;
		try {
			return JSON.parse(s);
		} catch {
			break; // last content line isn't a clean value -> scan for embedded JSON
		}
	}
	let found = NOT_FOUND;
	const limit = Math.min(text.length, MAX_SCAN);
	for (let i = 0; i < limit; i++) {
		const c = text[i];
		if (c !== "{" && c !== "[") continue;
		const end = balancedEnd(text, i);
		if (end < 0) continue;
		try {
			found = JSON.parse(text.slice(i, end));
			i = end - 1;
		} catch {
			/* not valid JSON here; keep scanning */
		}
	}
	return found;
}

// ---- shape-schema (a documented JSON-Schema subset) -----------------------------------------
const SHAPE_KEYWORDS = new Set(["type", "properties", "required", "enum", "items", "additionalProperties", "description"]);
const SHAPE_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

/**
 * Validate a shape-schema *definition* up front, throwing on unsupported keywords/types.
 * @param {any} schema @param {string} [path]
 */
export function checkSchemaDef(schema, path = "$") {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error(`shape schema at ${path} must be an object`);
	for (const k of Object.keys(schema)) if (!SHAPE_KEYWORDS.has(k)) throw new Error(`unsupported shape-schema keyword at ${path}: ${k}`);
	if (schema.type != null && !SHAPE_TYPES.has(schema.type)) throw new Error(`unknown type ${JSON.stringify(schema.type)} at ${path}`);
	for (const [k, sub] of Object.entries(schema.properties || {})) checkSchemaDef(sub, `${path}.${k}`);
	if ("items" in schema) checkSchemaDef(schema.items, `${path}[]`);
}

/** @param {any} obj @param {string} t */
function typeOk(obj, t) {
	switch (t) {
		case "object":
			return obj != null && typeof obj === "object" && !Array.isArray(obj);
		case "array":
			return Array.isArray(obj);
		case "string":
			return typeof obj === "string";
		case "integer":
			return typeof obj === "number" && Number.isInteger(obj);
		case "number":
			return typeof obj === "number" && Number.isFinite(obj);
		case "boolean":
			return typeof obj === "boolean";
		case "null":
			return obj === null;
		default:
			return true;
	}
}

/**
 * Return an ordered list of human-readable shape violations (empty = valid).
 * @param {any} obj @param {any} schema @param {string} [path]
 * @returns {string[]}
 */
export function validateShape(obj, schema, path = "$") {
	/** @type {string[]} */
	const errors = [];
	if ("enum" in schema && !schema.enum.some((/** @type {any} */ e) => e === obj)) errors.push(`${path}: ${JSON.stringify(obj)} is not one of ${JSON.stringify(schema.enum)}`);
	const t = schema.type;
	if (t != null && !typeOk(obj, t)) {
		errors.push(`${path}: expected ${t}`);
		return errors;
	}
	if (t === "object" || (t == null && obj && typeof obj === "object" && !Array.isArray(obj))) {
		const props = schema.properties || {};
		for (const req of schema.required || []) if (!(req in obj)) errors.push(`${path}.${req}: required property missing`);
		if (schema.additionalProperties === false) for (const k of Object.keys(obj).sort()) if (!(k in props)) errors.push(`${path}.${k}: unexpected property`);
		for (const k of Object.keys(props).sort()) if (k in obj) errors.push(...validateShape(obj[k], props[k], `${path}.${k}`));
	} else if (t === "array" || (t == null && Array.isArray(obj))) {
		if (schema.items && Array.isArray(obj)) obj.forEach((el, idx) => errors.push(...validateShape(el, schema.items, `${path}[${idx}]`)));
	}
	return errors;
}

/**
 * @param {any} value @param {any} schema @param {boolean} isCallable
 * @returns {string[]}
 */
function validateValue(value, schema, isCallable) {
	if (isCallable) {
		let errs;
		try {
			errs = schema(value);
		} catch (e) {
			return [e instanceof Error ? e.message : String(e)];
		}
		if (!errs) return [];
		if (typeof errs === "string") return [errs];
		try {
			return Array.from(errs, String);
		} catch {
			return [String(errs)];
		}
	}
	return validateShape(value, schema);
}

/** @typedef {null | boolean | number | string | DryRunJson[] | { [key: string]: DryRunJson }} DryRunJson */

/** Produce one deterministic, schema-valid dry-run value without guessing array cardinality. @param {any} schema @returns {DryRunJson} */
function dryRunValue(schema) {
	if (schema?.enum?.length) return schema.enum[0];
	switch (schema?.type) {
		case "object":
			return Object.fromEntries(Object.entries(schema.properties || {}).map(([key, value]) => [key, dryRunValue(value)]));
		case "array":
			return [];
		case "string":
			return "dry-run";
		case "integer":
		case "number":
			return 0;
		case "boolean":
			return false;
		case "null":
			return null;
		default:
			return null;
	}
}

/**
 * Get a JSON value matching `schema` (a shape-schema object or a `validate(obj)` callable),
 * retrying with the parse/validation error fed back. Returns a {@link Structured}.
 * @param {Runtime} rt
 * @param {string} prompt
 * @param {object | ((obj: any) => any)} schema
 * @param {{ validate?: (obj: any) => any, retries?: number, model?: string|null, label?: string, [k: string]: any }} [opts]
 * @returns {Promise<Structured>}
 */
export async function structured(rt, prompt, schema, opts = {}) {
	const { validate, retries = 2, model = null, label = "structured", ...rest } = opts;
	if (retries < 0) throw new Error("retries must be >= 0");
	const isCallable = typeof schema === "function";
	let shape = "";
	if (!isCallable) {
		checkSchemaDef(schema);
		shape = `\n\nThe JSON must satisfy this shape (a documented subset of JSON Schema):\n${stableStringify(schema)}`;
	}
	const base = `${prompt}\n\nReason briefly if needed, then on the FINAL line output ONLY one JSON value (no code fences, nothing after it).${shape}`;

	let lastError = "";
	let value = null;
	/** @type {AgentResult | undefined} */
	let res;
	let attempts = 0;
	for (let attempt = 0; attempt <= retries; attempt++) {
		attempts = attempt + 1;
		const ask = lastError ? `${base}\n\nYour previous answer was rejected: ${lastError}\nReturn corrected JSON only.` : base;
		res = await rt.agent(ask, { model, label, ...rest });
		if (!res.ok) return { value: null, ok: false, error: res.error || "agent failed", raw: res, attempts };
		if (rt.dryRun) return { value: isCallable ? {} : dryRunValue(schema), ok: true, error: "", raw: res, attempts };
		const extracted = extractLastJson(res.content);
		if (extracted === NOT_FOUND) {
			lastError = "no JSON value found in the response";
			continue;
		}
		value = extracted;
		let errs = validateValue(value, schema, isCallable);
		if (!errs.length && validate) errs = validateValue(value, validate, true);
		if (!errs.length) return { value, ok: true, error: "", raw: res, attempts };
		lastError = errs.join("; ").slice(0, 500);
	}
	return { value, ok: false, error: lastError || "invalid", raw: /** @type {AgentResult} */ (res), attempts };
}

/**
 * Structured call constrained to a JSON object (used by verify/classify/tournament).
 * @param {Runtime} rt @param {string} prompt
 * @param {{ model?: string|null, label: string, retries?: number, [k: string]: any }} opts
 * @returns {Promise<Structured>}
 */
function structuredObject(rt, prompt, opts) {
	const { model = null, label, retries = 0, ...rest } = opts;
	const isObj = (/** @type {any} */ obj) => (obj && typeof obj === "object" && !Array.isArray(obj) ? "" : "expected JSON object");
	return structured(rt, prompt, isObj, { retries, model, label, ...rest });
}

/**
 * Check `subject` against `rubric`; returns a structured {@link Verdict}. Fail-closed: a verifier
 * agent failure yields a failed verdict (`ok:false`), never a throw.
 * @param {Runtime} rt @param {any} subject @param {any} rubric
 * @param {{ refute?: boolean, model?: string|null, label?: string, [k: string]: any }} [opts]
 * @returns {Promise<Verdict>}
 */
export async function verify(rt, subject, rubric, opts = {}) {
	const { refute = true, model = null, label = "verify", ...rest } = opts;
	const persona = refute
		? "You are a skeptical, adversarial reviewer. Actively hunt for flaws, unsupported claims, missing cases, or any way the work fails the rubric."
		: "You are a careful, fair reviewer.";
	const prompt = `${persona}\n\nRUBRIC / CRITERIA:\n${asText(rubric)}\n\nWORK UNDER REVIEW:\n${asText(subject)}\n\nDecide whether the work satisfies the rubric. Give brief reasoning, then on the FINAL line output ONLY a JSON object: {"passed": true|false, "score": 0..1, "reasons": "..."}`;
	const s = await structuredObject(rt, prompt, { model, label, retries: 0, ...rest });
	if (!s.raw.ok) {
		const error = s.raw.error || "verifier agent failed";
		return { passed: false, score: null, reasons: error, raw: s.raw, ok: false, error };
	}
	const data = s.ok ? s.value : {};
	const rawPassed = data.passed ?? false;
	const passed = typeof rawPassed === "string" ? rawPassed.trim().toLowerCase() === "true" : Boolean(rawPassed);
	return { passed, score: asFloat(data.score), reasons: String(data.reasons ?? s.raw.content.trim()), raw: s.raw, ok: true, error: "" };
}
