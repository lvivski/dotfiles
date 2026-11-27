import { checkReceipt, generationOf } from "./evidence.mjs";
import { tokenSource } from "./lineage.mjs";
import { regularFiles } from "./product.mjs";
import { effectAt, productAt } from "./revision.mjs";
import { covers, digest, fail, fields, FoundryError, record, relative, text } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Node} Node */
/** @typedef {import("./model.js").Diagnostic} Diagnostic */
/** @typedef {import("./model.js").NativeCall} Call */
/** @typedef {Record<string,import("./model.js").Json>} Data */
/** @param {unknown} value @param {(v:unknown)=>string} read */
function list(value,read){
	if(!Array.isArray(value))fail("invalid_field","Expected a list of diagnostic inputs");
	const items=value.map(read);if(new Set(items).size!==items.length)fail("invalid_field","Duplicate diagnostic input");
	return items;
}
/** @param {unknown} v */
function notes(v){
	if(!Array.isArray(v) || !v.length)fail("incomplete_evidence","Supply complete source notes for the selected stage");
	return v.map(item=>{
		const n=record(item);fields(n,["file","reason","excerpt","inventory"]);
		const i=n.inventory===undefined?undefined:record(n.inventory);
		if(i)fields(i,["file","keys"]);
		return {file:relative(n.file),reason:text(n.reason,"reason"),excerpt:text(n.excerpt,"verbatim excerpt"),
			...(i && {inventory:{file:relative(i.file),keys:list(i.keys,k=>text(k,"inventory key"))}})};
	});
}
/** @param {Diagnostic["kind"]} kind @param {unknown} raw @returns {Data} */
function inputs(kind,raw){
	const a=record(raw);
	switch(kind){
	case "observe":fields(a,["harness","current"]);return {harness:list(a.harness,relative),current:list(a.current??[],relative)};
	case "observer":{
		fields(a,["file","phases"]);return {file:relative(a.file),...(a.phases!==undefined && {phases:list(a.phases,p=>text(p,"diagnostic phase"))})};
	}
	case "production":fields(a,["files","task"]);return {files:list(a.files,relative),task:text(a.task,"production repair task")};
	case "footprint":{
		fields(a,["stages"]);if(Array.isArray(a.stages))return {stages:notes(a.stages)};
		const stages=record(a.stages),keys=["component","generated","package","runtime"];fields(stages,keys);
		return {stages:Object.fromEntries(keys.map(k=>[k,notes(stages[k])]))};
	}
	}
}

/** Only scope-local evidence, never a new read or write grant. Owner-only validations still run on the eventual request.
 * @param {Run} r @param {Node} n @param {Call} c @param {Diagnostic["kind"]} kind */
function eligible(r,n,c,kind){
	const signed=checkReceipt(c),p=r.products.at(-1);
	if(!r.goal || !p || p.commit!==r.goal.commit || p.target!==r.goal.target || r.independent || r.join || r.blocker ||
		!n.token || !n.worker || !n.generation || c.kind!=="component" || !c.runnerClaim || !signed || signed.exit===null || signed.failure)return false;
	const own=c.grain===n.grain.id;
	if(kind==="footprint"){
		const through=r.effects.find(x=>x.id===n.check),pair=through?.kind==="component" && through.observer ? r.effects.find(x=>x.id===through.observer?.pair) : undefined;
		return own && (c.id===n.check || pair?.kind==="component" && (c.id===pair.id || c.id===pair.pair?.failed)) && (n.state==="published" || n.state==="blocked");
	}
	if(signed.exit===0)return false;
	if(kind==="observe")return own && n.state==="blocked" && n.check===c.id && c.issuer===n.worker && !c.pair && !c.observer && !c.remedy && !n.restoration &&
		!r.effects.some(e=>e.kind==="rerun" && e.rerun?.of===c.id && e.commit===p.commit);
	if(kind==="observer")return own && n.state==="blocked" && n.check===c.id && signed.exit===1 && !!n.restoration && !!(c.pair || c.observer && !c.observer.previous);
	const pair=c.observer?.previous && r.effects.find(x=>x.id===c.observer?.pair);
	return signed.exit===1 && pair?.kind==="component" && (own && n.state==="blocked" && n.check===c.id ||
		pair.pair?.retainer===n.grain.id && n.state==="published" && n.check===pair.pair.component && r.nodes[c.grain??""]?.check===c.id);
}

