import { createHash } from "node:crypto";
import { checksum, ledgerPath, openLedger } from "./storage.mjs";
export {checksum,ledgerPath,protocol} from "./storage.mjs";
import { fail } from "./values.mjs";
import { decode, receiptShape } from "./snapshot.mjs";
import { readDocument, writeDocument } from "./wire.mjs";
import { effectAt, immutable, integrityHolds, privateCopy, sameDocument, withhold } from "./revision.mjs";
import { acceptOutcome } from "./outcomes.mjs";
import { isolationSeal, keepsIsolation } from "./isolation.mjs";
import { inspectExports } from "./attestation.mjs";
import { contractHold } from "./contract.mjs";
import { attemptSubject, supportedNewCall } from "./abi.mjs";
import {fenceHistory,historical,preserveHistory} from "./historical.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @param {string} cwd @param {string} [file] @param {boolean} [create] @param {()=>void} [checkSession]
 * @param {(cwd:string,r:import("./model.js").Run,start:number)=>void} [prepareChecks] On new reservations only, outside the write lock. */
export function openDatabase(cwd, file = ledgerPath(cwd), create = false, checkSession,prepareChecks) {
	const store=openLedger(file,create,checkSession),{db,write,verify,journal,close}=store;
	/** @type {Map<string,boolean>} */ const overlays=new Map();
	/** @param {string} id @param {import("./model.js").NativeCall} e */
	function verifySigned(id,e) {
		const row = journal()?.db.prepare("SELECT signature,document FROM outcomes WHERE run=? AND effect=?").get(id,e.id);
		if (!row || !e.receipt) fail("missing_receipt","Original signed runner outcome is unavailable");
		metrics.rowBytes+=Buffer.byteLength(String(row.document));
		acceptOutcome(id,e,String(row.signature),String(row.document));
	}
	const metrics={decodedBytes:0,rowBytes:0,validations:0};
	/** @typedef {{run:Run,base:Run,sum:string,stamp:string,mail:string}} Revision */
	/** @type {Revision|undefined} */ let latest;
	/** Only the most recent full history is strongly retained by this connection.
	 * Other immutable views can be reused while a reader still owns them.
	 * @type {Map<string,WeakRef<Run>>} */ const byId=new Map();
	/** @type {WeakMap<Run,Revision>} */ const revisions=new WeakMap();
	/** @param {Revision} r */
	function remember(r){latest=r;byId.set(r.run.id,new WeakRef(r.run));revisions.set(r.run,r);return r;}
	/** A different connection can change a document without updating its checksum,
	 * or replace an existing row in a damaged spool without advancing max(rowid).
	 * @param {string} id */
	function stamp(id){
		verify();const spool=journal()?.db;
		const v=db.prepare("PRAGMA data_version").get()?.data_version;
		const head=db.prepare("SELECT checksum,owner FROM runs WHERE id=?").get(id);
		const sv=spool?.prepare("PRAGMA data_version").get()?.data_version;
		const tail=spool?.prepare("SELECT max(rowid) AS n FROM outcomes WHERE run=?").get(id)?.n;
		return {head,stamp:JSON.stringify([head?.checksum,head?.owner,v,sv,tail])};
	}
	/** @param {string} id @param {boolean} [probe] */
	function snapshot(id,probe=true) {
		for(;;){
			const head=stamp(id);if(!head.head)return;
			const key=byId.get(id)?.deref(),prior=latest?.run.id===id?latest:key && revisions.get(key);
			if(prior?.stamp===head.stamp){inspectExports(cwd,prior.run,overlays,probe,verifySigned);return prior;}
			const next=load(id,head.stamp,prior);
			// The databases have separate writers. A late claim or row between
			// reads is an observation race, not corrupt evidence or a new grant.
			if(stamp(id).stamp!==head.stamp)continue;
			if(!next)return;
			inspectExports(cwd,next.run,overlays,probe,verifySigned);
			return remember(next);
		}
	}
	/** @param {string} id @param {string} version @param {Revision|undefined} prior @returns {Revision|undefined} */
	function load(id,version,prior){
		const row=db.prepare("SELECT document,checksum,owner FROM runs WHERE id=?").get(id);
		if(!row)return;
		const document=String(row.document),sum=String(row.checksum);
		metrics.rowBytes+=Buffer.byteLength(document);
		if(checksum(document)!==sum)fail("corrupt_run","Run no longer matches its recorded execution snapshot");
		let base=prior?.sum===sum?prior.base:undefined;
		if(!base){metrics.decodedBytes+=Buffer.byteLength(document);metrics.validations++;base=immutable(readDocument(document));}
		if(base.id!==id || base.owner!==row.owner)fail("corrupt_run","Run no longer matches its recorded execution snapshot");
		const query=journal()?.db.prepare("SELECT effect,signature,document FROM outcomes WHERE run=? ORDER BY rowid");
		/** Do not retain a second full spool or allocate one giant serialized string.
		 * @param {(effect:string,signature:string,document:string)=>void} [visit] */
		function scan(visit){
			const hash=createHash("sha256");
			for(const row of query?.iterate(id)??[]){
				const effect=String(row.effect),sig=String(row.signature),doc=String(row.document);
				metrics.rowBytes+=Buffer.byteLength(doc);
				for(const s of [effect,sig,doc])hash.update(`${s.length}:`).update(s);
				visit?.(effect,sig,doc);
			}
			return hash.digest("hex");
		}
		if(prior?.base===base && prior.mail===scan())return {...prior,stamp:version};
		/** @type {import("./revision.mjs").IntegrityHold[]} */ const holds=[];
		/** @param {string} effect @param {string} reason */
		const hold=(effect,reason)=>holds.push({effect,code:"inadmissible-outcome",reason});
		const seen=new Set();
		/** @type {Map<string,import("./model.js").Effect>} */ const imported=new Map();
		const root=base,mail=scan((effect,signature,body)=>{
			const e=effectAt(root,effect);seen.add(effect);
			if(!e){hold(effect,"No matching reservation");return;}
			const copy=e.receipt?e:{...e};
			try{acceptOutcome(id,copy,signature,body,doc=>{
				metrics.decodedBytes+=Buffer.byteLength(doc);const receipt=JSON.parse(doc);
				if(!receiptShape(receipt))fail("wrong_outcome","Unsupported runner receipt shape");return receipt;
			});}
			catch(error){if(!inadmissible(error))throw error;hold(effect,String(error));return;}
			if(copy!==e)imported.set(effect,copy);
		});
		for(const e of base.effects)if(e.receipt && e.runnerClaim && !seen.has(e.id))hold(e.id,"Original signed runner outcome is unavailable");
		let run=base;
		if(imported.size || holds.length){
			const bad=new Set(holds.map(h=>h.effect));
			run={...base,effects:base.effects.map(e=>imported.get(e.id)??(bad.has(e.id)?{...e}:e))};
			const validate=()=>{metrics.validations++;decode(run,true);};
			try{validate();}
			catch(error){
				if(!inadmissible(error))throw error;
				// A signed but structurally inadmissible late result must not hide a good sibling.
				run.effects=base.effects.map(e=>bad.has(e.id)?{...e}:e);
				for(const [index,old] of base.effects.entries()){
					const next=imported.get(old.id);if(!next)continue;run.effects[index]=next;
					try{validate();}
					catch(error){if(!inadmissible(error))throw error;run.effects[index]={...old};hold(old.id,String(error));}
				}
				validate();
			}
		}
		const revision={run:immutable(run),base,sum,stamp:version,mail};
		withhold(run,immutable(holds));
		return revision;
	}
	/** @param {string} id @param {boolean} [probe] */
	const required = (id,probe=true) => snapshot(id,probe) ?? fail("missing_run", `Unknown run ${id}`);
	/** @param {Run} run */
	const writable=run=>{const reason=contractHold(run);if(reason)fail("contract_hold",reason);};
	/** @param {Revision} before */
	function draft(before){
		writable(before.run);
		const run=privateCopy(before.run);withhold(run,integrityHolds(before.run));
		inspectExports(cwd,run,overlays,false,verifySigned);
		return run;
	}
	/** @param {Revision} before @param {Run} run */
	function changed(before,run){
		if(sameDocument(run,before.run))return;
		writable(run);preserveHeld(before.run,run);
		preserveHistory(before.run,run);
		for(const a of before.run.adoptions??[])if(a.accepted && !sameDocument(a.accepted,run.adoptions?.find(next=>next.id===a.id)?.accepted))
			fail("corrupt_run","Cannot replace the original accepted presentation");
		if(before.run.effects.some((w,i)=>w.kind==="writer" && w.writing && (run.effects[i]?.kind!=="writer" ||
			run.effects[i].id!==w.id || !sameDocument(w.writing,/** @type {import("./model.js").NativeCall} */(run.effects[i]).writing))))
			fail("corrupt_run","Cannot replace a writer's original grant");
		if(before.run.effects.some((old,i)=>historical(old) && (run.effects[i]?.id!==old.id || run.effects[i]?.tool!=="bash")))
			fail("corrupt_run","Cannot remove or reorder original historical attempts");
		for(const e of run.effects)if(e.tool==="bash"){
			const old=effectAt(before.run,e.id);
			if(old?.tool==="bash" ? !sameDocument(old.attempt,e.attempt) : historical(e))
				fail("corrupt_run","Cannot change or fabricate historical attempt identity");
			if(old?.tool==="bash" && JSON.stringify(old.verification)!==JSON.stringify(e.verification))
				fail("corrupt_run","Cannot replace the input description of an existing attempt");
			if(old?.tool==="bash" && old.attempt?.version===3 && (old.issuer!==e.issuer || !sameDocument(old.args,e.args) ||
				old.callId!==undefined && old.callId!==e.callId || attemptSubject(old)!==attemptSubject(e)))
				fail("corrupt_run","Cannot change the original issuer, native request or subject of a declared check");
			if(old?.tool==="bash" && historical(old) && (old.issuer!==e.issuer || old.callId!==e.callId ||
				old.runnerClaim!==e.runnerClaim || old.runnerStarted!==e.runnerStarted ||
				JSON.stringify(old.args)!==JSON.stringify(e.args) || JSON.stringify(old.receipt)!==JSON.stringify(e.receipt) || attemptSubject(old)!==attemptSubject(e)))
				fail("corrupt_run","The original historical claim, signing subject and evidence must remain unchanged");
		}
		if(!keepsIsolation(run,before.run.independent && isolationSeal(before.run.independent)))
			fail("ownership_transition","Mutation conflicts with the approved non-release checkpoint");
		const review=before.base.inspections===undefined?"legacy-no-review":"required";
		if(before.base.history)return writeDocument(run,review);
		// A speculative plan may lose to a loaded old runner. Census the re-read
		// original row AND spool under BEGIN IMMEDIATE, never the pre-lock draft.
		return ()=>{
			const original=load(run.id,stamp(run.id).stamp,undefined);
			if(!original || original.sum!==before.sum || original.mail!==before.mail)
				fail("stale_fence","Original check evidence changed before conversion");
			/** @type {Map<string,boolean>} */ const ledgers=new Map();
			fenceHistory(original.run,run,path=>{
				if(!ledgers.has(path)){
					try{ledgers.set(path,ledgerPath(path)===file);}catch{ledgers.set(path,false);}
				}
				return ledgers.get(path)===true;
			});
			const effects=run.effects.map((now,i)=>{
				const raw=original.base.effects[i],observed=original.run.effects[i];
				return raw && raw!==observed && historical(raw) && !raw.receipt && observed.receipt && sameDocument(now,observed)?raw:now;
			});
			if(!effects.some((e,i)=>e!==run.effects[i]))return writeDocument(run,review);
			// Hydrating the signed spool is a read. A wire conversion must not
			// turn that view into an edit of the historical claim.
			const fenced={...run,effects};
			try{decode(fenced,true);}
			catch(error){if(!inadmissible(error))throw error;fail("historical_outcome_hold","This first edit needs a spool-only result in the stored graph; original rows left intact");}
			return writeDocument(fenced,review);
		};
	}
	/** @param {Run} run @param {number} from */
	function currentReservations(run,from){
		if(run.effects.slice(from).some(e=>!supportedNewCall(e)))
			fail("current_authority_required","A new check requires its own proven current declaration; historical formats are read/close only");
	}
	/** Only return the value from the successful private plan. Even when an observation
	 * changes no bytes, its native ticket must survive the same revision check.
	 * @template T @param {string} id @param {(run:Run)=>{value:T,guard?:(()=>boolean)|void,confirm?:boolean}} plan */
	function commitPlan(id,plan){
		for(;;){
			const before=required(id),run=draft(before),{value,guard,confirm}=plan(run);
			prepareChecks?.(cwd,run,before.run.effects.length);
			currentReservations(run,before.run.effects.length);
			const next=changed(before,run);
			if(next===undefined && !guard && !confirm)return value;
			if(write(()=>{
				if(stamp(id).stamp!==before.stamp || guard && !guard())return false;
				if(next===undefined)return true;
				const doc=typeof next==="function"?next():next;
				return db.prepare("UPDATE runs SET document=?,checksum=? WHERE id=? AND checksum=?").run(doc,checksum(doc),id,before.sum).changes===1;
			}))return value;
		}
	}
	return {
		file,
		/** @param {string} id @param {(run:Run)=>(()=>boolean)|void} plan */
		planAndSwap(id,plan){return commitPlan(id,run=>({value:run,guard:plan(run)}));},
		/** Only the committed plan can hand its caller a native ticket. A lost CAS,
		 * withdrawn selection or failed guard cannot leak the earlier draft's ticket.
		 * @template T @param {string} id @param {(run:Run)=>{value:T,guard?:()=>boolean}|undefined} select */
		reserve(id,select){
			return commitPlan(id,run=>{
				const chosen=select(run);
				return {value:chosen?.value,guard:chosen?.guard,confirm:chosen!==undefined};
			});
		},
		metrics:()=>({...metrics}),
		/** Change notification only; consumers must still read and verify the snapshot. @param {string} id */
		stamp:id=>stamp(id).stamp,
		/** @param {string} id */
		read(id) { return snapshot(id)?.run; },
		/** A speculative plan can mutate its own graph, never an indexed read.
		 * @template T @param {string} id @param {(r:Run)=>T} fn */
		preview(id,fn){return fn(draft(required(id)));},
		/** The checkout may no longer contain the activated brief. Never pick between two generations by recency.
		 * @param {string} source @param {string} owner */
		forResume(source,owner) {
			verify();
			const rows=db.prepare("SELECT id,owner FROM runs WHERE json_extract(document,'$.policy.source')=?").all(source);
			const own=rows.filter(r=>r.owner===owner);
			if (rows.length && own.length!==1) fail("run_conflict",own.length ? "Multiple owned runs use this source; specify the exact run ID" : "Only the original owner can resume this source");
			if (own.length) return required(String(own[0].id)).run;
		},
		/** An owner's other runs are not inputs to worker identity. @param {string} actor */
		isWriter(actor) {
			verify();
			return !!db.prepare(`SELECT 1 FROM runs WHERE owner<>? AND EXISTS (
				SELECT 1 FROM json_each(document,'$.effects') WHERE json_extract(value,'$.nativeId')=?
			) LIMIT 1`).get(actor,actor);
		},
		/** Recovery needs positive evidence even for a receipt already copied into the ledger.
		 * @param {string} id @param {import("./model.js").NativeCall} e */
		verifySigned,
		/** @param {string} actor */
		involving(actor) {
			verify();
			return db.prepare(`SELECT id FROM runs WHERE owner=? OR EXISTS (
				SELECT 1 FROM json_each(document,'$.effects') WHERE json_extract(value,'$.nativeId')=?
			) ORDER BY id`).all(actor, actor).map(r => String(r.id));
		},
		/** @param {Run} run */
		insert(run) {
			writable(run);
			if(run.history)fail("corrupt_run","A new run cannot inherit historical slots");
			prepareChecks?.(cwd,run,0);
			currentReservations(run,0);
			const doc = writeDocument({...run,history:{},historicalPrefix:{length:0,last:null}},"required");
			return write(() => db.prepare("INSERT INTO runs VALUES(?,?,?,?)").run(run.id, run.owner, doc, checksum(doc)));
		},
		/** Single synchronous transaction; keep only final identity checks and bounded mutations here.
		 * @template T @param {string} id @param {(run:Run)=>T} fn @returns {T} */
		mutateLocked(id, fn) {
			return write(() => {
				const before=required(id,false),run=draft(before),result=fn(run),next=changed(before,run);
				if(next!==undefined){
					const doc=typeof next==="function"?next():next;
					db.prepare("UPDATE runs SET document=?,checksum=? WHERE id=?").run(doc,checksum(doc),id);
				}
				return result;
			});
		},
		close,
	};
}

