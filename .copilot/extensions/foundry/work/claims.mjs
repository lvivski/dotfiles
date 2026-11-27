import { exactRunner } from "./abi.mjs";
import { preparationGroup, sampleLive, verifyClaim } from "./requirements.mjs";
import { claimOutcome, readCurrent } from "./seals.mjs";
import { checksum, ledgerPath, openLedger } from "./storage.mjs";
import { editionBoundary } from "./revision.mjs";
import { declaredOrigin } from "./declarations.mjs";
import { digest, fail, text } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").NativeCall} Check */
/** @typedef {Pick<typeof import("./historical.mjs"),"readHistorical"|"approvalEvidence"|"priorWriters"|"priorPublications"|"validHistory">} Archive */
/** @typedef {{recipe:NonNullable<Check["verification"]>,publish:ReturnType<ReturnType<typeof openLedger>["publisher"]>,guard:()=>void,
 * deadline?:string,batch?:Pick<import("./cache.mjs").Batch,"group"|"prior">,pin:{commit:string,check:string,evaluatorRevision?:string,productEvaluatorRevision?:string}}} Command */

/** Read only the prerequisites named by this attempt; no receipt enters the stored graph.
 * @param {ReturnType<typeof openLedger>} store @param {Run} r @param {Check} e @param {Archive} [archive] */
function witnessed(store,r,e,archive){
	let projected=r;
	for(const f of e.attempt?.version===3?e.attempt.facts:[]){
		if(f.kind!=="signed")continue;
		const i=r.effects.findIndex(c=>c.id===f.check),prior=r.effects[i];
		const row=store.journal()?.db.prepare("SELECT document,signature FROM outcomes WHERE run=? AND effect=?").get(r.id,f.check);
		if(prior?.tool!=="bash" || prior.kind!==f.use || prior.commit!==f.commit || !prior.runnerStarted || !prior.runnerClaim || !prior.callId ||
			!["issued","uncertain","done"].includes(prior.state) || !row || typeof row.signature!=="string" || typeof row.document!=="string")
			fail("missing_receipt","Required original signed result is unavailable");
		const decode=i<(r.historicalPrefix?.length??0)?archive?.readHistorical:prior.attempt?.version===3?readCurrent:undefined;
		if(!decode)fail("missing_receipt","No historical evidence for the declared prerequisite");
		const receipt=decode(r.id,prior,row.signature,row.document);
		if(receipt.exit!==f.exit)fail("wrong_outcome","Prerequisite no longer proves the required outcome");
		if(!prior.receipt){
			if(projected===r)projected={...r,effects:[...r.effects]};
			projected.effects[i]={...prior,state:"done",receipt};
		}
	}
	return projected;
}

/** Never plan or write the graph from the evaluator. Its only run mutation sets
 * its own claim in the stored row, not a view hydrated with spool results.
 * @param {string} cwd @param {string} id @param {string} job */
