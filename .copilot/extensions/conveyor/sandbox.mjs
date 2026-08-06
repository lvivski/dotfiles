/**
 * @module sandbox
 *
 * Executes a `.mjs` harness in a deterministic `node:vm` context.
 *
 * Resume replays a harness against its durable ledger, so a re-run must take the same path.
 * `Math.random`, `Date.now()` and argless `new Date()` therefore throw, and `eval` / `new Function`
 * / dynamic `import()` are disabled by the context options.
 *
 * A fresh vm context owns a full set of intrinsics, so none of the host realm's are injected and
 * the `Math`/`Date` replacements are applied to the context's own from inside it. Contexts are
 * per-run, so a stray `Object.prototype.foo = 1` cannot reach the extension or a later run.
 *
 * Not a security boundary: the injected API is made of host-realm objects, which harness code can
 * always follow back to the host. Guards here only need to catch accidents. Run untrusted harness
 * authors under an OS/agent-level sandbox (`copilot --cloud` / `/sandbox`).
 *
 * `new Intl.DateTimeFormat().format()` with no argument is still a clock; `format` is an accessor
 * that would need replacing per instance.
 */
import vm from "node:vm";

export const DEFAULT_SYNC_TIMEOUT_MS = 5000;

/**
 * Shared with the host realm so `e instanceof Error` holds for errors the runtime, host effects and
 * `onFailure: "raise"` throw into harness code — cross-realm `instanceof` is false.
 */
const sharedErrorGlobals = () => ({ Error, TypeError, RangeError, SyntaxError, EvalError, ReferenceError, URIError, AggregateError });

/** Deterministic web globals a bare vm context does not provide. */
const hostUtilityGlobals = () => ({ structuredClone, URL, URLSearchParams, TextEncoder, TextDecoder, queueMicrotask, atob, btoa });

/**
 * Replace the context's own `Math` and `Date` with variants that refuse randomness and the clock.
 * Serialized with `Function.prototype.toString` and evaluated inside the target context, so it must
 * stay self-contained: no closure references, no imports.
 */
function makeRealmDeterministic() {
	// Edits the vm context's realm, not this module's, so every lookup is dynamic.
	const realm = /** @type {Record<string, any>} */ (/** @type {unknown} */ (globalThis));

	const realMath = /** @type {Record<string, any>} */ (/** @type {unknown} */ (Math));
	/** @type {Record<string, unknown>} */
	const safeMath = {};
	for (const key of Object.getOwnPropertyNames(realMath)) if (key !== "random") safeMath[key] = realMath[key];
	realm.Math = Object.freeze(safeMath);

	realm.Date = new Proxy(Date, {
		apply() {
			throw new Error("conveyor: `Date()` is nondeterministic — use `new Date(timestamp)`");
		},
		construct(target, argsList, newTarget) {
			if (argsList.length === 0) throw new Error("conveyor: `new Date()` is nondeterministic — pass an explicit timestamp");
			return Reflect.construct(target, argsList, newTarget);
		},
		get(target, prop, receiver) {
			if (prop === "now")
				return () => {
					throw new Error("conveyor: `Date.now()` is nondeterministic — conveyors must be reproducible");
				};
			return Reflect.get(target, prop, receiver);
		},
	});
}

/**
 * Create a deterministic context exposing `globals` (the workflow API) and nothing of the host
 * realm's own intrinsics.
 * @param {Record<string, unknown>} globals
 * @param {string} name
 * @returns {object} the contextified sandbox
 */
export function createDeterministicContext(globals, name) {
	const context = vm.createContext(
		{ ...sharedErrorGlobals(), ...hostUtilityGlobals(), ...globals },
		{
			name,
			codeGeneration: { strings: false, wasm: false },
		},
	);
	vm.runInContext(`(${makeRealmDeterministic})`, context)();
	return context;
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
 * @param {string} source raw `.mjs` text
 * @param {{ api: Record<string, unknown>, filename?: string, log?: (m: string) => void, syncTimeoutMs?: number }} config
 *   `api` — the injected workflow globals (`agent`, `parallel`, `args`, `budget`, ...); `log` — console sink.
 * @returns {Promise<unknown>}
 */
export async function runHarness(source, config) {
	const { api, filename = "conveyor.mjs", log } = config;
	const syncTimeoutMs = Number.isFinite(config.syncTimeoutMs)
		? Math.max(1, Math.trunc(/** @type {number} */ (config.syncTimeoutMs)))
		: DEFAULT_SYNC_TIMEOUT_MS;
	const sink = log || (() => {});
	const writeConsole = (/** @type {unknown[]} */ ...a) => sink(a.map(fmt).join(" "));
	const context = createDeterministicContext(
		{
			...api,
			console: Object.fromEntries(["log", "info", "warn", "error", "debug"].map((name) => [name, writeConsole])),
		},
		"conveyor-harness",
	);

	let script;
	try {
		script = new vm.Script(`(async () => {\n${source}\n})()`, { filename, lineOffset: -1 });
	} catch (e) {
		throw new Error(rewriteCompileError(e));
	}
	// AbortSignal timers cannot fire while harness JavaScript blocks the event loop. Bound each
	// initial synchronous evaluation slice in the VM; normal async orchestration yields immediately.
	return await script.runInContext(context, { timeout: syncTimeoutMs });
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
		return `conveyor failed to parse — it must be plain JavaScript (.mjs), not TypeScript: ${msg}`;
	}
	return `conveyor failed to parse: ${msg}`;
}
