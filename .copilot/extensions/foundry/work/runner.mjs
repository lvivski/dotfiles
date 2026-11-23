import { spawnSync } from "node:child_process";
import path from "node:path";
import { openDatabase } from "./database.mjs";
import { goalFiles, priorGoal, retainFeedback } from "./feedback.mjs";
import { awaitingReply, current } from "./native.mjs";
import { withProduct } from "./product.mjs";
import { FoundryError, fail, text } from "./values.mjs";
const [cwd, runId, effectId] = process.argv.slice(2);
const db = openDatabase(cwd);
try {
	const command = db.update(runId, run => {
		const e = run.effects.find(e => e.id === effectId);
		if (!e || e.tool !== "bash" || !awaitingReply(e) || !current(run, e) || e.runnerStarted)
			fail("unissued_check", "Checks are exclusive to the current issued attempt");
		e.runnerStarted = true;
		const outputs = e.kind === "product" && run.join ? Object.keys(run.join.outputs) : [];
		/** @type {Record<string,string>} */ const env = {};
		if (e.grain) {
			env.FOUNDRY_GRAIN = e.grain;
			env.FOUNDRY_DIRECTORY = run.nodes[e.grain].grain.directory;
		} else if (e.kind === "product") {
			env.FOUNDRY_OUTPUTS = JSON.stringify(Object.fromEntries(outputs.map(id => [id, run.nodes[id].grain.directory])));
		}
		const squads = e.kind === "goal" ? run.policy.squads.map(s => s.id) : [];
		return { component: e.kind === "component", commit: text(e.commit, "check commit"), check: text(e.check, "assigned evaluator"), deadline: run.policy.deadline, outputs, squads, env,
			goal: e.kind === "goal", prior: e.kind === "goal" ? priorGoal(run, e) : undefined,
			overlay: e.evaluatorRevision && e.kind === "goal" ? { base: run.policy.base, revision: e.evaluatorRevision } : undefined };
	});
	/** @type {import("./model.js").Receipt} */
	const receipt = { commit: command.commit, check: command.check, ...(command.overlay ? { evaluatorRevision: command.overlay.revision } : {}), exit: null, output: "" };
	/** @type {ReturnType<typeof goalFiles>|undefined} */ let files;
	/** @type {Buffer|undefined} */ let goalStdout;
	try {
		const env = { ...process.env, ...command.env };
		delete env.FOUNDRY_GOAL_DELTA;
		delete env.FOUNDRY_GOAL_DELTA_FILE;
		delete env.FOUNDRY_GOAL_FEEDBACK_FILE;
		if (command.goal) files = goalFiles(cwd, command.commit, command.prior, env);
		await withProduct(cwd, command.commit, root => {
			const evaluator = path.join(root, command.check);
			const remaining = command.deadline === undefined ? undefined : Date.parse(command.deadline) - Date.now();
			if (remaining !== undefined && remaining <= 0)
				fail("deadline", "Deadline elapsed before evaluation");
			const js = /\.m?js$/.test(evaluator);
			const result = spawnSync(js ? process.execPath : evaluator, js ? [evaluator] : [], {
				cwd: root, env,
				timeout: remaining, maxBuffer: Infinity, stdio: ["ignore", "pipe", "pipe"]
			});
			receipt.exit = result.error || result.signal ? null : result.status;
			receipt.output = [result.stdout, result.stderr, result.error?.message, result.signal].filter(Boolean).join("\n");
			if (command.goal && (receipt.exit === 0 || receipt.exit === 1)) goalStdout = result.stdout;
			const repairs = [...String(result.stdout ?? "").matchAll(/^FOUNDRY_REPAIR=([A-Za-z0-9._-]+)$/gm)];
			if (repairs.length === 1 && command.outputs.includes(repairs[0][1]) && receipt.exit !== null && receipt.exit !== 0)
				receipt.repair = repairs[0][1];
			if (receipt.exit === 1 && command.squads.length) {
				const hints = [...String(result.stdout ?? "").matchAll(/^FOUNDRY_SQUAD=([^\r\n]*)$/gm)];
				if (hints.length === 1 && command.squads.includes(hints[0][1])) receipt.squad = hints[0][1];
			}
		}, command.overlay);
		if (goalStdout && files) {
			try {
				const value = files.collect(goalStdout);
				if (value) receipt.feedbackFile = retainFeedback(cwd, value);
			} catch (error) {
				receipt.output += `\nFoundry scheduling feedback unavailable: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
	}
	catch (error) {
		// Only a completed evaluator followed by the export verifier can attest a mutation.
		// A signal/launch error stays incomplete even when it also left files behind.
		if (command.component && receipt.exit !== null && error instanceof FoundryError &&
			["product_changed", "unsupported_tree", "invalid_path"].includes(error.code)) receipt.failure = "changed-export";
		receipt.exit = null;
		receipt.output = error instanceof Error ? error.message : String(error);
		delete receipt.repair;
		delete receipt.squad;
	}
	finally { files?.close(); }
	if (command.component && receipt.exit === null) receipt.failure ??= "incomplete";
	db.update(runId, run => {
		const e = run.effects.find(e => e.id === effectId);
		if (!e?.runnerStarted || e.receipt)
			fail("stale_check", "This evaluation already has a receipt or lost its issuance");
		e.receipt = receipt;
		if (e.state !== "refused") {
			e.state = "done";
			delete e.error;
		}
	});
	process.stdout.write(`Foundry evaluated ${receipt.commit}: ${receipt.exit ?? "blocked"}\n`);
}
finally {
	db.close();
}
