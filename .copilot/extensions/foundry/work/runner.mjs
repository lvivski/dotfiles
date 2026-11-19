import { spawnSync } from "node:child_process";
import path from "node:path";
import { openDatabase } from "./database.mjs";
import { current } from "./native.mjs";
import { withProduct } from "./product.mjs";
import { fail, text } from "./values.mjs";
const [cwd, runId, effectId] = process.argv.slice(2);
const db = openDatabase(cwd);
try {
	const command = db.update(runId, run => {
		const e = run.effects.find(e => e.id === effectId);
		if (!e || e.tool !== "bash" || !["issued", "uncertain"].includes(e.state) || !current(run, e) || e.runnerStarted)
			fail("unissued_check", "Checks are exclusive to the current issued attempt");
		e.runnerStarted = true;
		return { commit: text(e.commit, "check commit"), check: text(e.check, "assigned evaluator"),
			deadline: run.policy.deadline, grains: run.policy.grains.map(g => g.id) };
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
				cwd: root, env: process.env, encoding: "utf8",
				timeout: remaining, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"]
			});
			receipt.exit = result.error || result.signal ? null : result.status;
			receipt.output = [result.stdout, result.stderr, result.error?.message, result.signal].filter(Boolean).join("\n").slice(-8192);
			const repairs = [...String(result.stdout ?? "").matchAll(/^FOUNDRY_REPAIR=([A-Za-z0-9._-]+)$/gm)];
			if (repairs.length === 1 && command.grains.includes(repairs[0][1]) && receipt.exit !== null && receipt.exit !== 0)
				receipt.repair = repairs[0][1];
		});
	}
	catch (error) {
		receipt.exit = null;
		receipt.output = error instanceof Error ? error.message : String(error);
		delete receipt.repair;
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
