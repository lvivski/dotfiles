/**
 * @module effects
 *
 * Host effects: the scalable boundary for deterministic (and impure-but-recorded) host work. A
 * workflow brings its own effect code in a **sidecar** (`<name>.host.mjs` or `run_conveyor({ host })`)
 * that the runtime imports in the **host realm** (full Node — `fs`, `child_process`, any npm). The
 * harness calls those effects through a single injected `host.<name>(input)` namespace; each call is
 * recorded by `(name, input)` in the same ledger agents use, so on resume it replays instead of
 * re-running. This keeps the harness a pure function of `(args, agent results, effect results)` while
 * letting each workflow define exactly the host operations it needs — the core interface never grows.
 *
 * This module owns only the pure glue (loading, canonical keying, the injected proxy). The
 * recording + execution live on the Runtime (`#effect`), and the per-workflow logic lives in the
 * sidecar. Pure Node built-ins only, so it stays unit-testable under plain `node --test`.
 */
import { statSync } from "node:fs";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { hostEntry, verifyHostSnapshot } from "./snapshot.mjs";

/**
 * The context every sidecar effect receives as its 2nd arg. Deliberately minimal: the run's cwd/mode,
 * an AbortSignal, and a log sink. Sidecars implement any host I/O they need with raw Node — the
 * framework intentionally provides no git/fs/parse toolkit.
 * @typedef {object} EffectCtx
 * @property {string} cwd
 * @property {boolean} dryRun
 * @property {boolean} restricted
 * @property {AbortSignal} signal
 * @property {(m: unknown) => void} log
 */

/** Sibling sidecar path for a harness file: `foo.mjs` → `foo.host.mjs`. @param {string} harnessPath */
export function sidecarPathFor(harnessPath) {
	return harnessPath.replace(/\.mjs$/, ".host.mjs");
}

/** @typedef {{ fns: Map<string, Function>, mutates: Set<string>, names: string[], hash: string }} LoadedHost */

/**
 * Import a sidecar in the host realm and collect its exported effect functions. An effect is a named
 * function export; it is "mutating" if listed in `export const meta = { mutates: [...] }` or tagged
 * `fn.mutates = true` (prefer the tag — it survives `export * from` composition). A `default` export
 * object of functions is also accepted.
 *
 * NOTE: only the top-level sidecar file is mtime-busted; modules it statically imports/re-exports
 * stay in Node's cache. Editing an imported helper mid-process needs a touch of the sidecar itself
 * (or an extension reload).
 * @param {string} path @returns {Promise<LoadedHost>}
 */
export async function loadHost(path) {
	if (statSync(path).isDirectory()) path = verifyHostSnapshot(path).entry;
	else path = hostEntry(path);
	// Cache-bust by mtime so an edited sidecar is picked up across runs in a long-lived process.
	let v = "";
	try {
		v = `?v=${statSync(path).mtimeMs}`;
	} catch {
		// let import() surface a clear module-not-found error below
	}
	const mod = await import(pathToFileURL(path).href + v);
	/** @type {Map<string, Function>} */
	const fns = new Map();
	/** @type {Set<string>} */
	const mutates = new Set();
	for (const name of Array.isArray(mod.meta?.mutates) ? mod.meta.mutates : []) mutates.add(String(name));
	const add = (/** @type {string} */ k, /** @type {any} */ val) => {
		if (typeof val !== "function") return;
		fns.set(k, val);
		if (val.mutates === true) mutates.add(k);
	};
	for (const [k, val] of Object.entries(mod)) {
		if (k === "meta" || k === "default") continue;
		add(k, val);
	}
	if (mod.default && typeof mod.default === "object") for (const [k, val] of Object.entries(mod.default)) if (!fns.has(k)) add(k, val);
	if (!fns.size) throw new Error(`host sidecar ${path} exports no effect functions`);
	const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
	return { fns, mutates, names: [...fns.keys()], hash };
}

/**
 * Build the `host` namespace injected into the harness. Restricted mode and a missing sidecar both
 * yield a proxy that throws a clear message *when an effect is called* (bare property access stays
 * safe so feature-detection doesn't crash).
 * @param {{ names?: string[], invoke?: (name: string, input: unknown, opts?: any) => Promise<unknown>, restricted?: boolean, hasSidecar?: boolean }} cfg
 * @returns {Record<string, (input?: unknown, opts?: any) => Promise<unknown>>}
 */
export function buildHostProxy({ names = [], invoke = async () => {}, restricted = false, hasSidecar = false }) {
	const thrower = (/** @type {string} */ msg) =>
		/** @type {any} */ (
			new Proxy(Object.create(null), {
				get(_t, prop) {
					if (typeof prop === "symbol" || prop === "then") return undefined;
					return () => {
						throw new Error(`${msg} (host.${String(prop)})`);
					};
				},
			})
		);
	if (restricted) return thrower("conveyor: host.* effects are forbidden in restricted mode");
	if (!hasSidecar) return thrower("conveyor: no host sidecar loaded — add <name>.host.mjs beside the harness or pass run_conveyor({ host }), and declare the effect there");
	const known = new Set(names);
	return /** @type {any} */ (
		new Proxy(Object.create(null), {
			get(_t, prop) {
				if (typeof prop === "symbol" || prop === "then") return undefined;
				const name = String(prop);
				if (!known.has(name)) {
					return () => {
						throw new Error(`conveyor: no host effect '${name}' — the sidecar declares: ${names.join(", ") || "(none)"}`);
					};
				}
				return (/** @type {unknown} */ input, /** @type {any} */ opts) => invoke(name, input, opts);
			},
		})
	);
}
