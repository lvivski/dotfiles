import { spawnSync } from "node:child_process";
import path from "node:path";
import { openDatabase } from "./database.mjs";
import { goalFiles, priorGoal, retainFeedback } from "./feedback.mjs";
import { awaitingReply, currentCheck } from "./reservation.mjs";
import { matchesPair } from "./partition.mjs";
import { commitAt, withProduct } from "./product.mjs";
import { deadlineAt, fail, mixed, ownership, text } from "./values.mjs";
import { interpret, interrupted } from "./verdict.mjs";
const [cwd, runId, effectId] = process.argv.slice(2);
const db = openDatabase(cwd);
try {
	const command = db.mutateLocked(runId, run => {
		const e = run.effects.find(e => e.id === effectId);
		if (!e || e.tool !== "bash" || !awaitingReply(e) || !currentCheck(run, e) || e.runnerStarted)
			fail("unissued_check", "Checks are exclusive to the current issued attempt");
		if (e.pair && (!matchesPair(run,e.pair,commitAt(cwd,run.policy.target)) || run.join || run.conflict || run.blocker || run.effects.some(x=>x.permissionHold)))
			fail("stale_assignment","Approved paired inputs are no longer current; no observation was made");
		const publish = db.outcomeWriter(runId, e);
		/** @type {Record<string,string>} */ const env = {};
		/** @type {import("./verdict.mjs").Evaluation} */ let evaluation;
		if (e.kind === "component" && e.grain) {
			evaluation = { kind: e.kind };
			env.FOUNDRY_GRAIN = e.grain;
			const scope = run.nodes[e.grain].grain.directory;
			const {directories,files}=ownership(scope);
			env.FOUNDRY_DIRECTORIES = JSON.stringify(directories);
			if (directories.length===1) env.FOUNDRY_DIRECTORY = directories[0];
			if (files.length) env.FOUNDRY_FILES=JSON.stringify(files);
		} else if (e.kind === "product") {
			const outputs = Object.keys(run.join?.outputs ?? {});
			evaluation = { kind: e.kind, outputs };
			env.FOUNDRY_OWNERSHIP = JSON.stringify(run.join?.ownership ?? Object.fromEntries(outputs.map(id => [id,ownership(run.nodes[id].grain.directory)])));
			env.FOUNDRY_OUTPUTS = JSON.stringify(Object.fromEntries(outputs.map(id => {
				const scope=run.nodes[id].grain.directory;
				return [id,mixed(scope) ? scope.primary : scope];
			})));
		} else if (e.kind === "goal") {
			evaluation = { kind: e.kind, squads: run.policy.squads.map(s => s.id) };
		} else fail("unissued_check", "Expected an evaluator");
		return { publish, evaluation, commit: text(e.commit, "check commit"), check: text(e.check, "assigned evaluator"), deadline: run.policy.deadline, env,
			prior: e.kind === "goal" ? priorGoal(run, e) : undefined,
			productEvaluatorRevision:e.productEvaluatorRevision,
			overlay: e.evaluatorRevision && (e.kind === "goal" || e.kind === "product") ? { base: run.policy.base, revision: e.evaluatorRevision } : undefined };
	});
	const pin = { commit: command.commit, check: command.check, ...(command.overlay ? { evaluatorRevision: command.overlay.revision } : {}),
		...(command.productEvaluatorRevision ? {productEvaluatorRevision:command.productEvaluatorRevision} : {}) };
	/** @type {import("./model.js").Receipt} */ let receipt = { ...pin, exit: null, output: "" };
	/** @type {ReturnType<typeof goalFiles>|undefined} */ let files;
	/** @type {Buffer|undefined} */ let goalStdout;
	try {
		const env = { ...process.env, ...command.env };
		if (!command.env.FOUNDRY_DIRECTORY) delete env.FOUNDRY_DIRECTORY;
		if (!command.env.FOUNDRY_DIRECTORIES) delete env.FOUNDRY_DIRECTORIES;
		for (const key of ["FOUNDRY_FILES","FOUNDRY_OUTPUTS","FOUNDRY_OWNERSHIP","FOUNDRY_GRAIN"])
			if (!Object.hasOwn(command.env,key)) delete env[key];
		delete env.FOUNDRY_GOAL_DELTA;
		delete env.FOUNDRY_GOAL_DELTA_FILE;
		delete env.FOUNDRY_GOAL_FEEDBACK_FILE;
		if (command.evaluation.kind === "goal") files = goalFiles(cwd, command.commit, command.prior, env);
		await withProduct(cwd, command.commit, root => {
			const evaluator = path.join(root, command.check);
			const remaining = command.deadline === undefined ? undefined : (deadlineAt(command.deadline) ?? -Infinity) - Date.now();
			if (remaining !== undefined && remaining <= 0)
				fail("deadline", "Deadline elapsed before evaluation");
			const js = /\.m?js$/.test(evaluator);
			const result = spawnSync(js ? process.execPath : evaluator, js ? [evaluator] : [], {
				cwd: root, env,
				timeout: remaining, maxBuffer: Infinity, stdio: ["ignore", "pipe", "pipe"]
			});
			const { fields, feedback } = interpret(command.evaluation, result);
			receipt = { ...pin, ...fields };
			goalStdout = feedback;
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
		receipt = { ...pin, ...interrupted(command.evaluation, receipt.exit, error) };
	}
	finally { files?.close(); }
	if (command.deadline !== undefined) receipt.completedAt=Date.now();
	command.publish(receipt);
	process.stdout.write(`Foundry evaluated ${receipt.commit}: ${receipt.exit ?? "blocked"}\n`);
}
finally {
	db.close();
}