/** @param {Run} r @param {Node} n */
export function diagnosticTasks(r,n){
	if(!n.worker || !n.token || n.state!=="blocked" && n.state!=="published")return [];
	const checks=r.effects.filter(/** @returns {e is Call} */ e=>e.kind==="component" && (e.id===n.check || !!e.observer?.previous && r.nodes[e.grain??""]?.check===e.id));
	return checks.flatMap(c=>(/** @type {const} */(["observe","observer","production"])).filter(kind=>eligible(r,n,c,kind)).map(kind=>({kind,check:c.id})));
}

/** @param {Run} r @param {Diagnostic} d */
export function currentDiagnostic(r,d){
	const n=r.nodes[d.grain],w=effectAt(r,d.assignment),c=effectAt(r,d.check),p=r.products.at(-1);
	if(!n || w?.kind!=="writer" || !n.token || n.worker!==w.nativeId || n.generation!==generationOf(w) || digest(n.token)!==d.attempt ||
		p?.check!==d.checkpoint || p.target!==d.target || r.goal?.check!==d.goal || c?.kind!=="component" || !eligible(r,n,c,d.kind))return;
	return {n,w,c,p};
}

/** @param {string} run @param {Omit<Diagnostic,"id">} d */
export const diagnosticId=(run,d)=>digest([run,d]);

/** @param {string} cwd @param {Run} r @param {Node} n @param {Record<string,unknown>} args @param {(c:Call)=>void} verify */
export function recordDiagnostic(cwd,r,n,args,verify){
	const choices=(/** @type {const} */(["observe","observer","production","footprint"])).filter(k=>args[k]!==undefined);
	if(choices.length!==1)fail("invalid_selector","Propose exactly one diagnostic; this operation cannot submit work or run a check");
	const [kind]=choices;fields(args,["run","token","check",kind]);
	const w=r.effects.findLast(e=>e.kind==="writer" && e.grain===n.grain.id && e.nativeId===n.worker),c=r.effects.find(e=>e.id===args.check);
	const p=r.products.at(-1),goal=r.goal,token=n.token;
	if(w?.kind!=="writer" || w.state!=="done" || generationOf(w)!==n.generation || c?.kind!=="component" || !p || !goal || !token || !eligible(r,n,c,kind))
		fail("stale_assignment","No matching scoped writer and signed diagnostic on the current checkpoint");
	const data=inputs(kind,args[kind]);
	if(kind==="observer" || kind==="production"){
		const paths=kind==="observer"?[relative(data.file)]:list(data.files,relative);
		if(!paths.length || paths.some(f=>!covers(n.grain.directory,f) || r.policy.files.includes(f)))fail("charter_scope","Propose files only inside your own grant and outside the contract");
		if(kind==="observer"){
			if(!!data.phases!==!!c.observer)fail("invalid_observer","Only a replacement observer needs the distinct diagnostic phases");
			data.blob=regularFiles(cwd,text(c.commit,"observed candidate"),paths)[0].oid;
		}
	}
	verify(c);
	const body={kind,grain:n.grain.id,assignment:w.id,attempt:digest(token),check:c.id,checkpoint:p.check,goal:goal.check,target:p.target,data};
	const id=diagnosticId(r.id,body);
	if(!r.diagnostics?.some(d=>d.id===id))(r.diagnostics??=[]).push({id,...body});
}

/** Pins come from the original evidence, never from a proposed edit or the owner's checkout.
 * @param {Run} r @param {Diagnostic} d @returns {{tool:string,arguments:Data}|undefined} */
