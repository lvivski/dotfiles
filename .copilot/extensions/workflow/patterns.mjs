/**
 * @module patterns
 *
 * Composable orchestration helpers (`structured` / `verify` / `consensus` / `synthesize` /
 * `tournament` / `generateAndFilter` / `classify`). Each takes the
 * {@link import("./runtime.mjs").Runtime} as its first arg and routes every model call through
 * `rt.agent` / `rt.fanOut`, so they inherit progress, cache, resume, budget, and AIC accounting.
 * Fail-closed semantics are preserved: `verify` returns a failed verdict when the verifier errors;
 * `classify`/`tournament` throw when the model fails or returns nothing valid.
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
 * Merge many results/items into a single answer via one agent call.
 * @param {Runtime} rt @param {any[]} results
 * @param {{ prompt?: string, model?: string|null, label?: string, [k: string]: any }} [opts]
 * @returns {Promise<AgentResult>}
 */
export function synthesize(rt, results, opts = {}) {
	const { prompt = "Synthesize the following inputs into one coherent, de-duplicated result.", model = null, label = "synthesize", ...rest } = opts;
	const body = results.map((r, i) => `=== Input ${i + 1} ===\n${asText(r)}`).join("\n\n");
	return rt.agent(`${prompt}\n\n${body}`, { model, label, ...rest });
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

/**
 * Run multiple independent verifiers and return a quorum-backed majority {@link Consensus}.
 * @param {Runtime} rt @param {any} subject @param {any} rubric
 * @param {{ reviewers?: number, refute?: boolean, model?: string|null, models?: string[], label?: string, [k: string]: any }} [opts]
 * @returns {Promise<Consensus>}
 */
export async function consensus(rt, subject, rubric, opts = {}) {
	const { reviewers = 3, refute = true, model = null, models = null, label = "consensus", ...rest } = opts;
	if (reviewers < 1) throw new Error("reviewers must be >= 1");
	const cycle = models ? [...models] : [];
	if (model != null && cycle.length) throw new Error("pass either model or models, not both");
	if (cycle.some((m) => !String(m).trim())) throw new Error("models must contain non-empty model names");

	/** @param {number} i */
	const review = (i) => verify(rt, subject, rubric, { refute, model: cycle.length ? cycle[i % cycle.length] : model, label: `${label}-${i + 1}`, ...rest });
	/** @type {Verdict[]} */
	const verdicts = await rt.fanOut([...Array(reviewers).keys()], review);
	const quorum = Math.floor(reviewers / 2) + 1;
	const failedVerifiers = verdicts.filter((v) => !v.ok);
	const good = verdicts.filter((v) => v.ok);
	const passedCount = good.filter((v) => v.passed).length;
	const failedCount = good.length - passedCount;
	const erroredCount = failedVerifiers.length;
	if (good.length < quorum) {
		let error = `${good.length}/${reviewers} successful reviewers; quorum is ${quorum}`;
		if (failedVerifiers.length) error += "; " + failedVerifiers.map((v) => v.error || v.reasons).join("; ");
		return { passed: false, passedCount, failedCount, erroredCount, reviewers, reasons: error, dissent: "", verdicts, ok: false, error };
	}
	const threshold = Math.floor(good.length / 2) + 1;
	const majorityPassed = passedCount >= threshold;
	const dissent = verdicts
		.map((v, i) => [i + 1, v])
		.filter(([, v]) => /** @type {Verdict} */ (v).ok && /** @type {Verdict} */ (v).passed !== majorityPassed)
		.map(([i, v]) => `reviewer ${i} ${/** @type {Verdict} */ (v).passed ? "passed" : "failed"}: ${/** @type {Verdict} */ (v).reasons}`)
		.join("\n");
	let reasons = `${passedCount}/${good.length} successful reviewers passed`;
	if (failedVerifiers.length) reasons += `; ${erroredCount} verifier error(s) ignored after quorum`;
	reasons += dissent ? `; dissent:\n${dissent}` : "; unanimous";
	return { passed: majorityPassed, passedCount, failedCount, erroredCount, reviewers, reasons, dissent, verdicts, ok: true, error: "" };
}

/**
 * Single-elimination bracket; comparative judgment picks one winner. Throws if a judge fails or
 * returns no valid winner.
 * @param {Runtime} rt @param {any[]} candidates
 * @param {string | { criteria?: string, model?: string|null, label?: string, [k: string]: any }} [criteria]
 * @param {{ model?: string|null, label?: string, [k: string]: any }} [opts]
 * @returns {Promise<any>}
 */
export async function tournament(rt, candidates, criteria = "overall quality", opts = {}) {
	const crit = typeof criteria === "string" ? criteria : criteria.criteria || "overall quality";
	if (criteria && typeof criteria === "object") opts = { ...criteria, ...opts };
	const { model = null, label = "judge", ...rest } = opts;
	let items = [...candidates];
	if (!items.length) return null;
	let round = 0;
	while (items.length > 1) {
		round++;
		/** @type {[any, any][]} */
		const pairs = [];
		for (let i = 0; i + 1 < items.length; i += 2) pairs.push([items[i], items[i + 1]]);
		const byes = items.length % 2 ? [items[items.length - 1]] : [];
		rt.log(`  tournament round ${round}: ${pairs.length} pair(s), ${byes.length} bye(s)`);
		const winners = await rt.fanOut(pairs, (pr) => judgePair(rt, pr[0], pr[1], crit, model, label, rest));
		items = [...winners, ...byes];
	}
	return items[0];
}

/**
 * @param {Runtime} rt @param {any} a @param {any} b @param {string} criteria @param {string|null} model @param {string} label @param {object} rest
 */
async function judgePair(rt, a, b, criteria, model, label, rest) {
	const prompt = `Compare two candidates on: ${criteria}.\n\n=== Candidate A ===\n${asText(a)}\n\n=== Candidate B ===\n${asText(b)}\n\nPick the single better candidate. Give brief reasoning, then on the FINAL line output ONLY JSON: {"winner": "A"|"B", "why": "..."}`;
	const s = await structuredObject(rt, prompt, { model, label, retries: 0, ...rest });
	if (!s.raw.ok) throw new Error(`judge agent failed: ${s.raw.error || "unknown error"}`);
	if (!s.ok) throw new Error("judge did not return a JSON object");
	const winner = String(s.value.winner ?? "A").trim().toUpperCase();
	if (winner.startsWith("A")) return a;
	if (winner.startsWith("B")) return b;
	throw new Error("judge did not return winner A or B");
}

/**
 * Generate candidates, drop duplicates, keep those passing a filter/rubric.
 * @param {Runtime} rt @param {string | string[]} generate
 * @param {{ n?: number, keep?: (r: AgentResult) => boolean, rubric?: any, dedupe?: boolean, model?: string|null, label?: string }} [opts]
 * @returns {Promise<AgentResult[]>}
 */
export async function generateAndFilter(rt, generate, opts = {}) {
	const { n = 5, keep, rubric, dedupe = true, model = null, label = "generate" } = opts;
	const prompts = typeof generate === "string" ? Array(n).fill(generate) : [...generate];
	/** @type {AgentResult[]} */
	let cands = await rt.fanOut(prompts, (p) => rt.agent(p, { model, label }));
	cands = cands.filter((c) => c && typeof c === "object" && c.ok);

	if (dedupe) {
		const seen = new Set();
		const uniq = [];
		for (const c of cands) {
			const key = norm(c.content);
			if (key && !seen.has(key)) {
				seen.add(key);
				uniq.push(c);
			}
		}
		cands = uniq;
	}
	if (keep) return cands.filter(keep);
	if (rubric != null) {
		const pairs = await rt.fanOut(cands, async (c) => ({ c, v: await verify(rt, c, rubric, { refute: true, model }) }));
		return pairs.filter((p) => p.v.passed).map((p) => p.c);
	}
	return cands;
}

/**
 * Return exactly one of `classes` for `text`; throws if no valid label is returned.
 * @param {Runtime} rt @param {any} text @param {string[]} classes
 * @param {{ model?: string|null, label?: string, instructions?: string, [k: string]: any }} [opts]
 * @returns {Promise<string>}
 */
export async function classify(rt, text, classes, opts = {}) {
	const list = [...classes];
	if (!list.length) throw new Error("classes must contain at least one category");
	const { model = null, label = "classify", instructions, ...rest } = opts;
	const instr = instructions ? `${instructions}\n` : "";
	const prompt = `Classify the input into exactly one of these categories: ${list.join(", ")}.\n${instr}INPUT:\n${asText(text)}\n\nFINAL line: ONLY JSON {"category": "<one of the categories>"}`;
	const s = await structuredObject(rt, prompt, { model, label, retries: 0, ...rest });
	if (!s.raw.ok) throw new Error(`classifier agent failed: ${s.raw.error || "unknown error"}`);
	if (!s.ok) throw new Error(`classifier did not return valid JSON category: ${JSON.stringify(list)}`);
	const cat = String(s.value.category ?? "").trim();
	for (const c of list) if (cat.toLowerCase() === c.toLowerCase()) return c;
	throw new Error(`classifier did not return exactly one valid category: ${JSON.stringify(list)}`);
}
