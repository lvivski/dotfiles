/// <reference path="./workflow.d.ts" />
/**
 * @module standard.host
 *
 * Bundled standard host capability: generic read-only git + curated fs effects (and gated writes)
 * built on the `ctx` toolkit the runtime hands every sidecar. Reference it with `run_workflow({ host:
 * "standard" })`, or `export * from "./standard.host.mjs"` in a per-workflow sidecar and add your own
 * effects alongside.
 *
 * Every effect is `(input, ctx)` where `ctx` is an {@link EffectCtx} (ambient, from workflow.d.ts).
 * Each call is checkpointed by the runtime, so results must be plain JSON.
 */

/** `input`: `["diff","--name-status", range]` or `{ args: [...] }`. Read-only; returns stdout. @param {any} input @param {EffectCtx} ctx */
export const git = (input, ctx) => ctx.git(...(Array.isArray(input) ? input : input.args));

/** `input`: a path string or `{ path }`. @param {any} input @param {EffectCtx} ctx */
export const readText = (input, ctx) => ctx.files.readText(typeof input === "string" ? input : input.path);
/** @param {any} input @param {EffectCtx} ctx */
export const readJson = (input, ctx) => ctx.files.readJson(typeof input === "string" ? input : input.path);
/** @param {any} input @param {EffectCtx} ctx */
export const exists = (input, ctx) => ctx.files.exists(typeof input === "string" ? input : input.path);

/** `input`: a pattern string or `{ pattern, opts }`. @param {any} input @param {EffectCtx} ctx */
export const glob = (input, ctx) => ctx.files.glob(typeof input === "string" ? input : input.pattern, typeof input === "object" ? input.opts : undefined);

/** `input`: raw unified-diff text or `{ text }`. Pure transform → structured hunks. @param {any} input @param {EffectCtx} ctx */
export const parseDiff = (input, ctx) => ctx.parseDiff(typeof input === "string" ? input : input.text);

// ---- mutating effects (skipped under dry-run) -----------------------------
export const meta = { mutates: ["writeText", "writeJson"] };

/** `input`: `{ path, text }`. @param {{ path: string, text: string }} input @param {EffectCtx} ctx */
export const writeText = (input, ctx) => ctx.files.writeText(input.path, input.text);
/** `input`: `{ path, value, opts? }`. @param {{ path: string, value: unknown, opts?: any }} input @param {EffectCtx} ctx */
export const writeJson = (input, ctx) => ctx.files.writeJson(input.path, input.value, input.opts);