/** @param {unknown} e */
const inadmissible=e=>e instanceof SyntaxError || e instanceof Error && "code" in e &&
	["wrong_outcome","conflicting_outcome","corrupt_run","unproven_inputs","invalid_path","invalid_field"].includes(String(e.code));
/** A pending bad row has no verdict to consume. If evidence already copied into
 * the graph is contradicted, only independently disjoint assignments may change.
 * @param {Run} before @param {Run} after */
function preserveHeld(before,after){
	const list=integrityHolds(before);if(!list.length)return;
	const same=(/** @type {unknown} */ a,/** @type {unknown} */ b)=>JSON.stringify(a)===JSON.stringify(b);
	const stop=()=>fail("integrity_hold","A change depends on an inadmissible original outcome");
	for(const h of list){
		const prior=effectAt(before,h.effect),next=effectAt(after,h.effect);
		if(!same(prior,next))stop();
		if(!prior?.receipt)continue;
		const affected=new Set(prior.grain?[prior.grain]:[]);
		for(let count=-1;count!==affected.size;){
			count=affected.size;
			for(const n of Object.values(after.nodes))if(n.grain.needs.some(id=>affected.has(id)) || Object.keys(n.inputs??{}).some(id=>affected.has(id)))affected.add(n.grain.id);
		}
		const {nodes,effects,inspections,active,pauseReason,policyHold,history,...old}=before,
			{nodes:fresh,effects:calls,inspections:reviews,active:running,pauseReason:reason,policyHold:policy,history:slots,...now}=after;
		const earlier=effects.slice(0,effects.indexOf(prior));
		/** A product-wide result cannot have admitted a writer already bound before
		 * that check was reserved. Do not grant a fresh owner on this inference. @param {string|undefined} id */
		const disjoint=id=>!!id && !!nodes[id]?.worker && !affected.has(id) && (!!prior.grain || earlier.some(e=>
			e.kind==="writer" && e.grain===id && e.nativeId===nodes[id].worker) && (prior.kind!=="product" || nodes[id].base!==prior.commit));
		if(!same(old,now) || running && (!active || reason!==pauseReason || !same(policy,policyHold)))stop();
		for(const id of Object.keys({...nodes,...fresh}))if(!same(nodes[id],fresh[id]) &&
			(!disjoint(id) || !fresh[id] || !same(nodes[id].grain,fresh[id].grain) || nodes[id].worker!==fresh[id].worker ||
				nodes[id].generation!==fresh[id].generation || !same(nodes[id].inputs,fresh[id].inputs)))stop();
		if(effects.some((e,i)=>calls[i]?.id!==e.id) || inspections?.some((r,i)=>reviews?.[i]?.id!==r.id))stop();
		for(const e of calls)if(!same(e,effectAt(before,e.id)) && !disjoint(e.grain))stop();
		for(const r of reviews??[])if(!same(r,inspections?.find(i=>i.id===r.id)) && !disjoint(r.grain))stop();
	}
}
