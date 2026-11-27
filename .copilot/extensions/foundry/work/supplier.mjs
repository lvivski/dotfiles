import { working } from "./assignment.mjs";
import { activeDelivery } from "./batch.mjs";
import { contractHold } from "./contract.mjs";
import { generationOf, missingInput, qualifiedProduct } from "./evidence.mjs";
import { checked, originalScope, referenceAttempt, stalePins, writerVersion } from "./plan.mjs";
import { publishedComponent } from "./publication.mjs";
import { touchesCut } from "./transfer.mjs";
import { covers, digest, fail, fields, name, record, relative, roots } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Node} Node */
/** @typedef {import("./model.js").Artifact} Artifact */
/** @typedef {import("./model.js").ReferenceSource} Source */

/** @param {Run} run @param {import("./model.js").Effect|undefined} c @param {string} worker @param {string} grain @param {string} revision */
const checkedSource=(run,c,worker,grain,revision)=>c?.kind==="component" && c.issuer===worker &&
	!c.recheck && !c.rollout && !c.replacement && !c.pair && !c.observer && !c.delivery && !c.remedy && !!publishedComponent(run,c.id,grain,revision);

/** A claim can name an output, never a different writer or version. Resolve its
 * actual authority from the launch, current grant and (if published) original check.
 * The immutable-only variant cannot authorize a publisher, checkout, token or message.
 * @param {Run} run @param {Node} consumer @param {Node|undefined} p @param {string} file @param {boolean} [immutable] @returns {Source|undefined} */
function sourceFor(run,consumer,p,file,immutable=false) {
	if(!p || p===consumer || p.grain.id===consumer.grain.id || !p.generation || !p.worker || !p.token || !p.base || !p.review ||
		p.worker===consumer.worker || !covers(p.grain.directory,file) || touchesCut(p.retained??[],file) || stalePins(run,p).length ||
		!originalScope(run,p,run.effects.find(e=>e.id===p.review)) ||
		!immutable && (Object.values(run.nodes).some(n=>n!==p && n.worker===p.worker && working(n)) ||
			run.effects.some(e=>(e.issuer===p.worker || e.grain===p.grain.id) && e.permissionHold) ||
			run.inspections?.some(i=>i.issuer===p.worker && i.permissionHold)))return;
	const launches=run.effects.filter(e=>e.kind==="writer" && e.grain===p.grain.id && e.state!=="withdrawn");
	const w=launches[0];
	if(launches.length!==1 || w.kind!=="writer" || !w.callId || w.error || w.state!=="done" || w.nativeId!==p.worker ||
		generationOf(w)!==p.generation || w.observer || w.production || w.restoration || w.reuse)return;
	if(!immutable && run.effects.slice(run.effects.indexOf(w)+1).some(e=>e.kind==="writer" && (e.nativeId===p.worker || e.pooled &&
		e.state!=="withdrawn" && e.state!=="refused" && (e.args.session_id===p.worker || e.tool==="session.send" && e.issuer===p.worker))))return;
	const pin=consumer.inputs?.[p.grain.id],c=run.effects.find(e=>e.id===p.check);
	const published=p.candidate && checked(p) && c?.check===p.grain.check && checkedSource(run,c,p.worker,p.grain.id,p.candidate);
	if(immutable && (!pin || !run.inspections || p.state!=="qualified" || !published || run.products.at(-1)?.outputs[p.grain.id]!==pin))return;
	if(pin && (!published || p.candidate!==pin) || !published &&
		(p.state!=="writing" || p.check || p.candidate || p.token!==w.token || w.finished))return;
	return {grain:p.grain.id,assignment:w.id,review:p.review,worker:p.worker,generation:p.generation,grant:writerVersion(p),file,
		revision:published?/** @type {string} */(p.candidate):p.generation,...(published && {component:c.id})};
}

/** @param {unknown} value */
export function sourceLocator(value){
	const a=record(value);fields(a,["grain","file"]);
	return {grain:name(a.grain,"producing assignment"),file:relative(a.file)};
}

/** @param {Run} run @param {Source} s */
function pooledBinding(run,s){
	const w=run.effects.find(e=>e.id===s.assignment);
	if(w?.kind!=="writer" || !s.component || w.finished?.component!==s.component ||
		!run.products.some(p=>p.check===w.finished?.product && p.outputs[s.grain]===s.revision))return;
	const matches=run.effects.filter(e=>e.kind==="writer" && e.pooled?.from===w.id && e.nativeId===s.worker &&
		e.grain!==s.grain && e.state==="done" && !!e.callId && !e.error);
	return matches.length===1 ? matches[0].id : undefined;
}

/** The one source already granted to the consumer survives an unrelated session handoff.
 * An offered blob, a session ID or an unconfirmed pool reservation cannot stand in for it.
 * @param {Run} run @param {Node} n @param {Pick<Source,"grain"|"file">|undefined} [locator] */
export function pooledDependency(run,n,locator=n.stop?.input?.source){
	if(!locator || !n.inputs?.[locator.grain])return;
	const s=sourceFor(run,n,run.nodes[locator.grain],locator.file,true),requested=n.stop?.input?.source;
	if(!s?.component || requested && digest(s)!==digest(requested))return;
	const pooled=pooledBinding(run,s);
	if(pooled)return {source:{...s,component:s.component},pooled};
}

