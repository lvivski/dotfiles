// Ambient types for host-effect sidecars (`*.host.mjs`) in this directory. Because this dir isn't a
// type-checked project (the harnesses here use intentionally-undefined injected globals), sidecars
// reference these with NO import — add `/// <reference path="./workflow.d.ts" />` at the top of a
// sidecar (or rely on the editor's inferred project) and annotate `ctx` with `EffectCtx`.
//
// Source of truth is `EffectCtx` in ../extensions/workflow/effects.mjs (enforced by the engine's
// jsconfig); keep this mirror in sync when the ctx toolkit changes.

type EffectFiles = {
	readText(path: string): Promise<string>;
	readJson(path: string): Promise<any>;
	exists(path: string): Promise<boolean>;
	glob(pattern: string, opts?: { cwd?: string; dot?: boolean; ignore?: string[] }): Promise<string[]>;
	writeText(path: string, text: string): Promise<void>;
	writeJson(path: string, value: unknown, opts?: { indent?: number; sort?: boolean }): Promise<void>;
};

type EffectPath = {
	basename(p: string): string;
	dirname(p: string): string;
	join(...parts: string[]): string;
	relative(from: string, to: string): string;
	extname(p: string): string;
	sep: string;
};

/** The context every host-effect `(input, ctx)` receives: run cwd/mode + the host-realm toolkit. */
type EffectCtx = {
	cwd: string;
	dryRun: boolean;
	restricted: boolean;
	log(message: unknown): void;
	/** Read-only git; returns stdout, rejects on mutation or non-zero exit. */
	git(...args: string[]): Promise<string>;
	files: EffectFiles;
	parseDiff(text: string): any;
	path: EffectPath;
};
