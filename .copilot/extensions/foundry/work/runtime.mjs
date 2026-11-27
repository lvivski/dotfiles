import { journeyText, readPolicy } from "./brief.mjs";
import { randomUUID } from "node:crypto";
import { describeNewChecks } from "./description.mjs";
import { workflowIdentity } from "./workflow.mjs";
import { assign, frozenSubmission } from "./assignment.mjs";
import { activate, holdFor, permitted } from "./activity.mjs";
import { adoptionBase, exactForm, planAdoption, presentAdoption, proposalForm, requestedAdoption } from "./adoption.mjs";
import { preparePatch } from "./patch.mjs";
import { prepareRollout } from "./rollout.mjs";
import { pendingAdoption } from "./offers.mjs";
import { planOffers, selectedEvaluator } from "./offering.mjs";
import { selectDraft } from "./commission.mjs";
import { draftDispatcher, nextAuthor } from "./authors.mjs";
import { formDelivery } from "./forms.mjs";
import { claimRepair, holdRepair, planMending, queuedMechanic, queueMechanic, repairAnswer, repairCurrent, repairPacket, repairPermitted } from "./mending.mjs";
import { repairTip } from "./calibration.mjs";
import { auditor } from "./auditor.mjs";
import { boundInspections, inspectionWakes, publicationSample, readyInspections, requireChangedReview } from "./inspections.mjs";
import { awaitingReply, journal, survey, unissued } from "./dispatch.mjs";
import { existsSync, readFileSync } from "node:fs";
import { preparePublication, reportedReferences, verifySource } from "./artifacts.mjs";
import { grantFor, recoveryRules } from "./grants.mjs";
import { dispatches, instructionPermitted, queueInstructions } from "./instructions.mjs";
import { frozenCheckpoint } from "./frozen.mjs";
import { recordDiagnostic } from "./diagnostics.mjs";
import { attribute } from "./blockers.mjs";
import { childProof, grainForToken, issuerProof, linkedGeneration, reservation, verifyGeneration } from "./binding.mjs";
import { openDatabase, ledgerPath } from "./database.mjs";
import { contractHold } from "./contract.mjs";
import { unprovenExports } from "./attestation.mjs";
import { activeDelivery } from "./batch.mjs";
import { presentQuestions } from "./decisions.mjs";
import { advance, currentReview, newRun, reserveChangedRepair, reserveIteration, retryableReview, sameReviewInputs } from "./graph.mjs";
import { changedFrom, changeOffer, comparisonGoal, comparisonVerdict, goalReceipt, inconclusiveRepair, latestRepair, mixedVerification, qualifiedProduct, relinquishable, stopForInput, verificationSource } from "./evidence.mjs";
import { checkpointSurvey, movingSurvey, observeTarget, releaseAssessment } from "./goal.mjs";
import { admitted, assignment, boundWriter, canDispatch, current, expired, identify, issue, policySubject, receive, reserveCheck } from "./native.mjs";
import { checked, writerVersion } from "./lineage.mjs";
import { attachNotes, queueNote } from "./notes.mjs";
import { diagnosticLine, indexBudgetError } from "./pages.mjs";
import { configure } from "./policy.mjs";
import { chooseWriters } from "./pool.mjs";
import { acceptWorkspace, writerRoot } from "./workspace.mjs";
import { capture, changedFiles, commitAt, contractConflict, directoryBaseline, generationRoot, regularFiles, retain, rootAt, treeOf, verifyContracts } from "./product.mjs";
import { recoveredCalls, refusedCall } from "./recovery.mjs";
import { checkAuthority, prepareRecheck } from "./recheck.mjs";
import { prepareRerun } from "./rerun.mjs";
import { prepareRepin } from "./repin.mjs";
import { prepareResume, reassessHandoff, resumable } from "./resume.mjs";
import { reconcileWake } from "./reconciliation.mjs";
import { transferRequest } from "./transfer.mjs";
import { stoppedCheck, successorRequest } from "./successor.mjs";
import { reportReceiver } from "./reports.mjs";
import { retireGoal } from "./retirement.mjs";
import { deliveryTip, inputBlob } from "./resupply.mjs";
import { requestedSource } from "./supplier.mjs";
import { currentPair, preparePair } from "./pairing.mjs";
import { observerBasis, observerWriter, verifyObserver } from "./observer.mjs";
import { productionBasis, submitProduction } from "./production.mjs";
import { productionWriter, remedyWriter } from "./remedy.mjs";
import { referenceText } from "./research.mjs";
import { comparison, investigation, reviews, staleReaderMessage } from "./charter.mjs";
import { blockReview, currentPin, questions, reserveReview, retireSuperseded } from "./reviews.mjs";
import { scoutPacket } from "./scouts.mjs";
import { recoveryStatus, status as projectStatus } from "./status.mjs";
import { FoundryError, assignmentDirectory, digest, fail, fields, mixed, name, record, referenceRepo, relative, text, roots as scopePaths } from "./values.mjs";
import { boardFacts, visible } from "./visibility.mjs";
import { contention, persist, receiptClock, receiptWakes } from "./wakes.mjs";
import { supervise } from "./supervision.mjs";
import { watchState, workflow } from "./rules/supervision.mjs";
import { transition } from "./machine.mjs";
import { executor } from "./adapter.mjs";
import { attachedLegacy, exactRunner } from "./abi.mjs";
import { continueChecks } from "./cutover.mjs";

const readerFile = new URL("./reader.version", import.meta.url);
const loadedReader = readFileSync(readerFile, "utf8");
function requireCurrentReader() {
	try {
		if (readFileSync(readerFile, "utf8") === loadedReader) return;
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	fail("stale_reader", staleReaderMessage);
}

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Effect} Effect */
/** @typedef {import("./model.js").Inspection} Inspection */
/** @typedef {{run:string,id:string,actor:string,inFlight?:boolean,recoveredOn?:number}} Call */
/** @typedef {import("./auditor.mjs").Envelope} ScoutEnvelope */
/** @typedef {{execute:(tool:string,args:Effect["args"],id:string)=>Promise<unknown>,notify:(message:string)=>Promise<string>,recover?:(effect:Effect)=>Promise<unknown>,
 * ask?:(message:string)=>Promise<string|null>,confirm?:(message:string)=>Promise<boolean>,adopt?:(message:string)=>Promise<string|null>,autoConfirm?:()=>Promise<boolean>,
 * confirmProposal?:(message:string)=>Promise<boolean>,formVacant?:()=>Promise<boolean>,formIdle?:()=>Promise<boolean>,
 * repairAgent?:(phase:import("./mending.mjs").Phase,packet:import("./mending.mjs").Packet,ticket:import("./mending.mjs").Ticket)=>Promise<import("./mending.mjs").Answer>,
 * repairState?:(workflow:string,ticket:import("./mending.mjs").Ticket)=>Promise<import("./mending.mjs").Answer>,
 * draftAgent?:(ticket:import("./author.mjs").Ticket)=>Promise<import("./auditor.mjs").Envelope>,draftState?:(id:string)=>Promise<import("./auditor.mjs").Envelope>,
 * readHistory?:import("@github/copilot-sdk").CopilotSession["rpc"]["eventLog"]["read"],isResearcher?:(workflowId:string,agentId:string)=>Promise<boolean>,
 * scoutBudget?:()=>Promise<number>,scoutFailure?:(workflowId:string,label:string)=>Promise<string|undefined>,confirmNoReport?:(r:import("./model.js").Review)=>Promise<void>,
 * scout?:(run:string,dispatch:string,actor:string)=>Promise<ScoutEnvelope>,scoutState?:(workflowId:string)=>Promise<ScoutEnvelope>,
 * startInspection?:import("./auditor.mjs").StartInspection,inspectionState?:(workflowId:string)=>Promise<import("./auditor.mjs").Envelope>,
 * scoutSnapshot?:(workflowId:string)=>Promise<ScoutEnvelope>,resumeScout?:(workflowId:string)=>Promise<ScoutEnvelope>,
 * mode:()=>Promise<string>,idleWriter?:(id:string)=>Promise<string|undefined>,runningHelpers?:(workflows:string[])=>Promise<string[]>,permissionBlocker:()=>Promise<import("./permissions.mjs").PermissionBlock|null>,log?:(message:string)=>void,watchReceipts?:typeof receiptClock,watchRecovery?:typeof receiptClock}} Host */
/** @param {Run} run @param {string} actor @param {string} token @param {unknown} [from] */
function writable(run, actor, token, from) {
	admitted(run);
	const node = boundWriter(run, actor, token);
	if (from !== undefined) {
		if (from !== changedFrom(node, run.effects.find(e => e.id === node.check)))
			fail("stale_assignment", "Not the bound writer's current blocked, unclassified component attempt");
		return node;
	}
	if (frozenSubmission(node) || checked(node)) return;
	if (node.state !== "writing") fail("stale_assignment", "This attempt is no longer writable");
	const notice=latestRepair(run,node);
	if (notice?.baseline && notice.state !== "done") fail("dispatch_held", "Await confirmed delivery of the approved baseline to the original writer");
	if (notice?.input && (notice.state!=="done" || notice.error || !notice.callId))
		fail("dispatch_held","Await confirmed delivery of the selected reference to the original writer");
	const review=run.effects.find(e=>e.id===node.review);
	if (review?.kind==="scout" && review.correction?.ordinary && review.correction.resumed?.token===token &&
		!run.effects.some(e=>e.kind==="repair" && e.grain===node.grain.id && e.token===token && e.state==="done" && !e.error))
		fail("dispatch_held","Await confirmed delivery of the corrected task to the original writer");
	return node;
}

/** @param {Run} run @param {string} ticket @param {string} actor */
const batchOf = (run, ticket, actor) => reviews(run).filter(e => e.callId === ticket && e.issuer === actor);
/** @param {import("./model.js").Review} e */
const needsContinuation=e=>e.state==="suspended" && e.providerRecovery==="needed";
/** @param {Effect} e */
const externalReply=e=>(e.tool==="create_session" || e.tool==="send_session_message" || e.tool==="bash" && attachedLegacy(e)) && awaitingReply(e) && !!e.callId;
/** @param {unknown} error */
const transientStatus=error=>contention(error) || error instanceof Error && "code" in error &&
	(error.code==="ETIMEDOUT" || error.code==="ECONNRESET");
