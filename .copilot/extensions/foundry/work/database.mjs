import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { git } from "./product.mjs";
import { fail } from "./values.mjs";
import { decode, receiptShape } from "./snapshot.mjs";
import { readDocument, writeDocument } from "./wire.mjs";
import { effectAt, immutable, integrityHolds, privateCopy, sameDocument, withhold } from "./revision.mjs";
import { acceptOutcome, claimOutcome } from "./outcomes.mjs";
import { isolationSeal, keepsIsolation } from "./isolation.mjs";
import { inspectExports } from "./attestation.mjs";
import { contractHold } from "./contract.mjs";
import { attemptSubject } from "./abi.mjs";

/** @typedef {import("./model.js").Run} Run */
export const protocol = 13;
/** @param {string} document */
export const checksum = document => createHash("sha256").update(document).digest("hex");

/** @param {string} cwd */
export function ledgerPath(cwd) {
	const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).toString().trim();
	return path.join(realpathSync(common), "foundry", "work.sqlite");
}

/** @param {string} file @param {boolean} create @param {(db:DatabaseSync,version:unknown,objects:Record<string,unknown>[])=>void} schema @param {()=>void} [checkSession] */
function openStore(file, create, schema, checkSession) {
	checkSession?.();
	const home = path.dirname(file);
	if (create) mkdirSync(home, { recursive: true, mode: 0o700 });
	else if (!lstatSync(file, { throwIfNoEntry: false })) fail("missing_run", "No Foundry ledger in this repository");
	const dir = lstatSync(home);
	if (!dir.isDirectory() || realpathSync(home) !== home)
		fail("unsafe_storage", "Expected an unlinked Foundry directory");
	if (!lstatSync(file, { throwIfNoEntry: false })) {
		for (const suffix of ["-wal", "-shm", "-journal"])
			if (lstatSync(file + suffix, { throwIfNoEntry: false }))
				fail("unsafe_storage", "Orphaned SQLite sidecar");
		try {
			closeSync(openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR, 0o600));
		}
		catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
				throw error;
		}
	}
	const inode = lstatSync(file);
	function verify() {
		checkSession?.();
		const d = lstatSync(home), f = lstatSync(file);
		if (!d.isDirectory() || d.ino !== dir.ino || d.dev !== dir.dev || realpathSync(home) !== home || f.ino !== inode.ino || f.dev !== inode.dev)
			fail("unsafe_storage", "Ledger or directory was replaced");
		if (!f.isFile() || f.nlink !== 1) fail("unsafe_storage", "Expected an unlinked regular ledger");
		for (const suffix of ["-wal", "-shm", "-journal"]) {
			const stat = lstatSync(file + suffix, { throwIfNoEntry: false });
			// A concurrent SQLite unlink can return a regular sidecar with zero links on macOS.
			if (stat && (!stat.isFile() || stat.nlink > 1))
				fail("unsafe_storage", `Expected an unlinked regular SQLite ${suffix.slice(1)} file`);
		}
	}
	verify();
	const db = new DatabaseSync(file);
	try {
		db.exec(`PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF; BEGIN${create?" IMMEDIATE":""}`);
		const version = db.prepare("PRAGMA user_version").get()?.user_version;
		const objects = db.prepare("SELECT type,name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all();
		schema(db, version, objects);
		db.exec("COMMIT");
	}
	catch (error) {
		db.close();
		throw error;
	}
	/** @template T @param {()=>T} fn @returns {T} */
	function write(fn) {
		verify();
		db.exec("BEGIN IMMEDIATE");
		try {
			const value = fn();
			if (value && typeof value === "object" && "then" in value)
				fail("async_transaction", "Native I/O cannot run in a ledger transaction");
			verify();
			db.exec("COMMIT");
			return value;
		}
		catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}
	return { db, verify, write };
}

/** @param {string} cwd @param {string} [file] @param {boolean} [create] @param {()=>void} [checkSession]
 * @param {(cwd:string,r:import("./model.js").Run,start:number)=>void} [prepareChecks] On new reservations only, outside the write lock. */