export function diagnosticRequest(r,d){
	const b=currentDiagnostic(r,d);if(!b || d.kind==="footprint")return;
	const {c,p,n}=b,run=r.id,a=d.data;
	if(d.kind==="observe")return {tool:"foundry_check",arguments:{run,observe:{check:c.id,product:p.commit,...a}}};
	if(d.kind==="observer"){
		const source=text(c.commit,"diagnostic candidate"),pair=c.observer?.pair??c.id;
		return {tool:"foundry_grant",arguments:{run,observer:{grain:n.grain.id,pair,file:a.file,blob:a.blob,...(a.phases && {previous:{check:c.id,candidate:source,phases:a.phases}})}}};
	}
	return {tool:"foundry_grant",arguments:{run,production:{diagnostic:c.id,candidate:text(c.commit,"diagnostic candidate"),goal:d.goal,checkpoint:d.checkpoint,producer:n.grain.id,...a}}};
}

/** @param {Run} run @param {string} check */
export function proposedFootprint(run,check){
	const proposals=run.diagnostics?.filter(d=>d.kind==="footprint" && d.check===check && currentDiagnostic(run,d))??[];
	if(proposals.length!==1)fail("incomplete_evidence",`Need one verified writer footprint for ${check}; ${proposals.length} current proposals. Name the reviewed source explicitly if ambiguous.`);
	return {component:check,stages:proposals[0].data.stages};
}

/** @param {Run} r @param {import("./model.js").FootprintRequest} q */
export function footprintProgress(r,q){
	const p=r.products.at(-1),obs=effectAt(r,q.observer);
	if(r.independent || r.join || p?.check!==q.checkpoint || p.target!==q.target || r.goal?.check!==q.goal ||
		obs?.kind!=="component" || !obs.grain || r.nodes[obs.grain]?.check!==obs.id ||
		q.selected.some(s=>r.nodes[s.grain]?.candidate!==s.candidate || r.nodes[s.grain]?.check!==s.component || r.nodes[s.grain]?.state!=="published"))return;
	const counts=new Map(q.checks.map(check=>[check,0]));
	for(const d of r.diagnostics??[]){
		const n=counts.get(d.check);
		if(n!==undefined && d.kind==="footprint" && currentDiagnostic(r,d))counts.set(d.check,n+1);
	}
	const missing=[],ambiguous=[];
	for(const [id,n] of counts){if(!n)missing.push(id);else if(n>1)ambiguous.push(id);}
	return {missing,ambiguous,grain:obs.grain};
}
/** @param {string} run @param {import("./model.js").FootprintRequest} q @returns {Data} */
export const subsetRequest=(run,q)=>({run,observer:q.observer,checkpoint:q.checkpoint,goal:q.goal,target:q.target,selected:q.selected.map(s=>({...s}))});

/** @param {Run} run @param {Diagnostic} d */
export function validDiagnostic(run,d){
	const {id,...body}=d,w=effectAt(run,d.assignment),c=effectAt(run,d.check),p=productAt(run,d.checkpoint),g=effectAt(run,d.goal);
	if(id!==diagnosticId(run.id,body) || w?.kind!=="writer" || w.grain!==d.grain || w.state!=="done" || !w.nativeId ||
		c?.kind!=="component" || !c.runnerClaim || !checkReceipt(c) || !p || p.target!==d.target || g?.kind!=="goal" || g.commit!==p.commit)return false;
	if(!tokenSource(run.effects,w,t=>digest(t)===d.attempt))return false;
	if(d.kind==="production"){
		const pair=c.observer?.previous && run.effects.find(e=>e.id===c.observer?.pair);
		if(pair?.kind!=="component" || d.grain!==c.grain && d.grain!==pair.pair?.retainer)return false;
	}else if(c.grain!==d.grain)return false;
	const data={...d.data};if(d.kind==="observer"){if(typeof data.blob!=="string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(data.blob))return false;delete data.blob;}
	try{return digest(inputs(d.kind,data))===digest(data);}
	catch(error){if(!(error instanceof FoundryError))throw error;return false;}
}
