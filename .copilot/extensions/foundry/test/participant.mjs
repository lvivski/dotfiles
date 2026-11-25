import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../work/database.mjs";
import { assignment } from "../work/native.mjs";
import { createRuntime } from "../work/runtime.mjs";
import { nativeHost, pinnedFiles, put, workflowHost } from "./fixture.mjs";

/** @typedef {{id:string,directory:string,squad:string,needs:string[]}} Part */
/** @typedef {{direction:string,check:string,parts:Part[]}} Projections */
/** Apply scripted workflow results where their batch was actually dispatched (owner or writer).
 * Only the script and the pinned Git tree inform each report; no scout process or checkout.
 * @param {string} root @param {Pick<ReturnType<typeof workflowHost>,"scouts"|"settle">} discovery @param {Projections} plan */
export async function reportProjections(root, discovery, plan) {
	const parts = new Map(plan.parts.map(p => [p.id, p]));
	await discovery.settle();
	for (const review of discovery.scouts) {
		const files = pinnedFiles(root, review.base);
		/** @param {string} id */
		const present = id => files.has(`${parts.get(id)?.directory ?? assert.fail(id)}/index.mjs`);
		const own = plan.parts.filter(p => p.squad === review.squad);
		const batch = own.filter(p => !present(p.id) && p.needs.every(present));
		// A district can propose its section together with its own views in the same report.
		const section = own.find(p => p.id.startsWith("section-"));
		if (section && !present(section.id) && !batch.includes(section) && section.needs.every(id => present(id) || batch.some(p => p.id === id))) batch.push(section);
		const grains = batch.map(p => ({ id: p.id, directory: p.directory, needs: p.needs, task: `Implement ${p.id}: ${plan.direction}`, check: plan.check }));
		await review.report({ grains, outcome: grains.length ? "regenerate" : "no-gap",
			reason: "Implement the next incomplete projection on this checked tree", evidence: [`.foundry/${review.squad}.md`] });
	}
	return discovery.scouts.map(({ id, base }) => ({ id, base }));
}

/** @param {string} root @param {string} run @param {string} actor @param {string} grain
 * @param {string} submitted @param {{nodes:{grain:string,state:string,token?:string}[]}} reply */
export function inlineDelivery(root, run, actor, grain, submitted, reply) {
	const own = reply.nodes.find(n => n.grain === grain);
	if (own?.state !== "writing" || !own.token || own.token === submitted) return;
	// A peer's native send can race the return of the submitting writer's status snapshot.
	const db = openDatabase(root);
	try {
		const effects = db.read(run)?.effects;
		assert.ok(effects);
		if (effects.some(e => e.kind === "component" && e.grain === grain && e.issuer === actor && e.inlineRepair === own.token))
			return { worker: actor, token: own.token };
		assert.ok(effects.some(e => e.kind === "repair" && e.grain === grain && e.token === own.token), "repair has no delivery record");
	} finally { db.close(); }
}

// Each subprocess is a delivered writer turn in its actual assigned worktree.
if (fileURLToPath(import.meta.url) === process.argv[1]) {
	const [root, run, actor, token, payload, gate, withhold, plan] = process.argv.slice(2);
	const host = nativeHost(root, token), discovery = workflowHost();
	/** @type {string[]} */ const lost = [];
	/** @type {ReturnType<typeof createRuntime>} */
	const runtime = createRuntime(process.cwd(), {
		mode: async () => "interactive", permissionBlocker: async () => null,
		scout: (id, dispatch, issuer) => discovery.launch(runtime, id, dispatch, issuer),
		execute: async (tool, args, id) => {
			if (withhold && tool === "bash" && String(args.description).startsWith(`Check ${withhold} at `)) {
				lost.push(String(args.shellId));
				return { resultType: "success" }; // Shell reply, but no runner and no durable verdict.
			}
			return host.execute(tool, args, id);
		},
		notify: async message => {
			const job = assignment(message); assert.ok(job); assert.equal(job.run, run);
			host.inbox.push({ worker: actor, token: job.token }); return job.token;
		}
	});
	try {
		const n = (await runtime.operation("status", { run }, actor)).nodes.find(n => n.token === token);
		assert.ok(n?.state === "writing");
		process.env.FOUNDRY_TEST_WRITER = String(process.pid);
		process.env.FOUNDRY_TEST_RENDEZVOUS = gate;
		put(process.cwd(), `${n.directory}/index.mjs`, payload);
		const reply = await runtime.operation("submit", { run, token }, actor);
		const inline = inlineDelivery(root, run, actor, n.grain, token, reply);
		if (inline) host.inbox.push(inline);
		if (withhold) {
			assert.equal(lost.length, 1);
			runtime.turn(actor, lost[0]); await runtime.flush();
			assert.equal(lost.length, 1, "a shell completion without a receipt must not replay the check");
		}
		const reviews = await reportProjections(root, discovery, JSON.parse(plan));
		await runtime.flush();
		process.stdout.write(JSON.stringify({ workers: [...host.workers.values()], inbox: host.inbox, reviews }));
	} finally { runtime.close(); }
}
