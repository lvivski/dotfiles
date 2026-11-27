import { materialize } from "./reference.mjs";
import { isDeepStrictEqual } from "node:util";
import { admitted, boundWriter, reserveNotice } from "./native.mjs";
import { owns } from "./plan.mjs";
import { responseSource } from "./supplier.mjs";
import { verifyFixedGrant } from "./contract.mjs";
import { touchesCut } from "./transfer.mjs";
import { writerRoot } from "./workspace.mjs";
import { commitAt, generationRoot, git, pinFile, regularFiles } from "./product.mjs";
import { checkReceipt, productPin } from "./evidence.mjs";
import { covers, fail, name, names, relative, text, roots as scopePaths } from "./values.mjs";

/** @typedef {import("./model.js").Artifact} Artifact */
/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Node} Node */
/** @param {string} cwd @param {Run} run @param {import("./model.js").ReferenceSource} source @param {string} blob @param {(e:import("./model.js").NativeCall)=>void} verify */
export function verifySource(cwd,run,source,blob,verify) {
	verifyFixedGrant(cwd,run,run.nodes[source.grain]??fail("stale_assignment","The original reference producer is unavailable"));
	if(!source.component)return;
	const c=run.effects.find(e=>e.id===source.component);
	if(c?.kind!=="component" || c.commit!==source.revision || checkReceipt(c)?.exit!==0 ||
		regularFiles(cwd,source.revision,[source.file])[0].oid!==blob)
		fail("missing_artifact","The requested blob is not this file in the checked producer version");
	verify(c);
}

/** No new read: require the exact regular blob in the producer's signed candidate
 * and the consumer's own original assembled generation. Never inspect either worktree.
 * @param {string} cwd @param {Run} run @param {Node} n @param {import("./model.js").DependencyReference} d @param {string} blob @param {(e:import("./model.js").NativeCall)=>void} verify */
export function verifyDependency(cwd,run,n,d,blob,verify){
	verifySource(cwd,run,d.source,blob,verify);
	if(!n.generation || regularFiles(cwd,n.generation,[d.source.file])[0].oid!==blob)
		fail("stale_assignment","The file does not match the original writer generation");
}

/** Capture once outside the lock. The returned ledger update rechecks authority, not the file.
 * @param {string} cwd @param {Run} run @param {string} actor @param {Record<string,unknown>} args
 * @param {(e:import("./model.js").NativeCall)=>void} [verify] */
export function preparePublication(cwd, run, actor, args,verify) {
	const file = relative(args.file);
	if (!Array.isArray(args.to)) fail("invalid_recipient", "Expected a list of recipient directories");
	const to = [...new Set(args.to.map(relative))].sort();
	const evaluator=to.length===1 && (to[0]===run.policy.goalCheck || to[0]===run.policy.productCheck);
	const recipient=args.forInput===undefined?undefined:name(args.forInput,"stopped consumer");
	/** @param {Run} current @param {Node} publisher */
	function response(current,publisher){
		const n=recipient ? current.nodes[recipient] : to.length===1 && Object.values(current.nodes).find(n=>scopePaths(n.grain.directory).includes(to[0]));
		const source=n && responseSource(current,n,publisher,file,to,!!recipient);
		if(recipient && !source)fail("missing_artifact","Need this original producer's current request for its file, addressed only to the stopped consumer");
		return source || undefined;
	}

	/** @param {Run} current */
	function authorize(current) {
		admitted(current);
		if(recipient && (actor===current.owner || evaluator))fail("foreign_run","Only the original producing writer may answer a supplier request");
		if(evaluator){
			if(actor!==current.owner || args.token!==undefined || !current.goal || !current.products.at(-1))
				fail("invalid_recipient","Only the owner may offer a diff to an evaluator at a checked checkpoint");
			return;
		}
		const dirs = new Set(Object.values(current.nodes).flatMap(n => scopePaths(n.grain.directory)));
		if (!to.length || !to.every(dir => dirs.has(dir) || current.policy.squads.some(s => "areas" in s && owns(s, dir))))
			fail("invalid_recipient", "Name a recipient assignment directory or a path within a charter area");
		if (actor === current.owner && args.token === undefined) return;
		const node = boundWriter(current, actor, text(args.token, "assignment token"));
		const source=response(current,node);
		if (node.state !== "writing" && !(recipient && source?.component)) fail("stale_assignment", "This assignment is no longer writing");
		const notice=inputNotice(current,node);
		if (notice && notice.state!=="done") fail("dispatch_held","Await confirmed delivery of the selected reference before publishing");
		if (!covers(node.grain.directory, file) || touchesCut(node.retained ?? [],file)) fail("charter_scope", "File is outside the publisher's assignment");
		return {generation:text(node.generation, "generation"),source};
	}

	const authority=authorize(run),generation=authority?.generation,source=authority?.source;
	if (generation) {
		cwd = writerRoot(cwd,run,boundWriter(run,actor,text(args.token,"assignment token")));
		generationRoot(cwd, generation);
	}
	const base = source?.revision ?? generation ?? commitAt(cwd, "HEAD");
	const requested=source && run.nodes[source.consumer].stop?.input?.blob;
	const blob=source?.component ? regularFiles(cwd,source.revision,[file])[0].oid : pinFile(cwd,file);
	if(recipient && requested && blob!==requested)fail("missing_artifact","The file does not contain the exact requested blob");
	const supplied=source && (blob===requested || !requested && recipient) ? source : undefined;
	if(supplied)verifySource(cwd,run,supplied,blob,verify??(()=>fail("missing_receipt","Cannot verify the producer component")));
	const diff=actor===run.owner && (evaluator || run.join) && git(cwd,["cat-file","blob",blob]).subarray(0,11).equals(Buffer.from("diff --git "));
	if(evaluator && !diff)fail("invalid_patch","Offer the full-index Git diff directly to the evaluator");
	/** @param {Run} r */
	const binding=r=>{
		if(!diff || generation)return {};
		const p=r.products.at(-1);
		if(evaluator && p && r.goal)return {evaluation:{from:(to[0]===r.policy.goalCheck?r.repins?.at(-1)?.revision:productPin(r))??r.policy.base,
			checkpoint:p.check,goal:r.goal.check}};
		const batch=r.join && r.adoptions?.findLast(a=>a.failed===r.join?.check && a.rollout && a.decision?.status==="answered");
		const assembly=batch?.assembly??r.join?.commit;
		return assembly?{assembly}:{};
	};
	const pins=binding(run),artifact = { file, blob, base, publisher: actor, to,...pins,...(supplied&&{source:supplied}) };
	return (/** @type {Run} */ current) => {
		if(!isDeepStrictEqual(authorize(current),authority))
			fail("stale_assignment","The producer version or stopped recipient changed while capturing the reference");
		if(!isDeepStrictEqual(binding(current),pins))fail("stale_assignment","The proposed recipient's assembly changed while capturing this offer");
		const items = current.artifacts ??= [];
		if (!items.some(a => isDeepStrictEqual(a, artifact))) items.push(artifact);
	};
}