// workflow.run rejects before creating a run when the session is full. Match only
// that admission error, including its persisted form from earlier readers.
const capacityRejection = /^Discovery unconfirmed: Error: This session already has [1-9]\d* active workflow runs, which is the concurrent limit\. Resume to retry unbound discovery\.$/;
const waitingForSlot = "Queued for workflow capacity; the issuing session will retry automatically.";
/** @param {string} id @param {string} actor */
const issuerKey=(id,actor)=>JSON.stringify([id,actor]);
/** @param {import("./model.js").Review} e */
function requeueCapacity(e) {
	if (e.state !== "uncertain" || !e.callId || e.workflowId || !capacityRejection.test(e.error ?? "")) return false;
	survey(e,{type:"requeue",error:waitingForSlot});
	return true;
}
/** @param {string} directory @param {Host} host @param {import("./machine.mjs").Machine} [rules] Trusted edition, never a project or tool input. */
export function createRuntime(directory, host, rules) {
	const recovery=recoveryRules(rules,!!host.draftAgent);
	/** @type {ReturnType<typeof openDatabase>|undefined} */ let database;
	let root, closed = false, outsideRepository = false, turnNumber = 0;
	const lifetime=new AbortController();
	/** @template T @param {()=>T|Promise<T>} write */
	const recordReply=write=>persist(write,lifetime.signal,error=>host.log?.(`Foundry is waiting to record an original reply: ${String(error)}`));
	/** @type {Set<string>} */ const known = new Set();
	/** @type {Set<Promise<unknown>>} */ const background = new Set();
	/** @type {Set<{run:string,actor:string,token:string}>} */ const submitting = new Set();
	/** @type {Set<string>} */ const asking = new Set();
	const forms=formDelivery(host);
	/** @type {Set<string>} */ const mendingCalls=new Set();
	/** @type {Map<string,Call>} */ const nativeCalls = new Map();
	/** @type {Map<string,Map<string,()=>Promise<void>>>} */ const scoutCalls = new Map();
	/** @type {Map<string,NodeJS.Timeout>} */ const capacityWakes = new Map();
	/** @type {Set<string>} */ const continuing = new Set();
	/** @type {Map<string,{discover:boolean,recover:boolean,work:Promise<void>}>} */ const wakes = new Map();
	/** @type {string|undefined} */ let existingPath;
	const cwd = () => root ??= rootAt(directory);
	/** @param {Run} run @param {string} actor */
	const reservations=(run,actor)=>dispatches(run).filter(e=>e.issuer===actor && unissued(e) && policySubject(run,e,cwd()));
	/** @param {Run} run @returns {import("./instructions.mjs").Tip} */
	function instructionPins(run){
		/** @type {ReturnType<typeof observeTarget>|undefined} */ let observed;
		/** @type {string|null|undefined} */ let prior;
		return frozen=>{
			const tip=(observed??=observeTarget(()=>commitAt(cwd(),run.policy.target))).target;
			if(!frozen || !tip)return tip;
			if(prior===undefined){
				try{prior=frozenCheckpoint(cwd(),run,tip)?.target??null;}
				catch(e){if(!(e instanceof FoundryError) || e.code!=="contract_changed")throw e;prior=null;}
			}
			return prior??undefined;
		};
	}
	/** @param {Run} run @param {string} actor @param {unknown} [detail] */
	const status=(run,actor,detail)=>projectStatus(run,actor,detail,instructionPins(run),
		detail==="proof" && run.owner===actor?{cwd:cwd(),verify:e=>db().verifySigned(run.id,e)}:undefined,cwd());
	const file = () => existingPath ??= ledgerPath(directory);
	function hasLedger() {
		if (outsideRepository) return false;
		try { return !!database || existsSync(file()); }
		catch (e) {
			if (!(e instanceof Error && "stderr" in e && String(e.stderr).includes("not a git repository"))) throw e;
			outsideRepository = true;
			return false;
		}
	}
	async function executable() {
		if (closed) return false;
		const mode = await host.mode();
		return !closed && (mode === "interactive" || mode === "autopilot");
	}
	async function observerExecutable(){
		try{return await executable();}
		catch(error){
			if(!transientStatus(error))throw error;
			host.log?.(`Foundry cannot verify the issuer's execution mode yet: ${String(error)}`);
			return false;
		}
	}
	/** @param {boolean} [create] */
	function db(create = false) {
		if (closed)
			fail("runtime_closed", "Foundry is closed");
		return database ??= openDatabase(cwd(), file(), create, requireCurrentReader,describeNewChecks);
	}
	/** @param {string} id */
	const read = id => db().read(id) ?? fail("missing_run", `Unknown run ${id}`);
	/** @param {(message:string)=>Promise<string|null>} adopt @param {()=>Promise<void>} wake */
	const approvalHost=(adopt,wake)=>({cwd:cwd(),store:db,closed:()=>closed,executable:observerExecutable,permissionBlocker:host.permissionBlocker,persist:recordReply,idle:forms.idle,adopt,wake});
	/** Settlement continues the submitted work; it does not request another fixed-charter survey.
	 * @param {string} id @param {string} actor */
	const receiptWake=(id,actor)=>track(drive(id,actor,false,false));
	const inspector=auditor({start:host.startInspection,lookup:host.inspectionState??host.scoutState,budget:host.scoutBudget,
		cwd,read,mutate:(id,fn)=>db().mutateLocked(id,fn),reserve:(id,fn)=>db().reserve(id,fn),
		tip:run=>observeTarget(()=>commitAt(cwd(),run.policy.target)).target,persist:recordReply,closed:()=>closed,
		verifySigned:(id,c)=>db().verifySigned(id,c),
		track,log:host.log,queue:wakeCapacity,wake:receiptWake,executable,permissionBlocker:host.permissionBlocker});
	const authors=draftDispatcher({cwd,store:db,closed:()=>closed,permitted:async()=>await executable() && !await host.permissionBlocker() && await executable(),
		start:host.draftAgent,observe:host.draftState,resume:host.resumeScout,budget:host.scoutBudget,persist:recordReply,queued:(id,actor)=>capacityWakes.has(issuerKey(id,actor)),
		queue:wakeCapacity,wait:(id,actor)=>supervisor.observe(id,actor,gate(read(id),actor,false,"issuer-permission")),wake:(id,actor)=>drive(id,actor,false,false)});
	const receipts = receiptWakes({ read, stamp: id => db().stamp(id), clock: host.watchReceipts ?? receiptClock,
		wake:receiptWake, log: error => host.log?.(`Foundry receipt observer: ${String(error)}`) });
	/** @param {Run} run @param {string} actor @param {boolean} [missing] @param {import("./supervision.mjs").Gate} [previous] @returns {import("./supervision.mjs").Observation} */
	function gate(run,actor,missing=false,previous) {
		if(contractHold(run))return {state:"dormant",ref:run.policy.target,pending:false};
		forms.attach(run,actor);
		const hold=run.policyHold, own=dispatches(run).filter(e=>e.issuer===actor);
		const inspection=inspectionWakes(run,actor,previous==="issuer-permission");
		const unfinished=run.active && own.some(e=>e.kind==="scout" && needsContinuation(e));
		const ownerWork=previous==="issuer-permission" && run.active && actor===run.owner &&
			(recovery.select(run).size>0 || !!nextAuthor(run) || reviews(run).some(r=>r.renewal?.state==="needed") || run.testRepairs?.some(j=>!["held","applied","product","unobserved"].includes(j.state)) ||
				!!host.ask && questions(run).some(r=>!r.decision) || !!proposalForm(host,pendingAdoption(run)));
		// A paused issuer may still own an unissued reservation. Observe the owner's
		// later resume, without treating a readable policy as permission to undo a pause.
		const participant=!!(run.active || hold) && run.owner===actor || own.some(e=>awaitingReply(e) || unissued(e) && current(run,e)) || inspection.participant;
		const state=watchState({expired:expired(run),managed:!run.active && hold?.issuer===actor,
			local:ownerWork || inspection.local || own.some(e=>!!e.permissionHold && unissued(e) && policySubject(run,e)) || unfinished && previous==="issuer-permission",
			retryRead:unfinished && previous==="workflow-status",
			missing:run.active && participant && missing,formDue:!!forms.current(run,actor) ||
				actor===run.owner && !!host.formIdle && !!proposalForm(host,pendingAdoption(run)),participant});
		const pending=!!host.recover && run.active && !expired(run) && own.some(externalReply) ||
			inspector.canObserve && inspection.pending;
		return {state,ref:run.policy.target,pending,...(state==="managed-policy" && {token:hold?.token})};
	}
	/** @param {string} id @param {string} actor @param {string} token */
	function reactivate(id,actor,token) {
		db().mutateLocked(id,run=>{
			if (!expired(run)) permitted(run,actor,token);
		});
	}
	/** Re-read original calls independently. Neither a missing history row nor the wake itself can issue a call.
	 * @param {string} id @param {string} actor @param {string} [only] */
	async function readCompletions(id,actor,only) {
		const recover=host.recover;
		// Looking up a bound workflow is observation, including through a pause or plan
		// mode. Its receipt wakes separate, permission-checked planning.
		if(closed)return;
		const run=read(id);
		if(contractHold(run))return;
		if (!only && inspector.canObserve)inspector.observe(run,actor);
		if ((!recover && (only || !host.scoutState)) || !await observerExecutable()) return;
		const workflows=only?undefined:supervisor.statusReads(id,actor);
		if (!run.active || expired(run)) {workflows?.clear();return;}
		if(workflows)for(const [ticket,workflow] of workflows){
			if(batchOf(run,ticket,actor).some(e=>e.workflowId===workflow && awaitingReply(e)))observeWorkflow(id,ticket,actor,workflow);
			else workflows.delete(ticket);
		}
		const jobs=dispatches(run).filter(e=>externalReply(e) && e.issuer===actor && e.callId &&
			(!only || e.callId===only) && !nativeCalls.get(e.callId)?.inFlight);
		await observeCalls(id,jobs,()=>!closed?drive(id,actor,true,false):undefined);
	}
	/** @param {string} id @param {Effect[]} jobs @param {()=>void|Promise<void>} refill */
	async function observeCalls(id,jobs,refill){
		const recover=host.recover;if(!recover || !jobs.length)return;
		/** @type {Map<Effect,(r:unknown)=>void>} */const replies=new Map();
		const read=jobs.length>1 && host.readHistory;
		const work=jobs.map(e=>resolveCall(id,e,text(e.callId,"original call"),()=>!read?recover(e):
			new Promise(resolve=>replies.set(e,value=>resolve(value instanceof Error?{resultType:"unconfirmed",error:String(value)}:value))))
			.then(done=>done && refill()));
		const scan=read && recoveredCalls(read,jobs,(e,value)=>replies.get(e)?.(value))
			.catch(error=>{for(const reply of replies.values())reply(error);});
		await Promise.all([...work,scan]);
	}
	const supervisor=supervise({
		clock:host.watchRecovery ?? receiptClock,track,stamp:id=>db().stamp(id),
		sample:(id,actor,previous)=>gate(read(id),actor,previous==="missing-target",previous),
		tip:ref=>observeTarget(()=>commitAt(cwd(),ref)).target,
		permitted:async()=>await observerExecutable() && !await host.permissionBlocker() && await observerExecutable(),
		presentable:async(id,actor)=>{
			if(asking.has(id) || !await observerExecutable() || await host.permissionBlocker() || !await forms.idle())return false;
			const run=read(id);
			return actor===run.owner && !!pendingAdoption(run) || forms.vacant(forms.current(run,actor));
		},
		lookup:readCompletions,
		wake:async(id,actor,token)=>{
			if (!await observerExecutable()) return false;
			if (token) reactivate(id,actor,token);
			track(drive(id,actor,true)); // Sampling is independent of any slow native lookup or permission dialog in this dispatch.
			return true;
		},retryRead:contention,log:error=>host.log?.(`Foundry recovery observer: ${String(error)}`),
	});
	/** @param {string} actor */
	const writerSession = actor => known.has(actor) || hasLedger() && db().isWriter(actor);
	/** @param {string} id @param {(run:Run)=>(()=>boolean)|void} mutate */
	function change(id, mutate) {
		return db().planAndSwap(id, run => {
			const count = run.products.length, final = qualifiedProduct(run),join=run.join?.check;
			const renewed = () => reviews(run).filter(r=>r.renewal?.state==="approved" && r.state==="observed").length;
			const prior = renewed();
			const valid=mutate(run);
			if (run.products.length !== count || qualifiedProduct(run) !== final)
				return () => (!valid || valid()) && observeTarget(() => commitAt(cwd(), run.policy.target)).target === run.products.at(-1)?.target;
			if(run.join && run.join.check!==join && mixedVerification(run,run.join.check))
				return ()=>!expired(run) && (!valid || valid()) && observeTarget(()=>commitAt(cwd(),run.policy.target)).target===run.join?.target;
			if (renewed()!==prior)
				return () => (!valid || valid()) && observeTarget(() => commitAt(cwd(),run.policy.target)).target === run.goal?.target;
			return valid;
		});
	}
	/** Use the same permission gate for prepared calls and explicit checks, without waking planning.
	 * @param {string} id @param {string} actor @param {Effect[]} batch */
	async function dispatchBlocker(id, actor, batch) {
		/** @type {{batch:Effect[],reason:string|null}} */ const check={batch,reason:null};
		await reconcile(id,actor,false,false,check);
		return check.reason;
	}
	/** Dispatch just the affected thread notices without turning an inspection or preview into an ordinary scheduling wake.
	 * @param {string} id @param {string} actor */
	async function inform(id,actor){
		const queued=db().planAndSwap(id,r=>queueInstructions(r,actor));
		const due=reservations(queued,actor).filter(e=>e.kind==="instruction" && e.state==="ready");
		if(due.length && await dispatchBlocker(id,actor,due)===null)for(const e of due)await dispatchCall(id,e);
		return status(read(id),actor);
	}
	/** Commit a selected hold change only if the sampled issuer still has the same reservation.
	 * @param {string} id @param {string} actor @param {Effect[]} batch @param {Inspection[]} inspecting @param {string|null} message @param {boolean} managed */
	function recordBatchPolicy(id,actor,batch,inspecting,message,managed) {
		const expected = new Map(batch.map(e => [e.id, e.state]));
		const result = db().mutateLocked(id, run => {
			const live = reservations(run, actor);
			const subjects=readyInspections(run,actor,inspecting);
			const anchor=live.find(e=>expected.get(e.id)===e.state) ?? subjects[0];
			if (!anchor) return;
			const selected=[...live,...subjects],changed=message && selected.some(e=>e.permissionHold!==message);
			for (const e of selected) {
				if (message) e.permissionHold = message;
				else delete e.permissionHold;
			}
			if (managed && run.active && message) { holdFor(run,anchor,message); return { state: "paused", message }; }
			return { state: changed ? "held" : undefined, message };
		});
		if (!result) return "The reservation changed or the run is already paused. Check foundry_status.";
		const observed=read(id);
		supervisor.observe(id,actor,gate(observed,actor));
		if (result.state) host.log?.(`Foundry ${id} ${result.state}: ${result.message}`);
		return result.message;
	}
	/** @param {Call} ctx @param {string} callId @param {unknown} result @param {boolean} [automatic] */
	async function settle(ctx, callId, result, automatic = false) {
		if (closed) return;
		const terminal = await recordReply(()=>db().mutateLocked(ctx.run, run => {
			const e = dispatches(run).find(x => x.id === ctx.id);
			if (!e || e.tool === "workflow" || e.callId !== callId || e.issuer !== ctx.actor || !awaitingReply(e)) return true;
			try {
				receive(run, e, result, automatic);
			} catch (error) {
				journal(e,{type:"unconfirmed",error:String(error)});
			}
			return !awaitingReply(e);
		}));
		if (terminal) nativeCalls.delete(callId);
		return terminal;
	}
	/** @param {string} id @param {Effect} e @param {string} callId @param {()=>Promise<unknown>} invoke @param {boolean} [automatic] */
	async function resolveCall(id, e, callId, invoke, automatic = false) {
		const ctx = { run: id, id: e.id, actor: e.issuer, inFlight: true, recoveredOn: automatic ? undefined : turnNumber };
		nativeCalls.set(callId, ctx);
		try {
			let result;
			try { result = await invoke(); }
			catch (error) { result = { resultType: "unconfirmed", error: String(error) }; }
			return await settle(ctx, callId, result, automatic);
		} finally { ctx.inFlight = false; }
	}
	/** New tool calls have one journal-before-I/O path. Recovery only observes the original call.
	 * @param {string} id @param {Effect} e @param {()=>void} [onClaim] */
	function dispatchCall(id,e,onClaim){
		const callId=randomUUID();
		if(closed || !claim(id,e,callId))return;
		onClaim?.();
		return resolveCall(id,e,callId,()=>e.tool==="session.send"?
			host.notify(text(e.args.message,"session notice")).then(messageId=>({resultType:"success",messageId})):
			host.execute(e.tool,e.args,callId),true);
	}
	/** A new scoped review and an existing ready batch use the same committed native
	 * ticket. A different target or a lost ledger race cannot leak into this launch.
	 * @param {string} id @param {string} actor
	 * @param {import("./model.js").Review[]|((r:Run)=>import("./model.js").Review|undefined)} selection */
	function dispatchScouts(id,actor,selection){
		const ticket=randomUUID();
		const issued=db().reserve(id,r=>{
			if(typeof selection!=="function")return selection.filter(e=>issue(r,e,ticket)).length?{value:true}:undefined;
			const e=selection(r);
			if(!e)return;
			if(!issue(r,e,ticket))fail("stale_assignment","Cannot issue the selected charter review");
			const tip=r.goal?.target;
			return {value:true,guard:tip?()=>commitAt(cwd(),r.policy.target)===tip:undefined};
		});
		if(issued)watchScouts(id,ticket,actor,()=>host.scout?.(id,ticket,actor)??Promise.reject(new Error("Workflow scouting is unavailable")));
	}
	/** @param {string} id @param {Effect} effect @param {string} callId */
	const claim = (id, effect, callId) => {
		/** A protected reservation can refuse, authorize on immutable inputs, or require a
		 * final synchronous pin check. A CAS retry never reuses the previous decision.
		 * @param {(r:Run)=>boolean|(()=>boolean)} verify */
		function planned(verify){
			return db().reserve(id,r=>{
				const guard=verify(r);
				if(guard && issue(r,effect,callId,cwd()))return {value:true,guard:typeof guard==="function"?guard:undefined};
			})===true;
		}
		if(effect.kind==="escalation")return planned(r=>{
			const unchanged=()=>!closed && !expired(r) && !!r.goal && observeTarget(()=>commitAt(cwd(),r.policy.target)).target===r.goal.target;
			return unchanged() && unchanged;
		});
		if(effect.kind==="instruction")return planned(r=>{
			const pins=instructionPins(r);
			if(closed || expired(r) || !instructionPermitted(r,effect.instruction,pins))return false;
			const sampled=pins();
			return ()=>!closed && !expired(r) && observeTarget(()=>commitAt(cwd(),r.policy.target)).target===sampled;
		});
		if(effect.kind==="repair" && (effect.input || effect.continuation) && unissued(effect))return planned(r=>{
			const e=r.effects.find(e=>e.id===effect.id);
			if(e?.kind!=="repair" || !e.grain || !unissued(e) || !canDispatch(r,e))return false;
			const tip=deliveryTip(cwd(),r,e,job=>db().verifySigned(id,job));
			return !!tip && (()=>!closed && !expired(r) && observeTarget(()=>commitAt(cwd(),r.policy.target)).target===tip);
		});
		if(effect.kind==="control" || effect.tool==="bash" && effect.testPin)return planned(r=>{
			const j=r.testRepairs?.find(j=>j.stop===(effect.calibration?.stop??effect.testPin));
			const tip=j && (effect.kind==="control"?repairCurrent(cwd(),r,j):j.recheck===effect.id && repairTip(cwd(),r,j));
			return !!tip && repairPermitted(r) && (()=>!closed && !expired(r) && commitAt(cwd(),r.policy.target)===tip);
		});
		const pinnedProduct=effect.kind==="product" && effect.evaluatorRevision;
		if (effect.tool==="workflow" || !(pinnedProduct || effect.rollout || effect.replacement || effect.recheck || effect.pair || effect.observer || effect.isolation || effect.production || effect.remedy) || !unissued(effect)) return db().mutateLocked(id, run => issue(run, effect, callId));
		return planned(run=>{
			let target=(effect.recheck??effect.pair)?.target;
			const source=pinnedProduct && verificationSource(run,effect.id),mixed=pinnedProduct && mixedVerification(run,effect.id);
			const original=source && source!==effect.id && run.products.find(p=>p.check===source);
			if (effect.isolation || mixed || original || effect.replacement || effect.rollout) {
				target=original?original.target:mixed?mixed.revision:effect.rollout || effect.replacement?changeOffer(run,effect)?.revision:run.independent?.target;
				if(target!==commitAt(cwd(),run.policy.target) || run.effects.some(x=>x.permissionHold))return false;
			} else if (effect.production || effect.remedy) {
				const job=effect.production?effect:remedyWriter(run,effect);
				if (!job) fail("stale_assignment","Missing production repair binding");
				target=productionBasis(cwd(),run,job,effect.commit).target;
			} else if (effect.observer) {
				target=effect.kind==="component" ? verifyObserver(cwd(),run,effect,text(effect.commit,"observer candidate"),true) :
					observerBasis(cwd(),run,effect).pair.target;
			} else if(effect.pair ? !currentPair(cwd(),run,effect) : effect.recheck && !checkAuthority(cwd(),run,effect))return false;
			return !target || (()=>!expired(run) && observeTarget(()=>commitAt(cwd(),run.policy.target)).target===target);
		});
	};
	/** Merge wakeups for one issuer, never its in-flight calls or permission dialogs.
	 * @param {string} id @param {string} actor @param {boolean} [discover] @param {boolean} [recover] @returns {Promise<void>} */
	function drive(id, actor, discover = false, recover = true) {
		const key = issuerKey(id,actor), prior = wakes.get(key);
		if (prior) { prior.discover ||= discover; prior.recover ||= recover; return prior.work; }
		/** @type {Promise<void>} */
		const work = Promise.resolve().then(() => {
			wakes.delete(key);
			return reconcile(id, actor, wake.discover, wake.recover);
		}).catch(error=>{
			if(transientStatus(error))supervisor.invalidate(id,actor);
			throw error;
		});
		const wake = { discover, recover, work }; wakes.set(key, wake);
		return work;
	}
	/** @param {string} id @param {string} actor @param {boolean} discover @param {boolean} recoverCalls
	 * @param {{batch:Effect[],reason:string|null}} [check] */
	async function reconcile(id, actor, discover, recoverCalls,check) {
		const entry=read(id),quarantine=contractHold(entry);
		if(quarantine){if(check)check.reason=quarantine;return;}
		if(entry.products.at(-1)?.qualifiedAt && unprovenExports(entry).length){
			if(check)check.reason="The historical handoff does not establish the approved evaluator inputs";return;
		}
		/** @typedef {import("./reconciliation.mjs").Signal} Signal */
		/** @type {Run["policyHold"]} */ let held;
		/** @type {Map<string,string>} */ let workflows;
		/** @type {import("./supervision.mjs").Gate|undefined} */ let deferredGate;
		/** @type {string|undefined} */ let submitToken;
		/** @type {Run} */ let planned;
		/** @type {import("./model.js").Adoption|undefined} */ let adoption;
		let missingTarget=false;
		let mending=false;
		/** @type {Effect[]} */ let batch=check?.batch ?? [];
		/** @type {Inspection[]} */ let inspections=[];
		const publication=publicationSample(actor);
		/** @type {import("./permissions.mjs").PermissionBlock|null} */ let block=null;
		/** @type {string|null} */ let policyMessage=null;
		let pooled=false,renewing=false;
		/** @type {ReturnType<typeof recovery.select>} */ let proposals=new Map();
		/** @type {Effect[]} */ let ready;
		/** @type {import("./model.js").Review[]} */ let scouts;
		/** @type {import("./model.js").NativeCall[]} */ let writers;
		/** @type {Effect[]} */ let calls;
		/** @type {Awaited<ReturnType<typeof chooseWriters>>} */ let match;
		const refill=()=>drive(id,actor,discover,false);

		return reconcileWake({
			"retain-wake":()=>supervisor.invalidate(id,actor),
			"inspect-issuer":next=>{
				const run=entry;
				supervisor.observe(id,actor,gate(run,actor));
				inspector.observe(run,actor);
				held=run.policyHold;
				workflows=new Map(reviews(run).flatMap(e=>e.issuer===actor && needsContinuation(e) && e.callId && e.workflowId ?
					[[e.callId,e.workflowId]] : []));
				return next("inspected",{ownHold:held?.issuer===actor,active:run.active,expired:expired(run),
					continuations:!!(workflows.size && host.resumeScout && host.scoutSnapshot)});
			},
			"sample-policy":async next=>{
				block=await host.permissionBlocker();
				const eligible=await executable();
				return next("policy",{permitted:!block && eligible,executable:eligible,closed});
			},
			"clear-hold":next=>{
				reactivate(id,actor,text(held?.token,"observed hold token"));
				return next("recovered");
			},
			"continue-workflows":async next=>{
				for (const [ticket,native] of workflows)
					deferredGate=await continueScouts(id,actor,ticket,native,true) || deferredGate;
				return next("recovered");
			},
			"read-originals":readOriginals,
			plan:next=>{
				submitToken=[...submitting].findLast(s=>s.run===id && s.actor===actor)?.token;
				return plan(next,false);
			},
			renew:next=>{renewing=true;return plan(next,true);},
			"apply-verdicts":next=>{publication.permit();return plan(next,renewing);},
			"watch-held-inspections":()=>{
				if (block) inspector.permission(id,actor,publication.selected,block);
				supervisor.observe(id,actor,gate(read(id),actor,false,"issuer-permission"));
			},
			"watch-plan":watchPlan,
			"watch-held-renewal":next=>{deferredGate="issuer-permission";return watchPlan(next);},
			"offer-question":next=>{
				asking.add(id);
				track(presentQuestions(cwd(), () => closed ? undefined : db(), id, actor, host, executable, refill, recordReply).then(held=>{
					if (!closed && held) supervisor.observe(id,actor,gate(read(id),actor,false,held));
				}).finally(() => asking.delete(id)));
				return offerBatch(next);
			},
			"mend-test":next=>{
				for(const j of planned.testRepairs??[]){
					if(j.state==="draft" || j.state==="review" || j.workflow && (j.state==="authoring" || j.state==="reviewing"))
						track(runMechanic(id,j,j.state==="draft" || j.state==="authoring"?"author":"review",refill));
				}
				return offerBatch(next);
			},
			"draft-correction":next=>{track(authors.launch(planned,actor));return offerBatch(next);},
			"offer-adoption":next=>{
				const form=proposalForm(host,adoption);
				if(!adoption || !form)throw Error("Missing owner proposal or approval form");
				asking.add(id);
				const offered=adoption;
				const lost=offered.decision?.status==="presenting" && offered.decision.presentation;
				track(presentAdoption(approvalHost(form,refill),id,actor,offered,lost?{lost,vacant:()=>forms.vacant(offered)}:undefined).then(held=>{
					if(!closed && held)supervisor.observe(id,actor,gate(read(id),actor,false,held));
				}).finally(()=>{
					asking.delete(id);
					const current=!closed && pendingAdoption(read(id));
					if(current && current.id!==offered.id)track(refill());
				}));
				return offerBatch(next);
			},
			"offer-batch":offerBatch,
			"sample-batch":sampleBatch,
			"sample-writer-batch":next=>{pooled=true;batch=writers;return sampleBatch(next);},
			"decline-mode":()=>{if(check)check.reason="The issuing session is no longer in an executable mode.";else supervisor.invalidate(id,actor);},
			"hold-run":next=>recordPolicy(next,policyMessage,true),
			"hold-issuer":next=>recordPolicy(next,policyMessage,false),
			"release-batch":next=>recordPolicy(next,null,false),
			enable:next=>next("authorized",{checkOnly:!!check,pooled,ready:!!ready?.length || !!inspections.length}),
			"group-batch":()=>{
				scouts=ready.filter(e=>e.tool==="workflow");
				writers=ready.flatMap(e=>e.kind==="writer" && e.tool==="create_session" ? [e] : []);
				calls=ready.filter(e=>e.tool!=="workflow" && e.tool!=="create_session");
			},
			"launch-scouts":()=>{
				// A native agent label is not an identity: frozen-reference readers cannot share a ticket.
				const readers=scouts.filter(e=>referenceRepo(e.wake?.key) && planned.policy.squads.some(s=>s.id===e.squad && investigation(e,s)));
				const ordinary=scouts.filter(e=>!readers.includes(e));
				for(const jobs of [...(ordinary.length?[ordinary]:[]),...readers.map(e=>[e])])dispatchScouts(id,actor,jobs);
			},
			"launch-inspections":()=>{for(const i of inspections) inspector.launch(id,i);},
			"match-writers":async next=>{
				match=await chooseWriters(cwd(),planned,writers,host.idleWriter ?? fail("unavailable","Missing writer lookup"),host.log);
				return next("matched",{closed});
			},
			"send-matched":next=>{
				const live=match ? db().planAndSwap(id,match) : read(id), ids=new Set(writers.map(e=>e.id));
				return send(reservations(live,actor).filter(e=>ids.has(e.id) && e.state==="ready" && !e.permissionHold),next);
			},
			"send-writers":next=>send(writers,next),
			"send-calls":next=>send(calls,next),
			"wake-checkpoint":()=>track(drive(id,actor,false,false)),
			refill,
		},check ? {type:"verify-batch"} : {type:"wake",executable:await executable()},{
			history:()=>({closed,recoverCalls}),dispatch:()=>({closed}),
			scouts:()=>({jobs:!!scouts.length,capacityWait:capacityWakes.has(issuerKey(id,actor))}),
			inspections:()=>({jobs:!!inspections.length,capacityWait:capacityWakes.has(issuerKey(id,actor))}),writers:()=>({jobs:!!writers.length,pool:!!host.idleWriter}),
			calls:()=>({jobs:!!calls.length}),
		});

		/** @param {Signal} next */
		async function sampleBatch(next){
			const block=await host.permissionBlocker(), eligible=await executable();
			policyMessage=block ? `${block.message} Check session ${actor}. Its next turn rechecks the hold; Foundry also watches for permitted settings.` : null;
			return next("sampled",{executable:eligible,managed:block?.scope==="run",blocked:!!block,
				hadHolds:batch.some(e=>e.permissionHold) || !pooled && inspections.some(i=>i.permissionHold)});
		}
		/** @param {Signal} next @param {string|null} message @param {boolean} managed */
		function recordPolicy(next,message,managed){
			const reason=recordBatchPolicy(id,actor,batch,pooled ? [] : inspections,message,managed);
			if(check)check.reason=reason;
			return next("recorded",{permitted:reason===null});
		}
		/** @param {Signal} next */
		async function readOriginals(next) {
			/** @type {Effect[]} */ const lookups=[];
			for (const e of dispatches(entry)) {
				// A same-session SDK notice has no native tool history. Never replay it.
				const callId=e.callId;
				if (!callId || e.issuer!==actor || e.tool==="session.send" || !awaitingReply(e)) continue;
				if (e.tool==="workflow") {
					if (e.workflowId) observeWorkflow(id,callId,actor,e.workflowId);
					else if (e.state==="issued" && !scoutCalls.has(callId)) unconfirmedScouts(id,actor,callId,"No workflow ID was recorded before reconnect.",r=>awaitingReply(r) && !r.workflowId);
					continue;
				}
				const call=nativeCalls.get(callId);
				if (!host.recover || call?.inFlight || call?.recoveredOn===turnNumber) continue;
				lookups.push(e);
			}
			await observeCalls(id,lookups,()=>next("completion",{terminal:true}));
			return next("drained");
		}
		/** @param {Signal} next @param {boolean} renew */
		function plan(next,renew) {
			const approved=actor===entry.owner?entry.testRepairs?.flatMap(j=>j.state==="approved" && j.subject?[j.subject]:[]):undefined;
			if(approved?.length)return host.permissionBlocker().then(async block=>{
				if(block)deferredGate="issuer-permission";
				return commitPlan(next,renew,new Set(!block && await executable()?approved:[]));
			});
			return commitPlan(next,renew,new Set());
		}
		/** @param {Signal} next @param {boolean} renew @param {Set<string>} allowed */
		function commitPlan(next,renew,allowed) {
			let inspectionDue=false;
			planned=change(id,run=>{
				inspectionDue=false;adoption=undefined;mending=false;
				if(actor===run.owner)delete run.offerHold;
				const observed=run.active && !expired(run) ? observeTarget(()=>commitAt(cwd(),run.policy.target)) : undefined;
				missingTarget=!!observed && observed.target===undefined;
				if (missingTarget) return;
				if(!publication.check(observed ? run : undefined)){inspectionDue=true;return;}
				const linked=!!observed?.target && continueChecks(run,cwd(),actor,observed.target);
				if (run.active && !expired(run)) for (const e of reviews(run)) {
					if (e.issuer!==actor) continue;
					requeueCapacity(e);
					if (e.state==="ready" && e.error===waitingForSlot && !currentReview(cwd(),run,e,checkpointSurvey(run,e) ? undefined : observed?.target))
						blockReview(e,"Superseded while waiting for workflow capacity.");
				}
				/** @type {(()=>boolean)|undefined} */ let recovered;
				if (!reservations(run,actor).some(e=>e.permissionHold)){
					if(actor===run.owner && observed?.target) for(const e of run.effects)
						if(e.kind==="repair" && (e.input || e.continuation) && e.state==="ordinary")deliveryTip(cwd(),run,e,job=>db().verifySigned(id,job));
					/** @param {import("./model.js").NativeCall} e */ const verifySigned=e=>db().verifySigned(id,e);
					mending=planMending(cwd(),run,actor,verifySigned,allowed);
					const offers=!expired(run) && (!mending || run.testRepairs?.some(j=>j.state==="held"))?
						planOffers(cwd(),run,actor,verifySigned,!!host.confirmProposal):undefined;
					const chosen=offers?.offer;adoption=chosen;
					if (renew && proposals.size && observed?.target && !mending && !chosen) recovered=recovery.apply(cwd(),run,actor,proposals,verifySigned);
					const changed=!mending && advance(cwd(),run,actor,discover,{submitToken,target:observed?.target,renew,verifySigned});
					if(chosen){if(chosen.decision)adoption=forms.current(run,actor);}
					else if(!mending && (!offers?.ambiguous || changed && changed!==run.policy.contractTarget))adoption=planAdoption(cwd(),run,actor,changed||undefined,verifySigned);
					if(changed && !adoption)adoption=forms.current(run,actor);
					if(observed?.target)queueInstructions(run,actor);
				}
				if (allowed.size || publication.selected.length || adoption || recovered || linked) return ()=>!closed && !expired(run) &&
					(!linked || commitAt(cwd(),run.policy.target)===observed?.target) &&
					(!recovered || recovered()) && (!allowed.size || commitAt(cwd(),run.policy.target)===observed?.target) &&
					(!adoption || observeTarget(()=>commitAt(cwd(),run.policy.target)).target===adoption.revision);
			});
			if (!renew && actor===planned.owner) proposals=recovery.select(planned);
			return next("planned",{closed,missingTarget,inspectionDue,owner:actor===planned.owner,active:planned.active,expired:expired(planned),
				renewalDue:proposals.size>0 || reviews(planned).some(r=>r.renewal?.state==="needed")});
		}
		/** @param {Signal} next */
		function watchPlan(next) {
			receipts.observe(planned,actor);
			supervisor.observe(id,actor,gate(planned,actor,missingTarget,deferredGate));
			batch=reservations(planned,actor).filter(e=>(!mending || e.kind!=="scout") && (e.state==="ready" || e.permissionHold));
			ready=batch.filter(e=>e.state==="ready" && !(e.tool==="bash" && e.attempt?.version===1));
			inspections=readyInspections(planned,actor);
			return next("work",{missingTarget,active:planned.active,expired:expired(planned),handoff:batch.some(e=>e.kind==="handoff"),
				draftDue:!adoption && !mending && authors.ready(planned),
				testRepair:!!planned.testRepairs?.some(j=>j.state==="draft" || j.state==="review" || j.workflow && (j.state==="authoring" || j.state==="reviewing")),
				owner:actor===planned.owner,question:!!host.ask && !asking.has(id) && questions(planned).some(r=>!r.decision),
				adoption:!asking.has(id) && !!proposalForm(host,adoption)});
		}
		/** A committed claim precedes native author/reviewer work. A missing reply on reattachment is a hold, never a replay.
		 * @param {string} id @param {import("./model.js").TestRepair} expected @param {import("./mending.mjs").Phase} phase @param {()=>Promise<void>} wake */
		async function runMechanic(id,expected,phase,wake){
			if(capacityWakes.has(issuerKey(id,actor)) && (queuedMechanic(expected) || expected.state==="draft" || expected.state==="review"))return;
			const key=digest([id,expected.stop,phase]);if(mendingCalls.has(key))return;
			mendingCalls.add(key);
			let claimed=false;
			try{
				if(closed || !await executable())return;
				if(await host.permissionBlocker()){supervisor.observe(id,actor,gate(read(id),actor,false,"issuer-permission"));return;}
				const budget=await host.scoutBudget?.();
				const recovering=expected.state==="authoring" || expected.state==="reviewing";
				const reservation=db().reserve(id,r=>{
					const j=r.testRepairs?.find(j=>j.stop===expected.stop);
					const tip=j && repairCurrent(cwd(),r,j);
					if(!j || j.state!==expected.state || !repairPermitted(r) || !tip)return;
					let packet;
					try{
						packet=repairPacket(cwd(),r,j,phase);
						if(!(recovering?host.repairState:host.repairAgent) || budget!==undefined && Buffer.byteLength(packet.message)>budget)
							fail("unavailable","Independent test repair is unavailable or its complete packet exceeds the host budget");
					}catch(e){if(!(e instanceof FoundryError))throw e;holdRepair(j,e.message);return;}
					if(recovering){
						if(!expected.workflow || j.workflow!==expected.workflow || j.dispatch!==expected.dispatch || packet.subject!==j.subject)return;
					}else claimRepair(j,phase,packet.subject);
					const ticket={run:id,stop:j.stop,phase,dispatch:text(j.dispatch,"test repair dispatch"),subject:packet.subject};
					return {value:{packet,ticket},guard:()=>!closed && !expired(r) && commitAt(cwd(),r.policy.target)===tip};
				});
				if(!reservation || closed)return;
				claimed=true;
				const {packet:request,ticket}=reservation;
				const reply=recovering && expected.workflow ? await host.repairState?.(expected.workflow,ticket):await host.repairAgent?.(phase,request,ticket);
				if(closed)return;
				const permitted=!await host.permissionBlocker() && await executable();
				await recordReply(()=>db().planAndSwap(id,r=>{
					const j=r.testRepairs?.find(j=>j.stop===expected.stop);
					if(!j || j.subject!==request.subject || j.state!==(phase==="author"?"authoring":"reviewing"))return;
					if(!permitted || !repairPermitted(r))return; // The original bound result is available after permission returns.
					const tip=repairCurrent(cwd(),r,j);
					if(!reply || !tip){holdRepair(j,"Original repair inputs changed or no response was received; no pin was changed.");return;}
					try{repairAnswer(cwd(),r,j,phase,request,reply);}
					catch(e){holdRepair(j,`Test repair was not accepted: ${String(e)}`);}
					return ()=>!closed && !expired(r) && commitAt(cwd(),r.policy.target)===tip;
				}));
			}catch(error){
				if(!closed && claimed && error instanceof FoundryError && error.code==="repair_observe")return;
				if(!closed && claimed && error instanceof FoundryError && error.code==="repair_wait"){
					supervisor.observe(id,actor,gate(read(id),actor,false,"issuer-permission"));return;
				}
				if(!closed && claimed){
					const queued=await recordReply(()=>db().mutateLocked(id,r=>{
						const j=r.testRepairs?.find(j=>j.stop===expected.stop);
						if(j?.state!==(phase==="author"?"authoring":"reviewing"))return false;
						if(queueMechanic(j,error))return true;
						holdRepair(j,`Test repair delivery unconfirmed: ${String(error)}. Do not replay it.`);return false;
					}));
					if(queued)wakeCapacity(id,actor);
				}else if(!closed)throw error;
			}finally{mendingCalls.delete(key);}
			if(!closed && claimed)await wake();
		}
		/** @param {Signal} next */
		function offerBatch(next) {return next("batch",{hasBatch:!!batch.length || !!inspections.length});}
		/** @param {Effect[]} jobs @param {Signal} next */
		async function send(jobs,next) {
			await Promise.all(jobs.map(async e=>{
				const completion=dispatchCall(id,e,e.tool==="bash"?()=>receipts.observe(read(id),actor):undefined);
				if (completion) {
					await Promise.all([completion,next("issued",{checkpointGoal:e.kind==="goal" && planned.products.at(-1)?.commit===e.commit,
						checkpointReviews:planned.scheduling?.checkpointReviews!==false})]);
				}
				return next("attempt",{claimed:!!completion,pinnedCheck:e.kind==="instruction" || e.kind==="repair" && !!(e.input || e.continuation) || e.tool==="bash" && !!(e.calibration || e.testPin || e.recheck || e.pair || e.isolation || e.replacement || e.kind==="product" && mixedVerification(planned,e.id))});
			}));
		}
	}
	/** @param {string} id @param {string} actor @param {string} ticket @param {string} message
	 * @param {(e:import("./model.js").Review)=>boolean} [pending] */
	function unconfirmedScouts(id, actor, ticket, message, pending=awaitingReply) {
		const queued = db().mutateLocked(id, r => {
			let deferred = false;
			for (const e of batchOf(r, ticket, actor).filter(pending)) {
				survey(e,{type:"unconfirmed",error:`Discovery unconfirmed: ${message}. ${e.workflowId ? "Recheck the original workflow; no replacement started." : "Resume to retry unbound discovery."}`});
				if (requeueCapacity(e)) deferred = true;
			}
			return deferred && r.active && !expired(r);
		});
		if (queued) wakeCapacity(id,actor);
	}
	/** @param {string} id @param {string} actor @param {number} [delay] */
	function wakeCapacity(id, actor, delay=15_000) {
		const key=issuerKey(id,actor);
		if (capacityWakes.has(key)) return;
		capacityWakes.set(key, setTimeout(() => {
			capacityWakes.delete(key);
			// A sibling may have become ready while the original queued candidate
			// was superseded. The capacity wake may inspect both, never replay either.
			if (!closed) track(Promise.resolve().then(() => {
				const run=read(id);
				if (run.active && !expired(run) && (readyInspections(run,actor).length || run.owner===actor && (!!nextAuthor(run) || run.testRepairs?.some(j=>queuedMechanic(j) || j.state==="draft" || j.state==="review")) ||
					reviews(run).some(e=>e.issuer===actor && e.state==="ready"))) return drive(id,actor,true,false);
			}).catch(error=>{
				if(!closed && contention(error))wakeCapacity(id,actor,Math.min(60_000,delay*2));
				throw error;
			}));
		}, delay).unref());
	}
	/** @param {Run} run @param {string} actor */
	function capacityWaiting(run,actor) {
		return run.active && !expired(run) && (reviews(run).some(e=>e.issuer===actor && e.state==="ready" &&
			!e.callId && !e.workflowId && e.error===waitingForSlot) || inspector.queued(run,actor) ||
			run.owner===actor && (run.testRepairs?.some(queuedMechanic)===true || nextAuthor(run)?.p.reason==="Waiting for native workflow capacity."));
	}
	/** @param {Run} run @param {import("./model.js").Review} e @param {ScoutEnvelope} result */
	function settleScout(run, e, result) {
		if (e.workflowId && e.workflowId !== result.runId) fail("wrong_workflow", "Discovery result belongs to another workflow");
		if (e.workflowId && resumable(result)) {
			const disconnected=result.status==="halted" && result.failure?.type==="workflow_provider_disconnected";
			const action = disconnected && e.providerRecovery!=="claimed" ? "The issuer will verify the provider and continue this workflow once." :
				e.issuer === run.owner ? `Use /foundry resume ${run.policy.source} in the owner session.` :
				`On explicit request resume the original workflow ID in its issuing session ${e.issuer}, without changing limits.`;
			survey(e,{type:"suspend",disconnected,error:`Discovery ${result.status}: workflow ${e.workflowId}. ${action}`});
			retireSuperseded(run, e);
		} else blockReview(e, `Discovery ${result.status}: ${result.failure?.type ?? result.error ?? result.reason ?? "no report was received"}`);
	}
	/** @param {string} id @param {string} ticket @param {string} actor @param {string} workflow */
	function observeWorkflow(id,ticket,actor,workflow){
		const lookup=host.scoutState;
		if(lookup && !scoutCalls.has(ticket))watchScouts(id,ticket,actor,()=>lookup(workflow),workflow);
	}
	/** A workflow's settled attempt accounts for missing reports, never for checked work.
	 * Only a status read can be retried here, not a launch or continuation.
	 * @param {string} id @param {string} ticket @param {string} actor @param {()=>Promise<ScoutEnvelope>} invoke @param {string} [observedWorkflow] */
	function watchScouts(id, ticket, actor, invoke, observedWorkflow) {
		// Arm these continuations on the issuing call path. A workflow body only
		// journals and signals its report; it must not launch the next workflow.
		/** @type {Map<string,()=>Promise<void>>} */ const reports = new Map();
		/** @type {Set<string>} */ const claimed=new Set();
		for (const r of batchOf(read(id), ticket, actor).filter(awaitingReply)) {
			if(r.providerRecovery==="claimed")claimed.add(r.id);
			let signal = () => {};
			const reported = new Promise(resolve => { signal = () => resolve(undefined); });
			const wake = reported.then(() => { if (!closed) return drive(id, actor, true, false); });
			reports.set(r.id, () => { reports.delete(r.id); signal(); return wake; });
		}
		const retry=supervisor.statusReads(id,actor)?.delete(ticket);
		scoutCalls.set(ticket, reports);
		// Another issuer instance may already have continued this same workflow.
		/** @param {import("./model.js").Review} e */
		const pending=e=>awaitingReply(e) && (e.providerRecovery!=="claimed" || claimed.has(e.id));
		/** @param {Promise<void>} finished */
		const finish=finished=>track(finished.catch(error=>host.log?.(`Foundry discovery: ${String(error)}`)).finally(()=>{
			if(scoutCalls.get(ticket)===reports)scoutCalls.delete(ticket);
		}));
		void Promise.resolve().then(invoke).then(result=>finish(received(result)),error=>finish(rejected(error)));
		/** @param {ScoutEnvelope} result */
		async function received(result){
			let delayed=false;
			const reconcile=await recordReply(()=>{
				if(scoutCalls.get(ticket)!==reports)return false;
				// A status sample may be superseded during contention. Reobserve its
				// exact binding instead of applying an old halt to a resumed workflow.
				const reads=delayed && host.scoutState && supervisor.statusReads(id,actor);
				if(reads){
					const run=read(id);
					if(run.active && !expired(run) && batchOf(run,ticket,actor).some(e=>e.workflowId===result.runId && pending(e))){
						reads.set(ticket,result.runId);return false;
					}
				}
				delayed=true;
				return db().mutateLocked(id,r=>{
					const batch=batchOf(r,ticket,actor),outstanding=batch.filter(pending);
					for (const e of outstanding) settleScout(r,e,result);
					return outstanding.length>0 || batch.some(e=>reports.has(e.id));
				});
			});
			if(reconcile&&!closed)track(drive(id,actor,true,false));
		}
		/** @param {unknown} error */
		async function rejected(error){
			if(closed || scoutCalls.get(ticket)!==reports)return;
			if(observedWorkflow && transientStatus(error)){
				if(!retry)host.log?.(`Foundry cannot read workflow ${observedWorkflow}: ${String(error)}`);
				supervisor.statusReads(id,actor)?.set(ticket,observedWorkflow);
			}else await recordReply(()=>{
				if(scoutCalls.get(ticket)===reports)unconfirmedScouts(id,actor,ticket,String(error),pending);
			});
		}
	}
	/** @param {string} id @param {string} ticket @param {string} actor @param {string} workflowId */
	async function scoutBatch(id, ticket, actor, workflowId) {
		text(workflowId, "workflow ID");
		/** @type {number|undefined} */ let budget;
		let budgetError = "";
		if (host.scoutBudget && batchOf(read(id), ticket, actor).some(awaitingReply)) {
			try {
				budget = await host.scoutBudget();
				if (!Number.isSafeInteger(budget) || budget < 0) budgetError = "Invalid native scout prompt budget.";
			} catch (error) { budgetError = `Cannot size the scout packet: ${String(error)}`; }
		}
		const block = await host.permissionBlocker(), eligible = await executable();
		/** @type {string|undefined} */ let heldReason;
		const run = db().planAndSwap(id, r => {
			heldReason = undefined;
			const batch = batchOf(r, ticket, actor);
			if (!batch.length || batch.some(e => e.workflowId && e.workflowId !== workflowId))
				fail("foreign_assignment", "No matching Foundry discovery dispatch in this session");
			workflowIdentity(r,batch[0],workflowId);
			// Plan retry eligibility against one tip outside the lock. Recheck that exact tip at binding.
			const retries = batch.filter(e => e.retryOf && awaitingReply(e));
			const target = retries.length ? commitAt(cwd(), r.policy.target) : undefined;
			const guard = target ? () => commitAt(cwd(), r.policy.target) === target : undefined;
			for (const e of retries)
				if (!sameReviewInputs(cwd(), r, e, target) || e.diagnostic && e.diagnostic.receipt !== r.goal?.check)
					blockReview(e, "Superseded charter or product revision; the requested review was not dispatched.");
			const pending = batch.filter(e => awaitingReply(e) && currentPin(r, e));
			const held = !eligible || !r.active || expired(r) || block;
			if (pending.length && r.active && block?.scope === "run") holdFor(r,pending[0],`${block.message} Check session ${actor}.`);
			// A resumed body must not turn a permission race into a completed zero-job
			// workflow or discard its identity to get another launch.
			if (held && pending.some(e => e.workflowId)) {
				heldReason = block?.message ?? `Discovery cannot execute in session ${actor} while paused, expired or ineligible.`;
				return guard;
			}
			for (const e of pending) {
				if (held) {
					survey(e,{type:"requeue",...(block && {permissionHold:`${block.message} Check session ${actor}.`})});
				} else {
					if (!e.workflowId && !e.retryOf && r.goal?.commit === e.base) {
						const squad = r.policy.squads.find(s => s.id === e.squad);
						if (squad && !investigation(e, squad)) attachNotes(r, e);
					}
					survey(e,{type:"bind",workflowId});
				}
			}
			return guard;
		});
		supervisor.observe(id,actor,gate(run,actor));
		if (heldReason !== undefined) fail("bound_discovery_held", heldReason);
		const pending = batchOf(run, ticket, actor).filter(r => awaitingReply(r) && currentPin(run, r));
		if (!pending.length) return [];
		return pending.flatMap(r => {
			try {
				if (budgetError) fail("packet_budget", budgetError);
				return [{ id: r.id, squad: r.squad, base: r.base, ...scoutPacket(cwd(), run, r, budget) }];
			}
			catch (error) {
				if (!(error instanceof FoundryError) || error.code !== "packet_budget") throw error;
				db().mutateLocked(id, live => {
					const job = batchOf(live, ticket, actor).find(e => e.id === r.id && e.workflowId === workflowId);
					if (job && awaitingReply(job)) blockReview(job, error.message);
				});
				return [];
			}
		});
	}
	const scoutResult = reportReceiver({ read, record: (id, fn) => db().mutateLocked(id, fn),
		diagnostic: host.scoutFailure, signal: (ticket, review) => scoutCalls.get(ticket)?.get(review)?.() });
	/** @param {string} id @param {string} actor @param {string} token @param {Record<string,unknown>} args */
	function submit(id, actor, token, args) {
		const from = args.changedFrom, run = read(id), n = writable(run, actor, token, from);
		if (args.missingInput !== undefined || args.cannotRepair !== undefined || args.relinquish !== undefined) {
			if (!n) fail("stale_assignment", "An already submitted attempt cannot be stopped");
			const stop = args.relinquish !== undefined || args.cannotRepair !== undefined ? record(args.relinquish ?? args.cannotRepair) : undefined;
			if (stop) fields(stop, ["check", "reason"]);
			const check = stop && name(stop.check, "component check");
			const reason = text(stop ? stop.reason : args.missingInput, "why the assignment cannot be completed");
			const blob=args.inputBlob===undefined ? undefined : inputBlob(args.inputBlob);
			if(args.inputSource!==undefined && !blob)fail("invalid_pin","An inputSource requires the exact missing inputBlob");
			generationRoot(writerRoot(cwd(),run,n), text(n.generation, "generation commit"));
			db().planAndSwap(id, live => {
				const node = writable(live, actor, token);
				if (!node || node.generation !== n.generation || node.grain.id !== n.grain.id)
					fail("stale_assignment", "Assignment changed before recording the writer stop");
				if (live.effects.some(e => e.grain === node.grain.id && (e.permissionHold ||
					e.token === token && e.kind === "repair" && e.state !== "done")))
					fail("dispatch_held", "Resolve the pending assignment delivery or permission hold first");
				const job=productionWriter(live,token);
				if(blob && (job || node.check || node.candidate || node.restoration || node.reuse))
					fail("stale_assignment","Only an ordinary missing-input stop before a component submission can request a reference");
				if (job?.production && args.missingInput!==undefined) {
					job.error=`Production repair stopped without submission: ${reason}`;
					live.nodes[node.grain.id]=structuredClone(job.production.prior);
					return;
				}
				if (args.relinquish !== undefined) {
					const failed = relinquishable(live,node);
					if (!failed || failed.id !== check || node.candidate)
						fail("stale_assignment", "Not the bound writer's current relinquishable component repair");
					if (live.effects.some(e => e.grain === node.grain.id && (awaitingReply(e) || unissued(e) && current(live,e))))
						fail("dispatch_held", "Resolve the outstanding assignment call first");
					db().verifySigned(id,failed);
					node.stop = {kind:"writer-relinquished",detail:reason};
					assign(node,{type:"stop",reason:`Writer relinquished repair after component ${check} (exit ${failed.receipt?.exit}): ${reason}`});
					return;
				}
				const receipt = inconclusiveRepair(node, live.effects.find(e => e.id === node.check));
				if (check && (!receipt || check !== node.check)) fail("stale_assignment", "Not the inconclusive component check for this inline repair");
				if (receipt) {
					node.stop = {kind:"writer-cannot-repair", detail:reason};
					node.candidate = receipt.commit;
					assign(node,{type:"stop",reason:`Writer cannot repair component ${node.check} under this assignment: ${reason}`});
				} else {
					const source=args.inputSource===undefined ? undefined : requestedSource(live,node,args.inputSource);
					if(source && blob)verifySource(cwd(),live,source,blob,e=>db().verifySigned(id,e));
					stopForInput(node,reason,blob ? {blob,after:live.artifacts?.length??0,grant:writerVersion(node),...(source && {source})} : undefined);
				}
			});
			return; // No directory capture, new component reservation, or inferred permission.
		}
		if (!n) return;
		const g = n.grain;
		const reports = reportedReferences(run, n, args);
		const commit = capture(writerRoot(cwd(),run,n), text(n.generation, "generation commit"), g.directory,n.retained,run.products.at(-1)?.commit);
		const result = db().planAndSwap(id, r => {
			const node = writable(r, actor, token, from);
			if (!node || node.grain.id !== g.id || digest(n) !== digest(node))
				fail("stale_assignment", "Assignment changed during capture");
			requireChangedReview(cwd(),r,node,commit);
			/** @type {string|undefined} */ let target;
			const review = node.review && r.effects.find(e => e.id === node.review);
			const previous = review && review.kind === "scout" && review.predecessor;
			const observer=observerWriter(r,node.token);
			const producer=productionWriter(r,node.token);
			if (producer) {
				const target=submitProduction(cwd(),r,producer,commit,actor);
				return ()=>commitAt(cwd(),r.policy.target)===target;
			}
			const observerTarget=observer && verifyObserver(cwd(),r,observer,commit,true);
			if (!observer && node.restoration && (typeof g.directory!=="string" || directoryBaseline(cwd(),commit,g.directory)?.tree!==node.restoration.tree))
				fail("changed_restoration","Submit only the unchanged current primary tree authorized for ownership restoration");
			if (review && review.kind==="scout" && comparison(r,review)?.successor &&
				!changedFiles(cwd(),text(node.base,"approved product"),commit,scopePaths(g.directory)).length)
				fail("unchanged_candidate","The narrow successor must change its approved paths on the current product");
			if (previous && previous.stop?.kind === "writer-cannot-repair" && previous.candidate &&
				treeOf(cwd(),previous.candidate) === treeOf(cwd(),commit))
				fail("unchanged_candidate","This successor reproduced the stopped component's tree; do not replay its observation");
			if (node.reuse && !changedFiles(cwd(),text(node.generation,"seeded generation"),commit,scopePaths(g.directory)).length)
				fail("unchanged_candidate","Change the assigned directory before submitting; the retained failure will not be replayed");
			if (from !== undefined) {
				if (commit === from) fail("unchanged_candidate", "Change the assigned directory before submitting; the old check will not be replayed");
				target = commitAt(cwd(), r.policy.target);
				reserveChangedRepair(cwd(), r, node, actor, token, target);
			}
			assign(node,"submit");
			node.candidate = commit;
			const effect=reserveCheck(r,actor,cwd(),commit,g.check,{kind:"component",grain:g.id},reports);
			node.check=effect.id;
			if(observer?.observer)effect.observer={...observer.observer};
			if (observerTarget || target) return () => commitAt(cwd(), r.policy.target) === (observerTarget ?? target);
		});
		return result.nodes[g.id].token;
	}
	/** @param {string} origin */
	async function requireReadyOwner(origin) {
		const block = await host.permissionBlocker();
		if (block !== null) fail("permissions_unready", block.message);
		if (!await executable() || cwd() !== origin)
			fail("context_changed", "Activation context changed during the permission check");
	}
	/** @typedef {{run:Run,pending:import("./model.js").Review[],result:ScoutEnvelope}} Verification */
	const verifyWorkflow=executor(workflow,{
		continue(/** @type {Verification} */ c){for(const e of c.pending)e.providerRecovery="claimed";return true;},
		"record-status"(/** @type {Verification} */ c){for(const e of c.pending)settleScout(c.run,e,c.result);return false;},
		wait(){return false;},
	});
	/** @param {string} id @param {string} actor @param {string} ticket @param {string} workflowId @param {boolean} [automatic] */
	async function continueScouts(id, actor, ticket, workflowId,automatic=false) {
		const lookup = host.scoutSnapshot, resume = host.resumeScout;
		if (!lookup || !resume || continuing.has(ticket)) return;
		const origin = cwd();
		let result;
		try {result=await lookup(workflowId);}
		catch(error) {
			if (!automatic) throw error;
			host.log?.(`Foundry cannot verify workflow ${workflowId}: ${String(error)}`);
			if (transientStatus(error)) return "workflow-status";
			return;
		}
		if (result.runId !== workflowId) fail("wrong_workflow", "Discovery lookup returned another workflow");
		if (result.status === "pending" || result.status === "running") return;
		if (!await executable()) return "issuer-permission";
		if (resumable(result)) {
			if (automatic) {if (await host.permissionBlocker() || !await executable()) return "issuer-permission";}
			else await requireReadyOwner(origin);
		}
		if (continuing.has(ticket)) return;
		let shouldResume=false;
		db().planAndSwap(id, run => {
			shouldResume=false;
			if (!automatic && run.owner !== actor || !run.active || expired(run)) return;
			const batch=batchOf(run,ticket,actor);
			const pending = batch.filter(e => e.workflowId === workflowId && awaitingReply(e));
			if (automatic) {
				if (!pending.length || !pending.every(e=>e.state==="suspended" && e.providerRecovery==="needed")) return;
				const target=observeTarget(()=>commitAt(origin,run.policy.target)).target;
				const resolution=transition(workflow,{value:"suspended",context:null},{type:"verified"},{unused:!batch.some(e=>e.providerRecovery==="claimed"),
					disconnected:result.status==="halted" && result.failure?.type==="workflow_provider_disconnected",
					current:!!target && !run.independent && !activeDelivery(run) && !run.blocker && !run.conflict &&
						!run.effects.some(e=>e.permissionHold) && !contractConflict(origin,run.policy,target) &&
						pending.every(e=>sameReviewInputs(origin,run,e,target))},true);
				[shouldResume]=verifyWorkflow(resolution,{run,pending,result});
				if(shouldResume)return ()=>observeTarget(()=>commitAt(origin,run.policy.target)).target===target;
				return;
			}
			for (const e of pending) settleScout(run, e, result);
			for (const e of pending) if (e.providerRecovery==="needed") e.providerRecovery="claimed";
			shouldResume=pending.some(e=>e.state==="suspended");
		});
		if (shouldResume) {
			// Replace any observer that may still be delivering the prior paused envelope.
			continuing.add(ticket);
			watchScouts(id, ticket, actor, () => resume(workflowId).finally(() => continuing.delete(ticket)));
		}
	}
	/** @param {unknown} source @param {string} actor @param {boolean} resume @param {unknown} [runId] */
	async function start(source, actor, resume, runId) {
		if (writerSession(actor)) fail("worker_cannot_start", "Workers cannot activate or restart a run");
		if (!await executable()) fail("unsupported_mode", "Start only from an interactive or autopilot owner");
		const origin = cwd(), filename = relative(source);
		const store = existsSync(file()) ? db() : undefined;
		const saved = resume ? (runId === undefined ? store?.forResume(filename,actor) : store?.read(name(runId,"run"))) ??
			fail("missing_run", `No run to resume for ${filename}`) : undefined;
		const { policy, grains } = saved ? {policy:saved.policy, grains:[]} : readPolicy(origin,filename);
		const prior = saved ?? store?.read(policy.id);
		let recoveryBase;
		if (prior) {
			if (prior.owner !== actor || prior.policy.source !== filename)
				fail("run_conflict", "Another owner or contract already uses this run ID");
			const quarantine=contractHold(prior);
			if(quarantine)fail("contract_hold",quarantine);
			const p=prior.products.at(-1),g=prior.goal;
			if(p && g && unprovenExports(prior).length){
				if(!resume)return status(prior,actor);
				if(expired(prior))fail("deadline","The authorized deadline has elapsed");
				await requireReadyOwner(origin);
				change(prior.id,r=>reassessHandoff(origin,r,actor,p.check,g.check,e=>db().verifySigned(prior.id,e)));
				await drive(prior.id,actor,true);
				return status(read(prior.id),actor);
			}
			const target = saved ? commitAt(origin,policy.target) : policy.base;
			const work = saved && movingSurvey(origin,prior,target);
			recoveryBase=saved && !work ? adoptionBase(origin,prior,target) : undefined;
			verifyContracts(origin,prior.policy,work?.target ?? recoveryBase ?? target);
			if (prior.goal && qualifiedProduct(prior)) return status(prior, actor);
			if (!resume) {
				if (!prior.active) fail("paused",`Run ${prior.id} already exists and is paused. Use foundry_resume with its original source.`);
				return status(prior,actor);
			}
		}
		if (policy.deadline && Date.now() >= Date.parse(policy.deadline)) fail("deadline", "The authorized deadline has elapsed");
		if (!prior) {
			await requireReadyOwner(origin);
			const run = newRun(origin, policy, actor, grains);
			admitted(run);
			retain(origin, policy.base);
			for (const g of grains) if (g.revision) retain(origin, g.revision);
			if (run.goal && run.goal.commit !== policy.base) retain(origin, run.goal.commit);
			db(true).insert(run);
		} else {
			const plan = prepareResume(prior, !!host.scoutSnapshot,inspector.canReceive);
			if (!plan && !recoveryBase) return status(prior, actor);
			await requireReadyOwner(origin);
			if(plan)change(policy.id, r => {
				plan.apply(r);
				if (plan.retryGoal) advance(origin, r, actor, false, { retryGoal: true });
			});
			if(plan)await Promise.all([...plan.workflows].map(([ticket, workflowId]) => continueScouts(policy.id, actor, ticket, workflowId)));
		}
		await drive(policy.id, actor, true);
		return status(read(policy.id), actor);
	}
	/** @param {unknown} args @param {string} actor @returns {ReturnType<typeof status> & {release?:ReturnType<typeof releaseAssessment>}} */
	function inspect(args, actor) {
		const a = record(args); fields(a, ["run", "detail"]);
		const run = read(name(a.run, "run")), result = status(run, actor, a.detail);
		const tip = () => commitAt(cwd(), run.policy.target);
		const release = run.owner===actor && run.goal && !contractHold(run) ? releaseAssessment(cwd(),run,tip) : undefined;
		const missing = release ? (["target-unavailable","ownership-conflict","contract-changed"].includes(release.reason) && "error" in release && release.error) :
			run.active && observeTarget(tip).error;
		return { ...result, ...(release && {release}),
			...(typeof missing==="string" && !result.blocker?.includes(missing) ? {blocker:[result.blocker,missing].filter(Boolean).join("\n")} : {}) };
	}
	/** @param {string} message */
	async function confirm(message) {
		return await host.autoConfirm?.() || host.confirm?.(message);
	}
	/** @param {string} op @param {unknown} args @param {string} actor */
	async function operation(op, args, actor) {
		if (op === "status") return inspect(args, actor);
		const a = record(args);
		if (op === "start" || op === "resume") {
			fields(a, op==="resume" ? ["source","run"] : ["source"]);
			return start(a.source, actor, op === "resume",a.run);
		}
		const id = name(a.run, "run");
		const live=read(id),quarantine=contractHold(live);
		if(quarantine)fail("contract_hold",quarantine);
		if (op!=="pause" && activeDelivery(live)) fail("dispatch_held","An approved test delivery is in progress; wait for its original checks");
		if (op!=="pause" && live.independent) fail("ownership_transition","Independent checkpoint already reserved; the original ownership hold is not released");
		if(op==="propose"){
			const origin=cwd(),token=text(a.token,"original writer token");
			await requireReadyOwner(origin);
			db().planAndSwap(id,r=>{
				admitted(r);
				const n=boundWriter(r,actor,token);
				if(actor===r.owner)fail("foreign_assignment","Only a bound writer supplies diagnostic evidence");
				generationRoot(writerRoot(origin,r,n),text(n.generation,"frozen writer generation"));
				recordDiagnostic(origin,r,n,a,e=>db().verifySigned(id,e));
			});
			await drive(id,actor,false,false);
			return status(read(id),actor);
		}
		if(op==="draft" && (a.files!==undefined || a.evaluator!==undefined)){
			await requireReadyOwner(cwd());
			await selectDraft({cwd:cwd(),store:db(),closed:()=>closed,permitted:async()=>await executable() && !await host.permissionBlocker(),
				vacant:host.formVacant,confirm:host.confirmProposal??host.confirm,persist:recordReply},id,actor,a);
			await drive(id,actor,false,false);return status(read(id),actor);
		}
		if (op === "workspace") {
			fields(a,["run","token"]);
			await requireReadyOwner(cwd());
			const token = text(a.token,"assignment token");
			const run = db().planAndSwap(id,r=>acceptWorkspace(r,actor,token,cwd())), n = writable(run,actor,token);
			if (!n?.workspace || n.state!=="writing") fail("stale_assignment","Need the current pooled writer's writable assignment");
			writerRoot(cwd(),run,n,true);
			return status(run,actor);
		}
		const prepare=grantFor(op);
		if (prepare) {
			const origin=cwd(),request=prepare(origin,live,actor,a,e=>db().verifySigned(id,e));
			await requireReadyOwner(origin);
			if (request.consent!=="satisfied") {
				const approved = request.consent==="native" ? await (host.confirmProposal??host.confirm)?.(request.prompt) : await confirm(request.prompt);
				if (approved === false) fail("approval_declined","Request not approved. No assignment changed. Do not ask again without a fresh request.");
				if (approved !== true) fail("approval_required","Approval is unavailable; no assignment changed");
			}
			await requireReadyOwner(origin);
			db().planAndSwap(id,request.apply);
			if (request.wake==="none")return inform(id,actor);
			await drive(id,actor,false,request.wake==="recover");
			return status(read(id),actor);
		}
		if (op === "recheck" || op === "pair") {
			const origin = cwd(), before = read(id);
			if (op==="recheck" && a.product===undefined) fields(a,["run","check"]);
			/** @param {import("./model.js").NativeCall} e */
			const signed=e=>db().verifySigned(id,e);
			const rerun = op==="recheck" && a.product!==undefined ? prepareRerun(origin,before,actor,a,signed) : undefined;
			const request = op==="pair" ? preparePair(origin,before,actor,a,signed) :
				a.product===undefined ? prepareRecheck(origin,before,actor,name(a.check,"check"),signed) : rerun;
			if (!request) return status(before,actor,"proof");
			await requireReadyOwner(origin);
			if (rerun?.prompt !== undefined) {
				const approved = await confirm(rerun.prompt);
				if (approved!==true) fail(approved===false ? "approval_declined" : "approval_required","Historical harness not approved. No check was reserved.");
				await requireReadyOwner(origin);
			}
			const saved=db().planAndSwap(id,request.apply);
			if (rerun) {
				const e=saved.effects.findLast(e=>e.kind==="rerun" && e.commit===a.product && e.rerun?.of===a.check && e.rerun?.after===a.after);
				if (e?.state==="ready" && await dispatchBlocker(id,actor,[e])===null)await dispatchCall(id,e);
			} else await drive(id,actor,false,false);
			return status(read(id),actor,op==="recheck" ? "proof" : undefined);
		}
		if (op === "retire") {
			fields(a, ["run","check"]);
			const origin = cwd(), reconcile = await retireGoal(origin, actor, name(a.check, "goal check"), {
				read: () => read(id), ready: () => requireReadyOwner(origin), history: host.readHistory,
				confirm, swap: fn => db().planAndSwap(id, fn) });
			if (reconcile) await drive(id, actor, false, false);
			return status(read(id), actor, "proof");
		}
		if (op === "configure") {
			await requireReadyOwner(cwd());
			db().planAndSwap(id, run => {
				admitted(run);
				configure(run, actor, a);
			});
			await drive(id, actor, false, false);
			return status(read(id), actor);
		}
		if (op === "pause") {
			fields(a, ["run"]);
			db().mutateLocked(id, r => {
				if (r.owner !== actor)
					fail("foreign_run", "Only the owner can pause");
				activate(r,"pause");
			});
			return status(read(id), actor);
		}
		if (op === "clarify") {
			fields(a, ["run", "review", "presentation"]);
			const request = { review: name(a.review, "review"), presentation: name(a.presentation, "presentation") };
			if (asking.has(id)) fail("question_open", "A charter question is already open in this runtime");
			asking.add(id);
			try {
				await presentQuestions(cwd(), () => closed ? undefined : db(), id, actor, host, executable, () => drive(id, actor, true), recordReply, request);
				return status(read(id), actor);
			} finally { asking.delete(id); }
		}
		if (op === "rereview") {
			fields(a, ["run", "review"]);
			const review = name(a.review, "review"), origin = cwd(), original = read(id), {prior, sourceBlob} = retryableReview(origin, original, actor, review);
			const receipt = original.goal?.check;
			const checkpoint = prior.iteration?.basis === "checkpoint";
			if (prior.error === indexBudgetError && (!receipt || prior.packet || prior.note && !checkpoint ||
				checkpoint && (comparisonGoal(prior.iteration) ? !comparisonVerdict(goalReceipt(original)?.exit,prior.iteration?.successor) : goalReceipt(original)?.exit!==1) ||
				original.effects.slice(0, original.effects.findIndex(e => e.id === prior.id)).findLast(e => e.kind === "goal")?.id !== receipt ||
				original.policy.squads.some(s => s.id === prior.squad && investigation(prior, s))))
				fail("not_recoverable", "Need the original pre-dispatch review and its still-current goal receipt");
			if (prior.issuer !== actor) fail("missing_history", "Need the original workflow's issuer in the owner session");
			await requireReadyOwner(origin);
			if (!sourceBlob) {
				if (!host.confirmNoReport) fail("missing_history", "Need the original workflow's issuer-scoped native evidence in the owner session");
				await host.confirmNoReport(prior);
			}
			const budget = await host.scoutBudget?.();
			await requireReadyOwner(origin);
			if(!host.scout)fail("unavailable","Discovery workflow unavailable");
			dispatchScouts(id,actor,run=>{
				const {prior:live, sourceBlob:verified} = retryableReview(origin, run, actor, review);
				if (digest(live) !== digest(prior) || sourceBlob!==verified || run.goal?.check !== receipt) fail("stale_assignment", "Review or goal changed during native verification");
				if (budget === undefined || !Number.isSafeInteger(budget) || budget < 0)
					fail("packet_budget", "Missing a valid issuing-session scout budget");
				const fresh = reserveReview(run, actor, live.squad, live.base, live.version, live.wake);
				fresh.retryOf = live.id;
				if (sourceBlob) fresh.retrySource = sourceBlob;
				if (live.lead) fresh.lead = live.lead;
				if (live.error === indexBudgetError && receipt && !live.note && !live.lead && !comparisonGoal(live.iteration)) {
					const full = goalReceipt(run);
					if (!full || full.commit !== live.base) fail("invalid_receipt", "Missing the reviewed goal receipt");
					const excerpt = diagnosticLine(full.output, live.squad);
					if (excerpt && Buffer.byteLength(full.output) > budget / 8) fresh.diagnostic = { receipt, excerpt };
				}
				const { prompt } = scoutPacket(origin, run, fresh, budget);
				if (Buffer.byteLength(prompt) > budget) fail("packet_budget", "New packet exceeds the scout budget");
				if (run.goal) delete run.goal.stall;
				return fresh;
			});
			return status(read(id), actor);
		}
		if (op === "iterate") {
			fields(a, ["run", "directory", "files", "receipt", "blob", "question", "historical", "source","transfer","successor"]);
			const directory=relative(a.directory), scope=a.files===undefined ? directory : assignmentDirectory({primary:directory,files:a.files}).directory;
			const origin = cwd(), input = { directory, ...(mixed(scope) ? {files:scope.files} : {}), receipt: name(a.receipt, "receipt"),
				blob: name(a.blob, "offered comparison blob"), question: text(a.question, "observed mismatch"),
				...(a.transfer===undefined ? {} : {transfer:transferRequest(a.transfer)}),...(a.successor===undefined?{}:{successor:successorRequest(a.successor)}) };
			const old = a.historical === undefined ? undefined : record(a.historical);
			if (old) fields(old, ["receipt", "step"]);
			const historical = old && { receipt:name(old.receipt, "historical receipt"), step:text(old.step, "stable step identifier") };
			const citation = a.source === undefined ? undefined : record(a.source);
			if (citation) fields(citation, ["commit","file","excerpt"]);
			const source = citation && {commit:name(citation.commit,"checked product"),file:relative(citation.file),excerpt:text(citation.excerpt,"verbatim product excerpt")};
			await requireReadyOwner(origin);
			if(!host.scout)fail("unavailable","Discovery workflow unavailable");
			/** @param {Run} run */
			const reserve = run => {
				const review=reserveIteration(origin,run,actor,input,historical,source);
				if (input.successor && review) {
					const check=stoppedCheck(run,input.successor) ?? fail("invalid_successor","Original stopped component is unavailable");
					db().verifySigned(id,check);
				}
				return review;
			};
			/** @type {string|undefined} */ let approvedCheckpoint;
			if (source) {
				const preview = db().preview(id,reserve);
				if (!preview) return status(read(id),actor);
				approvedCheckpoint = preview.iteration?.receipt;
				const approved = await confirm(`Open one source-backed review for ${id}, ${input.directory}/ on checked product ${source.commit}?\n` +
					`Passing checkpoint: ${approvedCheckpoint}. Current ${input.successor?"settled":"exit-2"} goal: ${input.receipt}. Offered blob: ${input.blob}.\n` +
					`Question: ${input.question}\nVerbatim source at ${source.commit}:${source.file}:\n${source.excerpt}\n` +
					(input.files ? `If staffed, the writer may edit the whole primary directory and these exact existing regular files: ${JSON.stringify(input.files)}. No sibling files or parent directories.\n` : "") +
					(input.successor ? `Authorize one fresh narrow successor ${input.successor.to} to stopped assignment ${input.successor.from}, original signed component ${input.successor.check}, only on this product and only if this review supports it. All other paths remain reserved. Start from the current product, not the stopped writer's bytes. No previous receipt is replayed or promoted.` :
					input.transfer ? `Approve a conditional ownership transfer from ${input.transfer.from}@${input.transfer.candidate} to ${input.transfer.to} on this checkpoint. The parent retains ALL other paths, including future siblings. Only a matching, still-eligible proposal applies the transfer; no receipts or inputs are rewritten.` :
					"Only a supported proposal can staff one repair. It may continue after a disjoint checked output joins if its charter, ownership, evidence, required inputs and evaluators are unchanged. No reassignment or check result is implied."));
				if (approved === false) fail("approval_declined","Comparison not approved. No review was started; do not ask again without a fresh request.");
				if (approved !== true) fail("approval_required","Operator approval is unavailable; no review was started");
				await requireReadyOwner(origin);
			}
			dispatchScouts(id,actor,run=>{
				const fresh = reserve(run);
				if (!fresh) return;
				if (source && fresh.iteration?.receipt !== approvedCheckpoint) fail("stale_assignment","The approved product checkpoint changed");
				return fresh;
			});
			return status(read(id),actor);
		}
		const reply = op === "submit" || op === "preview" ? { run: id, actor, token: text(a.token, "submission token") } : undefined;
		if (reply) {
			fields(a, op === "preview" ? ["run", "token"] : a.relinquish !== undefined ? ["run","token","relinquish"] : a.cannotRepair !== undefined ? ["run", "token", "cannotRepair"] :
				a.missingInput !== undefined ? ["run", "token", "missingInput","inputBlob","inputSource"] : ["run", "token", "changedFrom", "usedArtifacts", "comparedArtifacts"]);
			// Check the host, not a local count lost on reload. Revalidate mode and ownership after the read.
			const run = read(id);
			if (host.runningHelpers && writable(run, actor, reply.token, a.changedFrom)) {
				const workflows = new Set(reviews(run).flatMap(r => r.issuer === actor && awaitingReply(r) && r.workflowId ? [r.workflowId] : []));
				for (const i of boundInspections(run,actor))workflows.add(i.workflow);
				const helpers = await host.runningHelpers([...workflows]);
				if (helpers.length) fail("helpers_running", `Native helpers are still running: ${helpers.join(", ")}. Join them, integrate their work, then submit with the same token.`);
			}
			if (op === "preview" || a.changedFrom !== undefined || a.missingInput !== undefined || a.cannotRepair !== undefined || a.relinquish !== undefined) await requireReadyOwner(cwd());
		}
		if (!await executable())
			fail("unsupported_mode", "Plan mode cannot change a Foundry run");
		if (op === "preview" && reply) {
			const run = read(id), n = writable(run, actor, reply.token) ?? fail("stale_assignment", "Cannot preview an already submitted attempt");
			const commit = capture(writerRoot(cwd(),run,n), text(n.generation, "generation"), n.grain.directory,n.retained,run.products.at(-1)?.commit);
			const after = db().planAndSwap(id, run => {
				const live = writable(run, actor, reply.token);
				if (!live || digest(live) !== digest(n)) fail("stale_assignment", "Assignment changed during preview");
				const observer=observerWriter(run,live.token);
				const production=productionWriter(run,live.token);
				const target=production ? productionBasis(cwd(),run,production,commit).target : observer && verifyObserver(cwd(),run,observer,commit,false);
				live.preview = commit;
				if (target) return ()=>commitAt(cwd(),run.policy.target)===target;
			});
			return observerWriter(after,reply.token) ? inform(id,actor) : status(after,actor);
		}
		if (op === "review_note") {
			fields(a, ["run", "squad", "receipt", "question", "excerpt"]);
			db().mutateLocked(id, r => {
				if (r.owner !== actor) fail("foreign_run", "Only the run owner can queue a review note");
				admitted(r);
				queueNote(r, a);
			});
			return status(read(id), actor); // Queue context only; do not drive the run.
		}
		if (op === "attribute") {
			fields(a, ["run", "receipt", "id", "directory", "blocked", "excerpt"]);
			const origin = cwd();
			await requireReadyOwner(origin);
			db().planAndSwap(id, r => {
				admitted(r);
				const target = commitAt(origin, r.policy.target);
				verifyContracts(origin, r.policy, target);
				if (r.goal?.target !== target || r.join || r.conflict || r.blocker) fail("stale_assignment", "Need the unchanged assessed product");
				attribute(r, actor, a);
			});
		}
		else if (reply) {
			reply.token = submit(id, actor, reply.token, a) ?? reply.token;
			if (a.relinquish !== undefined) return status(read(id),actor);
			// A shell notification can drive the same actor before this call returns.
			submitting.add(reply);
		}
		else if (op === "publish") {
			fields(a, ["run", "token", "file", "to","forInput"]);
			if(a.token!==undefined || a.forInput!==undefined)await requireReadyOwner(cwd());
			db().mutateLocked(id, preparePublication(cwd(), read(id), actor, a,e=>db().verifySigned(id,e)));
		}
		else if (op === "repin" || op==="inherit" || op==="owned" || op==="rollout" || op==="evaluator") {
			const origin = cwd(), prior=read(id);
			/** @param {import("./model.js").NativeCall} e */ const verify=e=>db().verifySigned(id,e);
			const request=op==="repin"?prepareRepin(origin,prior,actor,a,verify):op==="rollout"?prepareRollout(origin,prior,actor,a,verify):
				op==="evaluator"?selectedEvaluator(origin,prior,actor,a,verify):preparePatch(origin,prior,actor,a,verify,op==="owned");
			await requireReadyOwner(origin);
			if(request.target){
				const form=exactForm(op==="rollout"?host.confirmProposal:host.confirmProposal??host.confirm,request.answer)??fail("approval_required","The approval form is unavailable; nothing was applied.");
				await presentAdoption(approvalHost(form,async()=>{}),id,actor,requestedAdoption(prior,request.target),
					{prompt:request.prompt,showing:asking.has(id),vacant:host.formVacant});
			}else{
				const approved = await confirm(request.prompt);
				if (approved === false) {
					const blocker = status(read(id), actor).blocker;
					fail("approval_declined", "Evaluator change not approved. No change or recheck was made. Do not ask again unless the operator requests it." +
						(blocker ? `\nCurrent run blocker: ${blocker}` : ""));
				}
				if (approved !== true) fail("approval_required", "The approval form is unavailable; the evaluator was not changed.");
				await requireReadyOwner(origin);
				db().planAndSwap(id, request.apply);
			}
		}
		else
			fail("unknown_operation", `Unknown Foundry operation ${op}`);
		try {
			await drive(id, actor);
			return op==="submit" ? inspect({run:id},actor) : status(read(id), actor);
		} finally {
			if (reply) submitting.delete(reply);
		}
	}
	/** @param {string} tool @param {unknown} args @param {string} actor @param {string} callId */
	async function pre(tool, args, actor, callId) {
		if (tool === "rename_branch") {
			if (writerSession(actor)) fail("writer_branch", "Keep the host-assigned Foundry branch. Use rename_session for a readable title; do not retry the rename through Git.");
			return;
		}
		const id = identify(tool, args);
		if (!id)
			return;
		const run = read(id), key = digest(args);
		const legacy=run.effects.find(e=>e.tool==="bash" && attachedLegacy(e) && e.issuer===actor && e.callId===callId && key===digest(e.args) && exactRunner(run,e,cwd()));
		if(legacy){
			// This recognizes an already issued request, not a new permission or a
			// runner claim. The original command may only close its slot at the ABI.
			nativeCalls.set(callId,{run:id,id:legacy.id,actor});return;
		}
		const e = dispatches(run).find(e => e.issuer === actor && e.tool === tool && digest(e.args) === key && current(run,e,cwd()));
		if (!e || e.tool==="bash" && e.attempt?.version===1 || e.state !== "ordinary" && !(e.state === "issued" && e.callId === callId))
			fail("unreserved_call", "Not a current prepared Foundry call");
		if (e.state === "ordinary") {
			if (!canDispatch(run, e)) admitted(run);
			const reason = await dispatchBlocker(id, actor, [e]);
			if (reason !== null) fail("dispatch_held", reason);
		}
		if (!claim(id,e,callId)) {
			if(e.kind==="repair" && (e.input || e.continuation)){
				const live=read(id),notice=live.effects.find(x=>x.id===e.id);
				if(notice?.state==="ordinary" && current(live,notice))fail("dispatch_held","The original prepared notice is retained. Wait for the target, pending check or permission hold to settle.");
			}
			fail("unreserved_call","The prepared call is no longer current");
		}
		if (!nativeCalls.has(callId)) nativeCalls.set(callId, { run: id, id: e.id, actor });
	}
	/** @param {Promise<unknown>} p */
	function track(p) {
		const task = p.catch(e => host.log?.(`Foundry: ${String(e)}`)).finally(() => background.delete(task));
		background.add(task);
	}
	return {
		operation, inspect, pre, scoutBatch, scoutResult, inspectionPacket:inspector.packet,draftPacket:authors.packet,
		/** @param {unknown} id @param {string} actor */
		inspectRecovery(id,actor){const r=read(name(id,"run"));return recoveryStatus(r,actor,instructionPins(r));},
		/** @param {import("./mending.mjs").Ticket} ticket @param {string} actor @param {string} workflow @param {"halt"|"permission"} [continuing] @param {number} [attempt] */
		async mechanicPacket(ticket,actor,workflow,continuing,attempt){
			if(closed)fail("dispatch_held","The issuing runtime closed");
			if(typeof attempt!=="number" || !Number.isSafeInteger(attempt) || attempt<1)attempt=undefined;
			const permitted=await executable() && !await host.permissionBlocker();
			let waiting=false;
			/** @type {import("./mending.mjs").Packet|undefined} */ let packet;
			db().planAndSwap(ticket.run,run=>{
				waiting=false;packet=undefined;
				const j=run.testRepairs?.find(j=>j.stop===ticket.stop);
				if(!j || actor!==run.owner || j.dispatch!==ticket.dispatch || j.subject!==ticket.subject ||
					continuing && (!j.workflow || continuing==="permission" && !j.awaitingPermission && !j.continuation) ||
					j.state!==(ticket.phase==="author"?"authoring":"reviewing"))
					fail("wrong_workflow","No unbound test repair matches this workflow and dispatch");
				j.workflow=workflowIdentity(run,j,workflow);
				if(continuing && j.continuation){
					if(j.continuationAttempt!==undefined && attempt!==undefined && attempt>j.continuationAttempt)
						fail("repair_interrupted","The original workflow was interrupted again after its continuation; no new attempt is authorized.");
					fail("repair_observe","The continuation belongs to this same original workflow; no second resume was issued.");
				}
				if(!permitted || !repairPermitted(run)){waiting=true;j.awaitingPermission=true;return;}
				const tip=repairCurrent(cwd(),run,j);
				if(!tip)fail("stale_assignment","Original test repair inputs changed before packet delivery");
				packet=repairPacket(cwd(),run,j,ticket.phase);
				if(packet.subject!==ticket.subject)fail("stale_assignment","The frozen repair packet changed");
				if(continuing){j.continuation=workflow;if(attempt!==undefined)j.continuationAttempt=attempt;}
				else delete j.awaitingPermission;
				if(queuedMechanic(j))delete j.reason;
				return ()=>!closed && !expired(run) && commitAt(cwd(),run.policy.target)===tip;
			});
			if(waiting)fail("repair_wait","The original workflow is bound but cannot receive repair evidence until permission and execution return.");
			return packet??fail("wrong_workflow","The repair workflow was not bound");
		},
		/** @param {string} id @param {string} actor */
		readBoard(id, actor) { return boardFacts(read(name(id, "run")), actor); },
		/** Read only a visible fixed grain's assigned specification, never a caller-supplied path or working copy.
		 * @param {string} id @param {string} actor @param {string} grain */
		readSpecification(id,actor,grain) {
			const run=read(name(id,"run")),n=visible(run,actor).nodes.find(n=>n.grain.id===grain);
			if(!n || n.grain.task)return;
			const root=cwd(),[file]=regularFiles(root,n.base??run.policy.base,[n.grain.specification]);
			return journeyText(root,file);
		},
		/** @param {unknown} args @param {string} actor */
		async claimWriter(args, actor) {
			const a = record(args); fields(a, ["run", "grain", "token"]);
			if ((a.grain === undefined) === (a.token === undefined)) fail("invalid_selector", "Use exactly one of grain or the writer's kickoff token");
			const id = name(a.run, "run"), origin = cwd(), run = read(id);
			const grain = a.token === undefined ? name(a.grain, "grain") : grainForToken(run, text(a.token, "kickoff token"));
			const job = reservation(run, grain), issuer = job.e.issuer === actor;
			if (issuer && a.token !== undefined) fail("invalid_selector", "The original issuer confirms by grain, not by writer token");
			if (!issuer && (run.owner === actor || db().involving(actor).length))
				fail("foreign_assignment", "A session already involved in a run cannot claim a new worker identity");
			const claimant = job.e.claims?.[0];
			if (issuer && job.e.claims?.length !== 1)
				fail("missing_claim", "Exactly one existing writer must claim from its original worktree first");
			if (!await executable()) fail("unsupported_mode", "Writer recovery needs an executable session");
			const history = host.readHistory ?? fail("missing_history", "Native eventLog.read is unavailable");
			const proof = issuer ? undefined : await childProof(history, actor, origin, job);
			const request = issuer ? await issuerProof(history, job) : undefined;
			await requireReadyOwner(origin);
			verifyGeneration(origin, job.generation);
			const conflict = db().mutateLocked(id, r => {
				const live = reservation(r, grain), e = live.e;
				if (e.id !== job.e.id || e.callId !== job.e.callId || e.issuer !== job.e.issuer ||
					digest(e.args) !== digest(job.e.args) || live.generation !== job.generation)
					fail("stale_assignment", "Reservation changed while checking native provenance");
				const child = proof ?? claimant ?? fail("missing_claim", "Missing writer claim");
				if (r.owner === child.actor || db().involving(child.actor).length || Object.values(r.nodes).some(n => n.worker === child.actor))
					fail("conflicting_binding", "Writer identity is already bound");
				linkedGeneration(child.path, live.generation, origin);
				if (proof) {
					if (!e.claims?.some(c => c.actor === actor)) (e.claims ??= []).push(proof);
					else fail("duplicate_claim", "This writer already claimed; return to the original issuer");
					return e.claims.length !== 1;
				}
				if (!request || e.claims?.length !== 1 || digest(e.claims[0]) !== digest(child))
					fail("ambiguous_receipt", "Conflicting writer claims; no binding");
				journal(e,{type:"confirm",nativeId:child.actor,boundAt:Date.now()});
				e.claimedRequest=request;r.nodes[grain].worker=child.actor;
			});
			if (conflict) fail("ambiguous_receipt", "Conflicting writer claims; no binding");
			return { state: issuer ? "bound" : "awaiting_issuer", run: id, grain };
		},
		/** @param {unknown} args @param {string} actor @param {string} agentId */
		async readReference(args, actor, agentId) {
			const a = record(args); fields(a, ["run", "review", "repo", "revision", "path"]);
			const id = name(a.run, "run"), repo = name(a.repo, "reference checkout"), revision = text(a.revision, "reference revision");
			function binding() {
				const run = read(id); admitted(run);
				const jobs = reviews(run), job = jobs.find(r => r.id === a.review), squad = run.policy.squads.find(s => s.id === job?.squad);
				if (!job?.workflowId || !job.callId || job.issuer !== actor || job.state !== "issued" || !squad || !investigation(job, squad) ||
					referenceRepo(job.wake?.key) !== repo || jobs.some(r => r !== job && (r.workflowId === job.workflowId || r.callId === job.callId)) ||
					!currentReview(cwd(), run, job)) fail("foreign_assignment", "This investigation is not bound to that reference checkout");
				if (run.references?.[repo] !== revision) fail("missing_reference", "The requested revision is not the frozen reference");
				return job;
			}
			const job = binding();
			if (!agentId || !await host.isResearcher?.(text(job.workflowId, "workflow ID"), agentId))
				fail("foreign_assignment", "Only the active investigation's native direct researcher may read");
			const live = binding(); // The job may have settled or been revoked during SDK lookup.
			if (live.workflowId !== job.workflowId || live.callId !== job.callId) fail("stale_assignment", "The investigation changed during lookup");
			return referenceText(cwd(), { repo, revision }, text(a.path, "reference path"));
		},
		/** @param {string} actor */
		defaultMapRun(actor) {
			if (!hasLedger()) return;
			/** @type {Run|undefined} */ let best;
			for (const id of db().involving(actor)) {
				const r = read(id);
				if (!best || (r.active !== best.active ? r.active : r.activatedAt > best.activatedAt)) best = r;
			}
			return best?.id;
		},
		/** @param {string} actor @param {string} path @param {string} [prompt] */
		sessionStart(actor, path, prompt) {
			if (directory !== path) {
				if (database) fail("workspace_changed", "Foundry's bound workspace changed; reopen the session");
				directory = path;
				root = existingPath = undefined;
				outsideRepository = false;
			}
			// Desktop can prepend tagged workspace instructions to the original kickoff.
			// This marker restricts the session before binding; it does not authorize any writer operation.
			if (prompt && assignment(prompt.replace(/^(?:<([\w-]+)>\n[\s\S]*?\n<\/\1>\n+)+/, ""))) known.add(actor);
			supervisor.register(actor,()=>{
				if (hasLedger()) for (const id of db().involving(actor)) {
					const run=read(id);
					if(contractHold(run))continue;
					forms.attach(run,actor,true);
					for (const e of dispatches(run)) if (externalReply(e) && e.issuer===actor && e.callId && !nativeCalls.has(e.callId))
						nativeCalls.set(e.callId,{run:id,id:e.id,actor});
					if (capacityWaiting(run,actor)) wakeCapacity(id,actor);
					supervisor.observe(id,actor,gate(run,actor,run.active && !observeTarget(()=>commitAt(cwd(),run.policy.target)).target),true);
				}
			});
		},
		/** @param {string} actor @param {string} [shellId] */
		turn(actor, shellId) {
			if (closed || outsideRepository || shellId !== undefined && !/^foundry-[a-f0-9-]{36}$/.test(shellId))
				return;
			try {
				if (!hasLedger())
					return;
				turnNumber++;
				for (const id of db().involving(actor)) {
					if (shellId && !read(id).effects.some(e => e.issuer === actor && e.tool === "bash" && e.args.shellId === shellId)) continue;
					track(drive(id, actor, true));
				}
			}
			catch (e) {
				host.log?.(`Foundry: ${String(e)}`);
			}
		},
		/** @param {Parameters<typeof refusedCall>[0]} event @param {string} actor */
		refusal(event, actor) {
			const callId = refusedCall(event);
			if (callId) this.post(callId, { resultType: "denied" }, actor);
		},
		/** A primary completion is only a hint to read the exact recorded request and reply.
		 * @param {string} callId @param {string} actor */
		completion(callId,actor) {
			const ctx=nativeCalls.get(callId);
			if (ctx?.actor===actor && !ctx.inFlight) track(readCompletions(ctx.run,actor,callId));
		},
		/** @param {string} callId @param {unknown} result @param {string} actor */
		post(callId, result, actor) {
			const ctx = nativeCalls.get(callId);
			if (ctx?.actor === actor)
				track(settle(ctx,callId,result).then(terminal=>terminal && !closed ? drive(ctx.run,actor) : undefined));
		},
		async flush() {
			while (background.size)
				await Promise.all([...background]);
		},
		close() {
			closed = true;lifetime.abort();
			receipts.close(); supervisor.close();
			for (const timer of capacityWakes.values()) clearTimeout(timer);
			capacityWakes.clear(); database?.close(); database = undefined;
		},
	};
}
