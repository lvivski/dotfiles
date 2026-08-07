/** @module source — Conveyor source discovery and literal metadata parsing. */
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import vm from "node:vm";

import { resolveConveyorDefinition } from "./registry.mjs";
import { createDeterministicContext } from "./sandbox.mjs";
import { assertJson, normalizeLimits } from "./schema.mjs";

const USER_CONVEYORS = join(homedir(), ".copilot", "conveyors");

/** Remove ESM export keywords while preserving source positions. @param {string} source */
export function stripExports(source) {
	return source
		.replace(
			/^([ \t]*)export(\s+)default(\s+)(?=\S)/gm,
			(_match, indent, firstGap, secondGap) => `${indent}      ${firstGap}       ${secondGap}`,
		)
		.replace(
			/^([ \t]*)export(\s+)(?=(?:const|let|var|function|class|async)\b)/gm,
			(_match, indent, gap) => `${indent}      ${gap}`,
		);
}

/**
 * Extract the literal `meta` declaration without executing the harness body.
 * @param {string} source
 * @returns {{ name?: string, description?: string, limits: Record<string, number> }}
 */
export function extractMeta(source) {
	const match = /(?:^|\n)\s*(?:export\s+)?const\s+meta\s*=\s*\{/.exec(source);
	if (!match) return { limits: {} };
	const open = source.indexOf("{", match.index);
	const end = objectLiteralEnd(source, open);
	if (end < 0) throw new TypeError("meta must be a literal object");
	let value;
	try {
		const context = createDeterministicContext({}, "conveyor-meta");
		value = new vm.Script(`(${source.slice(open, end + 1)})`).runInContext(context, {
			timeout: 200,
		});
	} catch (error) {
		throw new TypeError(`meta must be a plain literal object: ${error instanceof Error ? error.message : error}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("meta must be an object");
	}
	for (const key of Object.keys(value)) {
		if (!["name", "description", "limits"].includes(key)) {
			throw new TypeError(`unknown Conveyor metadata field '${key}'`);
		}
	}
	return assertJson({
		...(typeof value.name === "string" && value.name.trim() ? { name: value.name.trim() } : {}),
		...(typeof value.description === "string" && value.description.trim()
			? { description: value.description.trim() }
			: {}),
		limits: normalizeLimits(value.limits),
	}, { label: "Conveyor metadata" });
}

/**
 * Resolve exactly one inline, path, or named Conveyor source.
 * @param {{ script?: unknown, scriptPath?: unknown, name?: unknown }} input
 * @param {{ cwd: string, userDir?: string }} options
 */
export function resolveSource(input, { cwd, userDir = USER_CONVEYORS }) {
	const selected = ["script", "scriptPath", "name"].filter((key) => input?.[key] != null);
	if (selected.length !== 1) {
		throw new TypeError(`provide exactly one of script, scriptPath, or name (got ${selected.join(", ") || "none"})`);
	}
	if (selected[0] === "script") {
		if (typeof input.script !== "string" || !input.script.trim()) {
			throw new TypeError("script must be a non-empty string");
		}
		return withMeta(input.script, "inline-conveyor.mjs");
	}

	let path;
	if (selected[0] === "scriptPath") {
		if (typeof input.scriptPath !== "string" || !input.scriptPath.trim()) {
			throw new TypeError("scriptPath must be a non-empty string");
		}
		path = isAbsolute(input.scriptPath) ? input.scriptPath : resolve(cwd, input.scriptPath);
	} else {
		if (typeof input.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.name)) {
			throw new TypeError("name must contain only letters, numbers, dots, underscores, and hyphens");
		}
		const found = resolveConveyorDefinition(input.name, { cwd, userDir });
		if (!found) throw new TypeError(`no Conveyor named '${input.name}' was found`);
		path = found.path;
	}

	const actual = realpathSync(path);
	if (!lstatSync(actual).isFile() || extname(actual) !== ".mjs") {
		throw new TypeError(`Conveyor source must be a regular .mjs file: ${path}`);
	}
	const resolved = withMeta(readFileSync(actual, "utf8"), actual);
	if (selected[0] === "name" && resolved.meta.name && resolved.meta.name !== input.name) {
		throw new TypeError(`Conveyor '${input.name}' declares the different name '${resolved.meta.name}'`);
	}
	return resolved;
}

/** @param {string} source @param {string} filename */
function withMeta(source, filename) {
	const meta = extractMeta(source);
	return {
		source,
		filename,
		name: meta.name || basename(filename, ".mjs"),
		meta,
	};
}

/** @param {string} source @param {number} open */
function objectLiteralEnd(source, open) {
	let depth = 0;
	let state = "code";
	for (let index = open; index < source.length; index++) {
		const char = source[index];
		const next = source[index + 1];
		if (state === "code") {
			if (char === "/" && next === "/") {
				index++;
				state = "line";
			} else if (char === "/" && next === "*") {
				index++;
				state = "block";
			} else if (char === "'" || char === '"' || char === "`") {
				state = char;
			} else if (char === "{") {
				depth++;
			} else if (char === "}" && --depth === 0) {
				return index;
			}
		} else if (state === "line") {
			if (char === "\n") state = "code";
		} else if (state === "block") {
			if (char === "*" && next === "/") {
				index++;
				state = "code";
			}
		} else if (char === "\\") {
			index++;
		} else if (char === state) {
			state = "code";
		}
	}
	return -1;
}