export function openDatabase(cwd, file = ledgerPath(cwd), create = false, checkSession,prepareChecks) {
	const { db, verify, write } = openStore(file, create, (db, version, objects) => {
		if (create && version === 0 && !objects.length) {
			db.exec(`CREATE TABLE runs(id TEXT PRIMARY KEY, owner TEXT NOT NULL, document TEXT NOT NULL, checksum TEXT NOT NULL) STRICT;
				CREATE INDEX runs_owner ON runs(owner); PRAGMA user_version=${protocol}`);
		} else if (version !== protocol || objects.length !== 2 || objects[0].type !== "table" || objects[0].name !== "runs" ||
			objects[1].type !== "index" || objects[1].name !== "runs_owner")
			fail("unsupported_store", "Incompatible Foundry execution protocol; leave the old ledger intact");
	}, checkSession);
	const spool = `${file}.outcomes`;
	/** @type {Map<string,boolean>} */ const overlays=new Map();
	/** @type {ReturnType<typeof openStore>|undefined} */ let mailbox;
	function journal(create = false) {
		if (!mailbox && (create || lstatSync(spool, { throwIfNoEntry: false }))) {
			mailbox = openStore(spool, create, (db, version, objects) => {
				if (create && version === 0 && !objects.length)
					db.exec(`CREATE TABLE outcomes(run TEXT NOT NULL, effect TEXT NOT NULL, signature TEXT NOT NULL,
						document TEXT NOT NULL, PRIMARY KEY(run,effect)) STRICT; PRAGMA user_version=1`);
				else if (version !== 1 || objects.length !== 1 || objects[0].type !== "table" || objects[0].name !== "outcomes")
					fail("unsupported_store", "Incompatible Foundry runner outcome journal");
			}, verify);
		}
		mailbox?.verify();
		return mailbox;
	}
	/** @param {string} id @param {import("./model.js").NativeCall} e */
	function verifySigned(id,e) {
		const row = journal()?.db.prepare("SELECT signature,document FROM outcomes WHERE run=? AND effect=?").get(id,e.id);
		if (!row || !e.receipt) fail("missing_receipt","Original signed runner outcome is unavailable");
		metrics.rowBytes+=Buffer.byteLength(String(row.document));
		acceptOutcome(id,e,String(row.signature),String(row.document));
	}
	const metrics={decodedBytes:0,rowBytes:0,validations:0};
	/** @type {{run:Run,guard:{committed:boolean}}|undefined} */ let locked;
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
		if(before.run.effects.some((old,i)=>old.tool==="bash" && old.attempt?.version===1 && run.effects[i]?.id!==old.id))
			fail("corrupt_run","Cannot remove or reorder original historical attempts");
		for(const e of run.effects)if(e.tool==="bash"){
			const old=effectAt(before.run,e.id);
			if(e.attempt?.version!==(old?.tool==="bash"?old.attempt?.version:2))
				fail("corrupt_run","Cannot change or fabricate historical attempt identity");
			if(old?.tool==="bash" && JSON.stringify(old.verification)!==JSON.stringify(e.verification))
				fail("corrupt_run","Cannot replace the input description of an existing attempt");
			if(old?.tool==="bash" && old.attempt?.version===1 && (old.issuer!==e.issuer || old.callId!==e.callId ||
				old.runnerClaim!==e.runnerClaim || old.runnerStarted!==e.runnerStarted || old.attempt.closure && e.attempt?.version===1 && old.attempt.closure!==e.attempt.closure ||
				JSON.stringify(old.args)!==JSON.stringify(e.args) || JSON.stringify(old.receipt)!==JSON.stringify(e.receipt) || attemptSubject(old)!==attemptSubject(e)))
				fail("corrupt_run","The original historical claim, signing subject and evidence must remain unchanged");
		}
		if(!keepsIsolation(run,before.run.independent && isolationSeal(before.run.independent)))
			fail("ownership_transition","Mutation conflicts with the approved non-release checkpoint");
		return writeDocument(run,before.base.inspections===undefined?"legacy-no-review":"required");
	}
	return {
		file,
		metrics:()=>({...metrics}),
		/** Inside the exclusive claim transaction. Only the holder can publish; publishing
		 * never reads or mutates the run document. @param {string} run @param {import("./model.js").Effect} effect */
		outcomeWriter(run, effect) {
			const claim=locked?.guard,id=effect.id;
			if(!claim || locked?.run.id!==run || !locked.run.effects.includes(effect))fail("unissued_check","Only the original locked reservation can create a runner key");
			const seal = claimOutcome(run, effect);
			const store = journal(true) ?? fail("missing_store", "No runner outcome journal");
			/** @param {import("./model.js").Receipt} receipt */
			const publish=receipt => {
				if(!claim.committed)fail("unissued_check","Runner claim did not commit");
				const {document, signature} = seal(receipt);
				store.write(() => {
					const inserted = store.db.prepare("INSERT INTO outcomes VALUES(?,?,?,?) ON CONFLICT(run,effect) DO NOTHING")
						.run(run, id, signature, document);
					if (inserted.changes) return;
					const prior = store.db.prepare("SELECT signature,document FROM outcomes WHERE run=? AND effect=?").get(run,id);
					if (prior?.signature !== signature || prior.document !== document)
						fail("conflicting_outcome", "Refusing to replace the original runner outcome");
				});
			};
			return Object.assign(publish,{signPreparation:(/** @type {string} */ inputs,/** @type {string} */ tree)=>{
				if(!claim.committed)fail("unissued_check","Runner claim did not commit");return seal.signPreparation(inputs,tree);
			}});
		},
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
		/** The planner may run repeatedly. Never send, prompt or launch from it.
		 * A guarded no-op still needs to confirm the same snapshot and external tip.
		 * @param {string} id @param {(run:Run)=>(()=>boolean)|void} plan */
		planAndSwap(id, plan) {
			for (;;) {
				const before=required(id),run=draft(before),valid=plan(run);
				prepareChecks?.(cwd,run,before.run.effects.length);
				const next=changed(before,run);
				if(next===undefined && !valid)return run;
				if(write(()=>stamp(id).stamp===before.stamp && (!valid || valid()) && (next===undefined ||
					db.prepare("UPDATE runs SET document=?,checksum=? WHERE id=? AND checksum=?").run(next,checksum(next),id,before.sum).changes===1)))return run;
			}
		},
		/** @param {Run} run */
		insert(run) {
			writable(run);
			if(run.effects.some(e=>e.tool==="bash" && e.attempt?.version!==2))fail("corrupt_run","New run requires a current attempt binding");
			prepareChecks?.(cwd,run,0);
			const doc = writeDocument(run,"required");
			return write(() => db.prepare("INSERT INTO runs VALUES(?,?,?,?)").run(run.id, run.owner, doc, checksum(doc)));
		},
		/** Single synchronous transaction; keep only final identity checks and bounded mutations here.
		 * @template T @param {string} id @param {(run:Run)=>T} fn @returns {T} */
		mutateLocked(id, fn) {
			const claim={committed:false};
			const result=write(() => {
				const before=required(id,false),run=draft(before);locked={run,guard:claim};
				try{
					const result=fn(run),doc=changed(before,run);
					if(doc!==undefined)db.prepare("UPDATE runs SET document=?,checksum=? WHERE id=?").run(doc,checksum(doc),id);
					return result;
				}finally{locked=undefined;}
			});
			claim.committed=true;return result;
		},
		close() { mailbox?.db.close(); db.close(); },
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
		const {nodes,effects,inspections,active,pauseReason,policyHold,...old}=before,
			{nodes:fresh,effects:calls,inspections:reviews,active:running,pauseReason:reason,policyHold:policy,...now}=after;
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
