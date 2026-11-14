import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fail } from "../factory/fields.mjs";
import { visualReport } from "../factory/visual.mjs";
import { resolveEvaluatorBundle } from "./bundles.mjs";

/** Container/header and byte-identity checks are not a decoder or proof of a screenshot claim.
 * @param {Buffer} bytes @param {boolean} reference */
function image(bytes, reference) {
	const png = bytes.length > 32 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
		&& bytes.toString("ascii", 12, 16) === "IHDR";
	const jpeg = bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
	const webp = bytes.length > 16 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
	const svg = reference && /^(?:<\?xml[^>]*>\s*)?<svg[\s>]/.test(bytes.toString("utf8").trim());
	if (!png && !jpeg && !webp && !svg) fail("factory_visual_artifact", "Visual evidence requires image material, not code, geometry, controls or a Git LFS pointer");
}

/** @param {string} repository @param {import("../types/factory.js").EvaluationDefinition} definition */
export function checkVisualReferences(repository, definition) {
	if (!definition.visual) return;
	const bundle = resolveEvaluatorBundle(repository, definition.procedure.bundle);
	for (const state of definition.visual.states) {
		const file = bundle.files.find((entry) => entry.path === state.reference.path);
		if (!file) fail("factory_visual_artifact", "Every renderable reference must be preserved inside the protected evaluator bundle/support");
		const bytes = Buffer.from(file.content, "base64");
		image(bytes, true);
		if (createHash("sha256").update(bytes).digest("hex") !== state.reference.digest) fail("factory_visual_mismatch", "Reference bytes differ from the declared identity");
	}
}

/** @param {string} repository @param {import("../types/factory.js").EvaluationDefinition} definition
 * @param {string} report @param {string} commit @param {string} outcome */
export function checkVisualReport(repository, definition, report, commit, outcome) {
	const states = visualReport(definition, report, commit, outcome);
	if (!states) return;
	checkVisualReferences(repository, definition);
	for (const state of states) {
		if (!state.capture) continue;
		const capture = state.capture;
		let bytes;
		try {
			if (!path.isAbsolute(capture.path) || realpathSync(capture.path) !== path.normalize(capture.path)) throw new Error("Capture must be an absolute regular non-linked artifact");
			const stat = lstatSync(capture.path);
			if (!stat.isFile()) throw new Error("Capture is not a regular image");
			bytes = readFileSync(capture.path);
		} catch (error) {
			fail("factory_visual_artifact", "Visual capture is missing, linked or inaccessible; retain the blocker, never substitute code-only evidence", { cause: error instanceof Error ? error.message : String(error) });
		}
		image(bytes, false);
		if (createHash("sha256").update(bytes).digest("hex") !== capture.digest) fail("factory_visual_mismatch", "Output capture bytes differ from their report binding");
	}
}