export function openClaims(cwd,id,job){
	const file=ledgerPath(cwd),store=openLedger(file);
	function read(){
		store.verify();
		const row=store.db.prepare("SELECT owner,document,checksum FROM runs WHERE id=?").get(id);
		if(!row || typeof row.document!=="string" || checksum(row.document)!==row.checksum)fail("corrupt_run","Missing or altered original run");
		const doc=JSON.parse(row.document);
		if(!doc || doc.id!==id || doc.owner!==row.owner || !Array.isArray(doc.effects) ||
			doc.effects.some((/** @type {Check} */ c)=>!c || typeof c.id!=="string" || !c.args || typeof c.args!=="object") ||
			new Set(doc.effects.map((/** @type {Check} */ c)=>c.id)).size!==doc.effects.length)fail("corrupt_run","Invalid original dispatch identities");
		/** @type {Check|undefined} */ const e=doc.effects.find((/** @type {Check} */ c)=>c.id===job);
		if(e?.tool!=="bash")fail("unissued_check","Not a recorded evaluator");
		if(e.attempt?.version!==3){
			if(!(doc.format===undefined && e.attempt===undefined && Object.hasOwn(doc,"nodes") ||
				["foundry-run/2","foundry-run/3"].includes(doc.format) && (e.attempt?.version===1 || e.attempt?.version===2)))
				fail("corrupt_run","Unknown check edition");
			return {old:true,doc,e};
		}
		if(doc.format!=="foundry-run/3" || Object.hasOwn(doc,"nodes") || !doc.graph?.nodes || Object.keys(doc.graph).length!==1 ||
			!doc.history || typeof doc.history!=="object" || Array.isArray(doc.history) ||
			(doc.reviewContract==="required"?!Array.isArray(doc.inspections):doc.reviewContract!=="legacy-no-review" || "inspections" in doc) ||
			doc.policy?.id!==id || !Array.isArray(doc.products) || !Array.isArray(doc.policy.squads) || typeof doc.active!=="boolean")
			fail("corrupt_run","Incompatible current claim envelope");
		const {format,reviewContract,graph,...data}=doc;
		/** @type {Run} */ const run={...data,nodes:graph.nodes};
		if(!editionBoundary(run))fail("corrupt_run","Invalid historical journal boundary");
		return {old:false,doc,e,run,sum:row.checksum};
	}
	/** @param {Check} e */
	const subject=e=>digest([e.issuer,e.callId,e.args,e.attempt,e.verification]);
	/** @param {Run} r @param {Check} e */
	const held=(r,e)=>r.policyHold || e.permissionHold;
	/** @param {Archive} [archive] @returns {Command} */
	function claim(archive){
		/** @param {Run} r @param {Check} c @param {string} [root] */
		const source=(r,c,root)=>declaredOrigin(r,c,archive?.approvalEvidence(r,c,root),root,archive?.priorWriters(r,c),archive?.priorPublications(r,c));
		for(;;){
			const planned=read(),prior=planned.run,issued=planned.e;
			if(!prior || !issued.verification || issued.attempt?.version!==3 || !exactRunner(prior,issued,cwd))fail("unissued_check","Not the original current command");
			const checked=witnessed(store,prior,issued,archive);
			verifyClaim(cwd,checked,issued,source(checked,issued,cwd));
			const latch={committed:false};
			const operation=store.write(()=>{
				const {run,e,doc,sum}=read();
				if(sum!==planned.sum)return;
				if(!run || e.attempt?.version!==3 || !e.verification)fail("unissued_check","The original check is not current");
				if((run.historicalPrefix?.length || e.attempt.previous) && !archive?.validHistory(run))fail("corrupt_run","Missing original historical closure binding");
				if(held(run,e) || e.error && e.state!=="uncertain")fail("dispatch_held","The original assessment is paused or held");
				if(store.journal()?.db.prepare("SELECT 1 FROM outcomes WHERE run=? AND effect=?").get(id,job))fail("unissued_check","An outcome already occupies this slot");
				const verified=witnessed(store,run,e,archive),original=subject(e);
				sampleLive(cwd,verified,e,source(verified,e));
				const batch=preparationGroup(verified,e.attempt),publish=store.publisher(id,job,claimOutcome(id,e),latch);
				const document=JSON.stringify(doc);
				if(store.db.prepare("UPDATE runs SET document=?,checksum=? WHERE id=?").run(document,checksum(document),id).changes!==1)
					fail("unissued_check","Original claim did not commit");
				const guard=()=>{
					const {run:later,e:claimed}=read();
					if(!later || held(later,claimed) || claimed.runnerClaim!==e.runnerClaim || subject(claimed)!==original)
						fail("stale_assignment","The original protected step is no longer authorized");
					const fresh=witnessed(store,later,claimed,archive);
					sampleLive(cwd,fresh,claimed,source(fresh,claimed));
				};
				return {recipe:e.verification,publish,batch,guard,deadline:run.policy.deadline,pin:{
					commit:text(e.commit,"reserved commit"),check:text(e.check,"reserved evaluator"),...(e.evaluatorRevision && {evaluatorRevision:e.evaluatorRevision}),
					...(e.productEvaluatorRevision && {productEvaluatorRevision:e.productEvaluatorRevision})}};
			});
			if(operation){latch.committed=true;return operation;}
		}
	}
	return {file,close:store.close,mode(){
		const {old,run}=read();return old?"historical":run?.historicalPrefix?.length?"mixed":"current";
	},claim};
}
