/**
 * @module sandbox
 *
 * Executes a `.cwf.mjs` harness in a deterministic `node:vm` context. The context exposes only an
 * approved global set — determinism-safe built-ins plus the injected CWF API — and disables dynamic
 * code generation (`eval`, `new Function`). `Math.random`, `Date.now()`, and argless `new Date()`
 * are removed/blocked.
 *
 * IMPORTANT: this is footgun-prevention + determinism, NOT a security jail. A pure vm context is
 * isolated, but the CWF API we inject is made of host-realm objects, and any one of them can be
 * used to reach the host realm (`fn.constructor.constructor("return process")()`). Sandbox genuinely
 * untrusted harness authors at the OS/agent level (`copilot --cloud` / `/sandbox`), not here.
 */
import vm from "node:vm";

/**
 * Build the frozen determinism-safe built-in globals a harness may use.
 * Excludes nondeterministic surfaces: `Math.random`, `Date.now()`, argless `new Date()`.
 * @returns {Record<string, unknown>}
 */
export function deterministicGlobals() {
	/** @type {Record<string, unknown>} */
	const safeMath = {};
	for (const k of Object.getOwnPropertyNames(Math)) if (k !== "random") safeMath[k] = /** @type {any} */ (Math)[k];
	Object.freeze(safeMath);

	const SafeDate = new Proxy(Date, {
		apply() {
			throw new Error("cwf: `Date()` is nondeterministic — use `new Date(timestamp)`");
		},
		construct(target, argsList, newTarget) {
			if (argsList.length === 0) throw new Error("cwf: `new Date()` is nondeterministic — pass an explicit timestamp");
			return Reflect.construct(target, argsList, newTarget);
		},
		get(target, prop, receiver) {
			if (prop === "now") return () => {
				throw new Error("cwf: `Date.now()` is nondeterministic — workflows must be reproducible");
			};
			return Reflect.get(target, prop, receiver);
		},
	});

	return {
		JSON, Array, Object, String, Number, Boolean, BigInt, Symbol, Set, Map, WeakMap, WeakSet,
		Promise, RegExp, Proxy, Reflect, ArrayBuffer, Uint8Array, Int32Array, Float64Array, DataView,
		Math: safeMath, Date: SafeDate, Intl, structuredClone, URL, URLSearchParams, TextEncoder, TextDecoder,
		Error, TypeError, RangeError, SyntaxError, EvalError, ReferenceError, URIError, AggregateError,
		parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
		queueMicrotask, atob, btoa,
	};
}

/** @param {unknown} x @returns {string} readable form for console routing. */
function fmt(x) {
	if (typeof x === "string") return x;
	try {
		return JSON.stringify(x);
	} catch {
		return String(x);
	}
}

/**
 * Run a harness `source` in a fresh deterministic context and resolve with its return value
 * (the workflow's final result). The body runs inside an async IIFE, so top-level `await` and a
 * final `return` work.
 *
 * @param {string} source raw `.cwf.mjs` text
 * @param {{ api: Record<string, unknown>, filename?: string, log?: (m: string) => void }} config
 *   `api` — the injected CWF globals (`agent`, `parallel`, `args`, `budget`, …); `log` — console sink.
 * @returns {Promise<unknown>}
 */
export async function runHarness(source, config) {
	const { api, filename = "workflow.cwf.mjs", log } = config;
	const sink = log || (() => {});
	/** @type {Record<string, unknown>} */
	const sandbox = {
		...deterministicGlobals(),
		...api,
		console: {
			log: (/** @type {unknown[]} */ ...a) => sink(a.map(fmt).join(" ")),
			info: (/** @type {unknown[]} */ ...a) => sink(a.map(fmt).join(" ")),
			warn: (/** @type {unknown[]} */ ...a) => sink(a.map(fmt).join(" ")),
			error: (/** @type {unknown[]} */ ...a) => sink(a.map(fmt).join(" ")),
			debug: (/** @type {unknown[]} */ ...a) => sink(a.map(fmt).join(" ")),
		},
	};
	const context = vm.createContext(sandbox, {
		name: "cwf-harness",
		codeGeneration: { strings: false, wasm: false },
	});

	let script;
	try {
		script = new vm.Script(`(async () => {\n${source}\n})()`, { filename, lineOffset: -1 });
	} catch (e) {
		throw new Error(rewriteCompileError(e));
	}
	return await script.runInContext(context);
}

/**
 * Turn a harness compile error into a clearer message, hinting at the "plain JavaScript only" rule
 * when the syntax looks like TypeScript.
 * @param {unknown} e
 * @returns {string}
 */
function rewriteCompileError(e) {
	const msg = e instanceof Error ? e.message : String(e);
	if (/Missing initializer in const|Unexpected token|Type annotation|interface|: \w+\s*[,)=]/.test(msg)) {
		return `workflow failed to parse — it must be plain JavaScript (.cwf.mjs), not TypeScript: ${msg}`;
	}
	return `workflow failed to parse: ${msg}`;
}
