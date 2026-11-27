import { checkReceipt, correctionEvaluator, failedComponent, originalVerification, productPin, verification } from "./evidence.mjs";
import { batchMembers } from "./abi.mjs";
import { historicalGrant, restoredProduct } from "./partition.mjs";
import { owns, writerInputs } from "./plan.mjs";
import { publishedComponent, publicationVerdict } from "./publication.mjs";
import { changedFiles } from "./product.mjs";
import { activeConsumer } from "./transfer.mjs";
import { covers, digest, fail, ownership, roots, sameScope } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Node} Node */
/** @typedef {import("./model.js").NativeCall} Check */
/** @typedef {import("./model.js").Adoption} Offer */
/** @typedef {import("./model.js").Product} Product */

/** A restoration writer was assigned by a checked historical grant, not by a new scout.
 * Matching the area name alone would lend authority to unrelated or displaced work.
 * @param {Run} run @param {string} grain @param {import("./model.js").Scope} directory @param {string} check
 * @param {import("./model.js").Effect|undefined} source @param {boolean} rolled */
export function assigningCharter(run,grain,directory,check,source,rolled){
	/** @type {string|undefined} */ let squad;
	/** @type {string[]} */ const witnesses=[];
	if(rolled && source?.kind==="scout" && source.state==="observed" && source.observation?.outcome==="regenerate" && source.observation.grains.includes(grain)){
		const s=run.policy.squads.find(s=>s.id===source.squad),g=run.nodes[grain]?.grain;
		if(s && "grains" in s && s.grains.includes(grain) && g && g.task===undefined && g.check===check && sameScope(g.directory,directory))
			return {squad:s,areas:roots(directory),witnesses};
	}
	if(source?.kind==="scout" && source.state==="observed" && source.observation?.outcome==="regenerate" &&
		source.observation.grains.some(g=>typeof g!=="string" && g.id===grain && g.check===check && sameScope(g.directory,directory)))squad=source.squad;
	if(source?.kind==="writer" && source.grain===grain && source.restoration && source.state==="done"){
		const h=historicalGrant(run,source.restoration.from,source.restoration.historical);
		const restored=h?.scope.primary===directory && h.grain.check===check && restoredProduct(run,source);
		if(h && restored){
			squad=h.squad;
			witnesses.push(h.component.id,h.product.check,source.restoration.checkpoint,source.restoration.goal,restored.check);
		}
	}
	const s=run.policy.squads.find(s=>s.id===squad);
	if(s && "areas" in s && s.checks.includes(check) && owns(s,directory))return {squad:s,areas:s.areas,witnesses};
}

/** @param {Run} run @param {Node} n @param {boolean} rolled */
export function patchSource(run,n,rolled){
	const source=n.review ? run.effects.filter(e=>e.id===n.review) :
		run.effects.filter(e=>e.kind==="writer" && e.grain===n.grain.id && e.restoration);
	const matches=source.flatMap(e=>{
		const charter=assigningCharter(run,n.grain.id,n.grain.directory,n.grain.check,e,rolled);
		return charter?[{source:e.id,...charter}]:[];
	});
	return matches.length===1 ? matches[0] : fail("missing_grant",`No unique recorded assigning charter for ${n.grain.id}`);
}

/** @param {Run} run @param {Product} join @param {string} id @param {string[]} paths */
function consumerOf(run,join,id,paths){
	return Object.keys(join.outputs).find(other=>other!==id &&
		(Object.hasOwn(run.nodes[other].inputs??{},id) || run.nodes[other].grain.needs.includes(id))) ??
		activeConsumer(run,id,paths,{except:id})?.grain.id;
}

/** A replacement changes one output pin. Never transplant its changed bytes underneath another
 * input pin, a transferred grant, an unsettled restoration, or a separately scoped successor.
 * @param {string} cwd @param {Run} run @param {Product} join @param {Node} n @param {string[]} paths */
export function replaceable(cwd,run,join,n,paths){
	const id=n.grain.id,output=join.outputs[id],c=publishedComponent(run,n.check,id,output)?.component,review=run.effects.find(e=>e.id===n.review);
	if(!["published","qualified"].includes(n.state) || n.candidate!==output || !c || c.check!==n.grain.check ||
		n.restoration || n.successor || n.reuse || n.retained || review?.kind==="scout" && review.correction ||
		changedFiles(cwd,output,join.commit,roots(n.grain.directory)).length)
		fail("patch_scope",`Need the exact checked, unpartitioned output of ${id} on this assembly`);
	const consumer=consumerOf(run,join,id,paths);
	if(consumer)fail("pinned_consumer",`${consumer} consumes ${id} or its changed files; a one-output repair cannot replace its inputs`);
	const required=writerInputs(run.nodes,{...n,state:"waiting"});
	if(!required || digest(required)!==digest(n.inputs??null) || Object.entries(required).some(([dep,sha])=>
		join.outputs[dep]!==sha || changedFiles(cwd,sha,join.commit,roots(run.nodes[dep].grain.directory)).length))
		fail("stale_assignment",`The prerequisites of ${id} are no longer checked on this assembly`);
	return c;
}

