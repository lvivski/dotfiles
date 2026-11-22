import { spawnSync } from "node:child_process";
import path from "node:path";
import { openDatabase } from "./database.mjs";
import { awaitingReply, current } from "./native.mjs";
import { withProduct } from "./product.mjs";
import { fail, text } from "./values.mjs";
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
		return { commit: text(e.commit, "check commit"), check: text(e.check, "assigned evaluator"), deadline: run.policy.deadline, outputs, squads, env };
	});
	/** @type {import("./model.js").Receipt} */
	const receipt = { commit: command.commit, check: command.check, exit: null, output: "" };
	try {
		await withProduct(cwd, command.commit, root => {
			const evaluator = path.join(root, command.check);
			const remaining = command.deadline === undefined ? undefined : Date.parse(command.deadline) - Date.now();
			if (remaining !== undefined && remaining <= 0)
				fail("deadline", "Deadline elapsed before evaluation");
			const js = /\.m?js$/.test(evaluator);
			const result = spawnSync(js ? process.execPath : evaluator, js ? [evaluator] : [], {
				cwd: root, env: { ...process.env, ...command.env }, encoding: "utf8",
				timeout: remaining, maxBuffer: Infinity, stdio: ["ignore", "pipe", "pipe"]
			});
			receipt.exit = result.error || result.signal ? null : result.status;
			receipt.output = [result.stdout, result.stderr, result.error?.message, result.signal].filter(Boolean).join("\n");
			const repairs = [...String(result.stdout ?? "").matchAll(/^FOUNDRY_REPAIR=([A-Za-z0-9._-]+)$/gm)];
			if (repairs.length === 1 && command.outputs.includes(repairs[0][1]) && receipt.exit !== null && receipt.exit !== 0)
				receipt.repair = repairs[0][1];
			if (receipt.exit === 1 && command.squads.length) {
				const hints = [...String(result.stdout ?? "").matchAll(/^FOUNDRY_SQUAD=([^\r\n]*)$/gm)];
				if (hints.length === 1 && command.squads.includes(hints[0][1])) receipt.squad = hints[0][1];
			}
		});
	}
	catch (error) {
		receipt.exit = null;
		receipt.output = error instanceof Error ? error.message : String(error);
		delete receipt.repair;
		delete receipt.squad;
	}
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