/** @param {Artifact} a @param {Node} n */
export const offered = (a, n) => (!a.source || a.source.consumer===n.grain.id && a.source.receiver===n.worker) &&
	scopePaths(n.grain.directory).some(dir => covers(a.to,dir));

/** @param {Run} run @param {Node} n */
export function inputNotice(run,n) {
	const e=run.effects.findLast(e=>e.kind==="repair" && e.token===n.token && e.grain===n.grain.id);
	return e?.kind==="repair" && e.input ? e : undefined;
}

/** @param {Run} run @param {Node} node @param {number} [since] */
const offersFor = (run, node, since = 0) => run.artifacts?.slice(since).filter(a => offered(a, node)) ?? [];

/** @param {Run} run @param {Node} node @param {Record<string,unknown>} args */
export function reportedReferences(run, node, args) {
	const allowed = new Set(offersFor(run, node).map(a => a.blob));
	const supplied=inputNotice(run,node);
	if(supplied?.state==="done" && supplied.input?.dependency)allowed.add(supplied.input.blob);
	/** @type {import("./model.js").ArtifactReport} */ const report = {};
	for (const key of /** @type {const} */ (["usedArtifacts", "comparedArtifacts"])) {
		if (args[key] === undefined) continue;
		const blobs = names(args[key], `${key} blob`);
		if (blobs.some(blob => !allowed.has(blob))) fail("foreign_artifact", "Artifact version was not offered to this assignment");
		if (blobs.length) report[key] = blobs;
	}
	return report;
}

/** @param {Run} run @param {Node} n @param {string} [issuer] */
export function takeArtifactBrief(run, n, issuer) {
	let items = offersFor(run, n, n.artifactCursor);
	if (!items.length || issuer && issuer !== run.owner && issuer !== n.worker && items.some(a => a.publisher !== issuer)) return "";
	n.artifactCursor = run.artifacts?.length;
	const supplied=inputNotice(run,n)?.input?.blob;
	if (supplied) items=items.filter(a=>a.blob!==supplied);
	if (!items.length) return "";
	return ["Read-only reference material (not a change in scope or evidence of comparison). From your worktree, extract the selected version and inspect the resulting file:",
		...items.map(a => `${JSON.stringify(a.file)} from ${a.base} (${a.source?.component ? `checked source ${a.source.component}` : "working copy"}), supplied by ${JSON.stringify(a.publisher)}:\n${materialize(a)}`),
		"At submit, optionally list exact blobs in usedArtifacts, or comparedArtifacts if you actually compared the product. Missing observation is not a match."].join("\n");
}

/** @param {Run} run @param {string} actor */
export function notifyWriters(run, actor) {
	if (!run.artifacts?.length) return;
	for (const n of Object.values(run.nodes)) {
		if (n.state !== "writing" || !n.worker || !n.token) continue;
		const body = takeArtifactBrief(run, n, actor);
		if (body) reserveNotice(run, actor, n.token, "artifact", body, n);
	}
}