/** @param {Run} run @param {Check} c */
export const replacementOffer=(run,c)=>c.replacement ? run.adoptions?.find(a=>a.id===c.replacement) : undefined;
/** @param {Run} run @param {string} failed */
export function replacementChecks(run,failed){
	const offers=new Set(run.adoptions?.filter(a=>a.failed===failed && a.patch?.owner && a.decision?.status==="answered").map(a=>a.id));
	return batchMembers(run.effects.filter(/** @returns {e is Check} */ e=>e.kind==="component" && !!e.replacement && offers.has(e.replacement)));
}
/** @param {Run} run @param {Check} c */
export function replacementStop(run,c){
	const r=checkReceipt(c),i=run.inspections?.find(i=>i.component===c.id);
	if(r && r.exit!==0)return `Replacement component ${c.id} exited ${r.exit??"without a verdict"}: ${r.output}`;
	if(c.state==="refused" || c.launcherExit!==undefined)return c.error??`Replacement component ${c.id} did not run`;
	if(publicationVerdict(i)==="changes")return `Independent review rejected replacement ${c.id}: ${i?.summary}`;
}

/** Nothing writable is installed while the new check or its independent review is outstanding.
 * @param {Run} run @param {Check} c */
export function currentReplacement(run,c){
	const a=replacementOffer(run,c),o=a?.patch?.owner,j=run.join,p=run.productRepins?.at(-1),n=c.grain&&run.nodes[c.grain];
	const original=originalVerification(run,j?.check),evaluator=p && original && correctionEvaluator(p,original);
	return !!a && !!o && !!j && !!p?.targetFrom && !!n && a.decision?.status==="answered" && a.decision.answer===a.patch?.blob &&
		c.issuer===run.owner && c.kind==="component" && c.commit===a.assembly && c.grain===a.patch.grain && c.check===n.grain.check &&
		j.check===a.failed && original===verification(p) && j.outputs[c.grain]===o.output && n.candidate===o.output && n.check===o.component &&
		digest(n)===o.binding && !consumerOf(run,j,c.grain,a.patch.files.map(f=>f.file)) && j.target===a.revision && p.revision===a.revision &&
		run.policy.contractTarget===a.revision && !!evaluator && productPin(run)===evaluator && run.repins?.at(-1)?.revision===evaluator &&
		run.goal?.check===a.goal && run.products.at(-1)?.check===a.checkpoint &&
		!run.blocker && !run.conflict && !run.independent && !run.effects.some(e=>e.permissionHold && e.id!==c.id) &&
		replacementChecks(run,j.check).at(-1)?.id===c.id;
}

/** @param {Offer} a @param {Product} prior */
export function replacementBasis(a,prior){
	const p=a.patch??fail("invalid_patch","Missing exact file correction");
	return {base:prior.commit,generation:prior.commit,scope:{directories:[],files:p.files.map(f=>f.file)},
		task:`Review the exact correction to ${p.grain} after failed check ${prior.check}. Preserve the behavior checked; do not weaken assertions. Only these files and bytes were approved: ${p.blob}.`};
}

/** @param {Run} run @param {Check} c */
export function replacementInspection(run,c){
	const a=replacementOffer(run,c);
	if(!a || !c.grain || !run.join || !currentReplacement(run,c) || !c.runnerClaim || checkReceipt(c)?.exit!==0)return;
	return {node:run.nodes[c.grain],overrides:replacementBasis(a,run.join)};
}

/** Historical rather than current authority. Verify the one precise outgoing version and the
 * fresh component/review even after a later assignment has replaced this node in the graph.
 * @param {Run} run @param {Offer} a @param {Product} prior @param {Map<string,import("./model.js").Effect>} effects */
export function validReplacement(run,a,prior,effects){
	const patch=a.patch,o=patch?.owner;
	if(!patch || !o || !a.failed)return false;
	const previous=publishedComponent(run,o.component,patch.grain,o.output)?.component,source=effects.get(o.source),failed=effects.get(a.failed);
	const rolled=!!run.productRepins?.some(p=>p.amendments?.some(s=>s.recheck===originalVerification(run,a.failed) && s.harness));
	if(!previous?.check || !source || !failed ||
		failedComponent(failed)!==patch.grain || failed.receipt?.components?.[patch.grain]?.check!==previous.check ||
		prior.outputs[patch.grain]!==o.output || run.effects.indexOf(source)>=run.effects.indexOf(previous) || run.effects.indexOf(previous)>=run.effects.indexOf(failed) ||
		prior.ownership && digest(prior.ownership[patch.grain]??null)!==digest(ownership(o.directory)) ||
		assigningCharter(run,patch.grain,o.directory,previous.check,source,rolled || !!patch.draft)?.squad.id!==o.squad || patch.files.some(f=>!covers(o.directory,f.file)))return false;
	const calls=batchMembers(run.effects.filter(/** @returns {e is Check} */ e=>e.kind==="component" && e.replacement===a.id));
	if(a.decision?.status!=="answered")return !calls.length;
	const [c]=calls;
	if(calls.length!==1 || c.issuer!==run.owner || c.commit!==a.assembly || c.grain!==patch.grain || c.check!==previous.check ||
		run.effects.indexOf(c)<=run.effects.indexOf(failed))return false;
	const i=run.inspections?.find(i=>i.component===c.id),b=replacementBasis(a,prior);
	const g=run.nodes[patch.grain]?.grain;
	if(i && (i.issuer!==run.owner || i.generation!==b.generation || i.base!==b.base || i.task!==b.task || i.specification!==(g?.task===undefined?g?.specification:undefined) ||
		digest(i.scope)!==digest(b.scope)))return false;
	const step=run.productRepins?.flatMap(p=>p.amendments??[]).find(s=>s.proposal===a.id);
	return !step || !!c.runnerClaim && checkReceipt(c)?.exit===0 && (!run.inspections || publicationVerdict(i)==="approved");
}