/** @param {Run} run @param {Node} consumer @param {unknown} value */
export function requestedSource(run,consumer,value){
	const at=sourceLocator(value);
	return sourceFor(run,consumer,run.nodes[at.grain],at.file)??pooledDependency(run,consumer,at)?.source??
		fail("stale_assignment","No original producer grant for this reference path and input version");
}

/** Historical proof must not depend on future graph state.
 * @param {Run} history @param {Node} prior @param {import("./model.js").DependencyReference} ref @param {import("./model.js").Product|undefined} p */
export function recordedDependency(history,prior,ref,p){
	const s=ref.source,req=prior.stop?.input?.source;
	return !!s.component && !!history.inspections && prior.inputs?.[s.grain]===s.revision && p?.outputs[s.grain]===s.revision &&
		s.grain!==prior.grain.id && s.worker!==prior.worker && (!req || digest(s)===digest(req)) &&
		sourceBinding(history,s) && pooledBinding(history,s)===ref.pooled;
}

/** An opaque consumer binding is safe to show the producer; a consumer token is not.
 * @param {Node} n */
const request=n=>digest([writerVersion(n),missingInput(n),
	n.stop?.input?.blob,n.stop?.input?.after,n.stop?.input?.source??null]);

/** The permanent binding survives a later retirement of the source output. Never
 * require today's ownership to decode history; recheck it when granting authority.
 * @param {Run} run @param {Source} s */
export function sourceBinding(run,s){
	const w=run.effects.find(e=>e.id===s.assignment),r=run.effects.find(e=>e.id===s.review),c=run.effects.find(e=>e.id===s.component);
	const g=r?.kind==="scout" && r.state==="observed" && r.observation?.grains.find(g=>(typeof g==="string"?g:g.id)===s.grain);
	const scope=g && (typeof g==="string"?run.nodes[g]?.grain.directory:g.directory);
	return scope && covers(scope,s.file) && w?.kind==="writer" && w.grain===s.grain && w.state==="done" && !!w.callId &&
		!w.production && !w.restoration && !w.reuse && !w.observer && s.worker!==run.owner && w.nativeId===s.worker &&
		!!r && run.effects.indexOf(r)<run.effects.indexOf(w) && generationOf(w)===s.generation &&
		(s.component ? !!c && run.effects.indexOf(w)<run.effects.indexOf(c) && checkedSource(run,c,s.worker,s.grain,s.revision) : s.revision===s.generation);
}

/** Durable provenance of a read-only response, independent of later producer/consumer work.
 * @param {Run} run @param {Node} n @param {Artifact} a @param {number} index */
export function supplied(run,n,a,index){
	const need=n.stop?.input,s=a.source;
	if(!s || missingInput(n)===undefined || need && (index<need.after || need.blob!==a.blob) ||
		s.consumer!==n.grain.id || s.receiver!==n.worker || s.request!==request(n) ||
		a.assembly || a.evaluation || a.publisher===run.owner || s.worker!==a.publisher || a.file!==s.file || a.base!==s.revision ||
		a.to.length!==1 || !roots(n.grain.directory).includes(a.to[0]))return false;
	const {consumer,receiver,request:subject,...source}=s;
	if(need?.source && digest(need.source)!==digest(source) || n.inputs?.[s.grain] && (!s.component || n.inputs[s.grain]!==s.revision))return false;
	return !!sourceBinding(run,s);
}

/** @param {Run} run @param {Node} n @param {Artifact} a @param {number} index */
export function currentSupply(run,n,a,index){
	if(!supplied(run,n,a,index) || !a.source)return false;
	const {consumer,receiver,request:subject,...stored}=a.source;
	const live=sourceFor(run,n,run.nodes[stored.grain],a.file);
	return !!live && digest(live)===digest(stored);
}

/** A producer may explicitly propose its bytes for a prose-only stop, but only an
 * operator selecting the exact blob in the native input form can match that need.
 * @param {Run} run @param {Node} consumer @param {Node} producer @param {string} file @param {string[]} to @param {boolean} [propose] */
export function responseSource(run,consumer,producer,file,to,propose=false){
	const need=consumer.stop?.input;
	if(!need && !propose || !consumer.worker || !referenceAttempt(run,consumer) || stalePins(run,consumer).length ||
		to.length!==1 || !roots(consumer.grain.directory).includes(to[0]))return;
	const source=sourceFor(run,consumer,producer,file);
	if(!source || need?.source && digest(source)!==digest(need.source))return;
	if(run.effects.some(e=>e.kind==="repair" && e.state!=="withdrawn" && e.input?.prior.token===consumer.token))return;
	return {...source,consumer:consumer.grain.id,receiver:consumer.worker,request:request(consumer)};
}

/** Project executable producer requests, not permissions. Recompute for delivery; do not put
 * either writer's private token on the wire. The publish operation authenticates its own caller.
 * @param {Run} run */
export function* supplierRequests(run){
	if(!run.active || !run.goal || run.policyHold || run.conflict || run.blocker || run.independent || activeDelivery(run) || contractHold(run) || qualifiedProduct(run))return;
	for(const consumer of Object.values(run.nodes)){
		const need=consumer.stop?.input,s=need?.source,producer=s && run.nodes[s.grain];
		if(!s || !need || !producer)continue;
		const to=[roots(consumer.grain.directory)[0]];
		if(!responseSource(run,consumer,producer,s.file,to) ||
			run.artifacts?.some((a,i)=>currentSupply(run,consumer,a,i)))continue;
		yield {producer,consumer,assignment:s.assignment,file:s.file,blob:need.blob,revision:s.revision,component:s.component,to};
	}
}
