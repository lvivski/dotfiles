import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as Landing from "./landing.mjs";
import * as Tasks from "./tasks.mjs";
import { openDatabase } from "./database.mjs";
import { FoundryError, digest, json, record } from "./values.mjs";
import { captureCandidate, readCandidate, verifyCandidate } from "./artifacts.mjs";
import { checkReceiptPath } from "./native.mjs";
import { materializeProduct, verifyProduct } from "./promotion.mjs";

/** @param {string | Uint8Array} value */
const sha256 = value => createHash("sha256").update(value).digest("hex");

const [directory, attemptId, checkId, effectId] = process.argv.slice(2);
if (!directory || !attemptId || !checkId || !effectId) throw new Error("Usage: runner.mjs WORKING_DIRECTORY ATTEMPT_ID CHECK_ID EFFECT_ID");
const store = openDatabase(directory);
try {
	const attempt = store.get("attempts", attemptId);
	const task = store.get("tasks", attempt.taskId);
	const goal = store.get("goals", task.goalId);
	const check = attempt.checks.find(item => item.id === checkId);
	if (!check || !check.command) throw new FoundryError("invalid_check", "Expected the assigned executable check procedure");
	const effect = store.get("effects", effectId);
	const reference = checkReceiptPath(store, effectId);
	if (effect.attemptId !== attemptId || effect.kind !== "command" || !["issued", "uncertain"].includes(effect.state)
		|| typeof effect.request !== "object" || effect.request === null || Array.isArray(effect.request)
		|| effect.request.receipt !== reference || effect.request.checkId !== checkId || effect.request.checkVersion !== check.version) {
		throw new FoundryError("unissued_check", "Runner requires its own issued, receipt-bound command");
	}
	const evidenceDirectory = path.dirname(reference);
	mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
	const metadata = lstatSync(evidenceDirectory);
	if (!metadata.isDirectory() || metadata.isSymbolicLink()
		|| path.dirname(realpathSync(evidenceDirectory)) !== realpathSync(path.dirname(store.databasePath))) {
		throw new FoundryError("unsafe_evidence_path", "Evidence must remain in the repository's Foundry directory");
	}
	writeFileSync(reference, JSON.stringify({ state: "started", effectId, attemptId, checkId }), { flag: "wx", mode: 0o600 });
	const inputOutputs = attempt.inputs.map(input => ({ taskId: input.taskId, output: store.read(Tasks.outputForInput, input) }));
	const raw = {
		effectId, attemptId, checkId, checkVersion: check.version, command: check.command,
		inputs: attempt.inputs,
		inputOutputs,
		startedAt: new Date().toISOString(), completedAt: "",
		/** @type {number | null} */ exitCode: null,
		/** @type {string | null} */ signal: null,
		/** @type {string | null} */ error: null,
		stdout: "", stderr: "",
		/** @type {import("./model.d.ts").Candidate|undefined} */ candidate: undefined,
		/** @type {{manifestId:string,tree:string}|undefined} */ product: undefined,
		...(check.oracleCommit ? { oracleCommit: check.oracleCommit } : {}),
		/** @type {"input-artifact"|"oracle-input"|null} */ blocker: null,
	};
	const verifyOracles = (root = directory) => {
		for (const file of check.oracleFiles ?? []) {
			const filename = realpathSync(path.resolve(root, file.path));
			const relative = path.relative(realpathSync(root), filename);
			if (relative.startsWith("..") || path.isAbsolute(relative) || sha256(readFileSync(filename)) !== file.sha256) {
				throw new FoundryError("oracle_changed", `Assigned evaluator changed or escaped the candidate: ${file.path}`);
			}
		}
	};
	try {
		if (task.currentAttemptId !== attempt.id || task.version !== attempt.taskVersion
			|| task.state !== "running" || attempt.state !== "running") {
			throw new FoundryError("attempt_not_current", "This check belongs to a superseded or cancelled attempt");
		}
		if (!check.oracleCommit) verifyOracles();
		if (inputOutputs.some(input => input.output === undefined)) throw new FoundryError("inputs_unavailable", "An assigned versioned input is no longer available");
		const verifyInputs = () => {
			for (const input of inputOutputs) if (input.output) {
				try { readCandidate(input.output.reference, input.output.version, store.databasePath); }
				catch (error) { raw.blocker = "input-artifact"; throw error; }
			}
		};
		verifyInputs();
		raw.product = store.write(Landing.productCheckPlan, attempt.id);
		const productRoot = raw.product ? materializeProduct(store.databasePath, raw.product.tree) : undefined;
		// Product qualification must find the pinned bytes in the actual joined tree, never in an overlay.
		if (check.artifactFiles) raw.candidate = captureCandidate(productRoot ?? directory, check.artifactFiles, check.oracleFiles ?? [], task.scope.paths, store.databasePath, productRoot ? undefined : check.oracleCommit);
		const candidateDirectory = productRoot ?? raw.candidate?.reference ?? directory;
		verifyOracles(candidateDirectory);
		const remaining = goal.limits.deadline === undefined ? undefined : Date.parse(goal.limits.deadline) - Date.now();
		if (remaining !== undefined && remaining <= 0) throw new FoundryError("deadline_exhausted", "The assigned goal deadline has elapsed");
		const result = spawnSync("/bin/sh", ["-c", check.command], {
			cwd: candidateDirectory, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
			env: { ...process.env, FOUNDRY_ATTEMPT_ID: attempt.id, FOUNDRY_TASK_ID: task.id,
				FOUNDRY_INPUTS_JSON: JSON.stringify(inputOutputs),
				...(raw.candidate ? { FOUNDRY_CANDIDATE_DIR: candidateDirectory } : {}) },
			...(remaining === undefined ? {} : { timeout: remaining }),
		});
		raw.exitCode = result.status;
		raw.signal = result.signal;
		raw.error = result.error?.message ?? null;
		raw.stdout = result.stdout ?? "";
		raw.stderr = result.stderr ?? "";
		if (!check.oracleCommit) verifyOracles();
		verifyOracles(candidateDirectory);
		verifyInputs();
		if (raw.candidate) verifyCandidate(raw.candidate, store.databasePath);
		if (raw.product && productRoot) verifyProduct(store.databasePath, raw.product.tree, productRoot);
	} catch (error) {
		if (error instanceof FoundryError && error.code === "oracle_input") raw.blocker = "oracle-input";
		raw.error = error instanceof Error ? error.message : String(error);
	}
	raw.completedAt = new Date().toISOString();
	const captured = record(/** @type {unknown} */ (JSON.parse(JSON.stringify(raw))));
	const content = JSON.stringify({ ...captured, state: "finished", sha256: digest(json(captured)) });
	const temporary = `${reference}.${randomUUID()}.tmp`;
	const descriptor = openSync(temporary, "wx", 0o600);
	try {
		writeFileSync(descriptor, content);
		renameSync(temporary, reference);
	} finally {
		closeSync(descriptor);
		if (existsSync(temporary)) unlinkSync(temporary);
	}
	const observation = {
		effectId, attemptId, checkId, checkVersion: check.version,
		outcome: raw.exitCode === 0 && raw.error === null ? "passed" : "failed",
		reference, sha256: sha256(content), completedAt: raw.completedAt,
		summary: raw.error ?? `Assigned command exited ${raw.exitCode ?? raw.signal}`,
	};
	process.stdout.write(`FOUNDRY_CHECK_RESULT:${Buffer.from(JSON.stringify(observation)).toString("base64")}\n`);
} finally {
	store.close();
}
