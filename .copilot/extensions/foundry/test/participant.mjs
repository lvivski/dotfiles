import assert from "node:assert/strict";
import {writeFileSync} from "node:fs";
import {join} from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../work/database.mjs";
import { assignment } from "../work/native.mjs";
import { createRuntime } from "../work/runtime.mjs";
import { nativeHost, pinnedFiles, put, scriptedInspections, settleSubmitted, workflowHost } from "./fixture.mjs";

/** @typedef {{id:string,directory:string,squad:string,needs:string[]}} Part */
/** @typedef {{direction:string,check:string,parts:Part[]}} Projections */
/** Apply scripted workflow results where their batch was actually dispatched (owner or writer).
 * Only the script and the pinned Git tree inform each report; no scout process or checkout.
 * @param {string} root @param {Pick<ReturnType<typeof workflowHost>,"scouts"|"settle">} discovery @param {Projections} plan
 * @param {()=>Promise<void>} [flush] */
export async function reportProjections(root, discovery, plan,flush) {
	const parts = new Map(plan.parts.map(p => [p.id, p]));
	const reported=[];
	await discovery.settle();
	for(let index=0;;index++){
		if(index===discovery.scouts.length && flush){await flush();await discovery.settle();}
		const review=discovery.scouts[index];if(!review)break;
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
		reported.push({id:review.id,base:review.base});
	}
	return reported;
}

/** @typedef {ReturnType<typeof import("./fixture.mjs").factory>} Factory */
/** Follow real owner-native deliveries while descendant processes run; their
 * replies cannot carry a later call delivered to the owner.
 * @param {Factory} f @param {Projections} plan
 * @param {(reviews:Awaited<ReturnType<typeof reportProjections>>)=>Promise<void>} record
 * @param {(inbox:Factory["inbox"])=>Promise<void>} deliver */
export async function driveProjections(f,plan,record,deliver){
	let scouts=0,writers=0;
	/** @type {Set<Promise<void>>} */ const active=new Set();
	/** @type {unknown[]} */ const errors=[];
	let wake=()=>{};
	const stop=f.onDelivery(()=>wake());
	try{
		for(;;){
			const next=new Promise(resolve=>{wake=()=>resolve(undefined);});
			await f.owner.flush();await f.settle();
			if(!errors.length){
				const reports=f.scouts.slice(scouts);scouts+=reports.length;
				if(reports.length){
					await record(await reportProjections(f.root,{scouts:reports,settle:f.settle},plan));
					continue;
				}
				const calls=f.inbox.slice(writers);writers+=calls.length;
				if(calls.length){
					const task=deliver(calls).catch(error=>{errors.push(error);}).finally(()=>{active.delete(task);wake();});
					active.add(task);
				}
			}
			if(!active.size){if(errors.length)throw errors[0];return;}
			await next;
		}
	}finally{stop();await Promise.all(active);}
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
	const [root, run, actor, token, payload, gate, withhold, plan, barrier] = process.argv.slice(2);
	const host = nativeHost(root, token), discovery = workflowHost();
	/** @type {string[]} */ const lost = [];
	/** @type {ReturnType<typeof createRuntime>} */
	const runtime = settleSubmitted(createRuntime(process.cwd(), {
		mode: async () => "interactive", permissionBlocker: async () => null,
		...scriptedInspections(root),
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
	}));
	try {
		const n = (await runtime.operation("status", { run }, actor)).nodes.find(n => n.token === token);
		assert.ok(n?.state === "writing");
		process.env.FOUNDRY_TEST_WRITER = String(process.pid);
		process.env.FOUNDRY_TEST_RENDEZVOUS = gate;
		put(process.cwd(), `${n.directory}/index.mjs`, payload);
		const reply = await runtime.operation("submit", { run, token }, actor);
		if(barrier){
			// Observe the same facts before the unrelated reports below or a
			// delayed parent stdout callback can exhaust the evaluator's deadline.
			const {held,consumer}=JSON.parse(barrier),db=openDatabase(root);
			try{
				const r=db.read(run),own=r?.nodes[n.grain],peer=r?.nodes[held],waiting=r?.nodes[consumer];
				const c=r?.effects.find(e=>e.id===own?.check),p=r?.effects.find(e=>e.id===peer?.check);
				assert.ok(r && own?.worker===actor && own.token===token && c?.kind==="component" && c.issuer===actor &&
					c.state==="done" && c.receipt?.exit===0,"expected the original passing independent submission");
				db.verifySigned(run,c);
				assert.ok(peer?.state==="checking" && p?.tool==="bash" && p.runnerClaim && !p.receipt,"held peer already completed or never claimed");
				assert.ok(waiting?.state==="waiting" && waiting.generation===undefined,"unobserved prerequisite cannot admit the dependent");
				assert.equal(reply.qualified??null,null);assert.ok(!r.products.at(-1)?.qualifiedAt);
				writeFileSync(join(gate,"release"),"",{flag:"wx"});
			}finally{db.close();}
		}
		const inline = inlineDelivery(root, run, actor, n.grain, token, reply);
		if (inline) host.inbox.push(inline);
		if (withhold) {
			assert.equal(lost.length, 1);
			runtime.turn(actor, lost[0]); await runtime.flush();
			assert.equal(lost.length, 1, "a shell completion without a receipt must not replay the check");
		}
		const reviews = await reportProjections(root, discovery, JSON.parse(plan),()=>runtime.flush());
		process.stdout.write(JSON.stringify({ workers: [...host.workers.values()], inbox: host.inbox, reviews }));
	} finally { runtime.close(); }
}
