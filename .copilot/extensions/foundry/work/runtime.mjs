import { randomUUID } from "node:crypto";
import { assign } from "./assignment.mjs";
import { activate, hold, permitted } from "./activity.mjs";
import { journal, survey } from "./dispatch.mjs";
import { existsSync, readFileSync } from "node:fs";
import { preparePublication, reportedReferences } from "./artifacts.mjs";
import { prepareBaselines } from "./baseline.mjs";
import { attribute } from "./blockers.mjs";
import { childProof, grainForToken, issuerProof, linkedGeneration, reservation, verifyGeneration } from "./binding.mjs";
import { openDatabase, ledgerPath } from "./database.mjs";
import { journeyText, readPolicy } from "./contract.mjs";
import { prepareCorrection } from "./correction.mjs";
import { prepareCheckpoint } from "./checkpoint.mjs";
import { activeDelivery } from "./batch.mjs";
import { prepareDelivery } from "./delivery.mjs";
import { presentQuestions } from "./decisions.mjs";
import { advance, currentReview, newRun, reserveChangedRepair, reserveIteration, retryableReview, sameReviewInputs } from "./graph.mjs";
import { baselineNotice, changedFrom, comparisonGoal, comparisonVerdict, goalReceipt, inconclusiveRepair, qualifiedProduct, relinquishable, stopForInput } from "./evidence.mjs";
import { checkpointSurvey, movingSurvey, observeTarget, releaseAssessment } from "./goal.mjs";
import { admitted, assignment, boundWriter, canDispatch, current, expired, identify, issue, receive, reserveCheck } from "./native.mjs";
import { awaitingReply, unissued } from "./reservation.mjs";
import { checked } from "./plan.mjs";
import { attachNotes, queueNote } from "./notes.mjs";
import { diagnosticLine, indexBudgetError } from "./pages.mjs";
import { configure } from "./policy.mjs";
import { chooseWriters } from "./pool.mjs";
import { acceptWorkspace, writerRoot } from "./workspace.mjs";
import { capture, changedFiles, commitAt, contractConflict, directoryBaseline, generationRoot, regularFiles, retain, rootAt, treeOf, verifyContracts } from "./product.mjs";
import { refusedCall } from "./recovery.mjs";
import { checkAuthority, prepareRecheck } from "./recheck.mjs";
import { prepareRerun } from "./rerun.mjs";
import { prepareRepin } from "./repin.mjs";
import { prepareResume, resumable } from "./resume.mjs";
import { transferRequest } from "./transfer.mjs";
import { stoppedCheck, successorRequest } from "./successor.mjs";
import { reportReceiver } from "./reports.mjs";
import { retireGoal } from "./retirement.mjs";
import { prepareReuse } from "./reuse.mjs";
import { prepareRestoration } from "./restoration.mjs";
import { currentPair, preparePair } from "./pairing.mjs";
import { observerBasis, observerWriter, prepareObserver, verifyObserver } from "./observer.mjs";
import { prepareProduction, productionBasis, submitProduction } from "./production.mjs";
import { productionWriter, remedyWriter } from "./remedy.mjs";
import { referenceText } from "./research.mjs";
import { blockReview, comparison, currentPin, investigation, questions, reserveReview, retireSuperseded, reviews, staleReaderMessage } from "./reviews.mjs";
import { scoutPacket } from "./scouts.mjs";
import { status } from "./status.mjs";
import { FoundryError, assignmentDirectory, digest, fail, fields, mixed, name, record, referenceRepo, relative, text, roots as scopePaths } from "./values.mjs";
import { boardFacts, visible } from "./visibility.mjs";
import { contention, persist, receiptClock, receiptWakes } from "./wakes.mjs";
import { supervise, watchState, workflow } from "./supervision.mjs";
import { select } from "./chart.mjs";

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
/** @typedef {{run:string,id:string,actor:string,inFlight?:boolean,recoveredOn?:number}} Call */
/** @typedef {import("./resume.mjs").ScoutEnvelope} ScoutEnvelope */
/** @typedef {{execute:(tool:string,args:Effect["args"],id:string)=>Promise<unknown>,notify:(message:string)=>Promise<string>,recover?:(effect:Effect)=>Promise<unknown>,
 * ask?:(message:string)=>Promise<string|null>,confirm?:(message:string)=>Promise<boolean>,autoConfirm?:()=>Promise<boolean>,
 * readHistory?:import("@github/copilot-sdk").CopilotSession["rpc"]["eventLog"]["read"],isResearcher?:(workflowId:string,agentId:string)=>Promise<boolean>,
 * scoutBudget?:()=>Promise<number>,scoutFailure?:(workflowId:string,label:string)=>Promise<string|undefined>,confirmNoReport?:(r:import("./model.js").Review)=>Promise<void>,
 * scout?:(run:string,dispatch:string,actor:string)=>Promise<ScoutEnvelope>,scoutState?:(workflowId:string)=>Promise<ScoutEnvelope>,
 * scoutSnapshot?:(workflowId:string)=>Promise<ScoutEnvelope>,resumeScout?:(workflowId:string)=>Promise<ScoutEnvelope>,
 * mode:()=>Promise<string>,idleWriter?:(id:string)=>Promise<string|undefined>,runningHelpers?:(workflows:string[])=>Promise<string[]>,permissionBlocker:()=>Promise<import("./permissions.mjs").PermissionBlock|null>,log?:(message:string)=>void,watchReceipts?:typeof receiptClock,watchRecovery?:typeof receiptClock}} Host */
/** @param {Run} run @param {{reason:string,effect:Effect}} [policy] */
function pause(run, policy) {
	if (policy) hold(run,{issuer:policy.effect.issuer,effect:policy.effect.id,token:randomUUID()},policy.reason);
	else activate(run,"pause");
}

/** @param {Run} run @param {string} actor @param {string} token @param {unknown} [from] */
function writable(run, actor, token, from) {
	admitted(run);
	const node = boundWriter(run, actor, token);
	if (from !== undefined) {
		if (from !== changedFrom(node, run.effects.find(e => e.id === node.check)))
			fail("stale_assignment", "Not the bound writer's current blocked, unclassified component attempt");
		return node;
	}
	if (node.state === "checking" || checked(node)) return;
	if (node.state !== "writing") fail("stale_assignment", "This attempt is no longer writable");
	const notice = baselineNotice(run, node);
	if (notice && notice.state !== "done") fail("dispatch_held", "Await confirmed delivery of the approved baseline to the original writer");
	const review=run.effects.find(e=>e.id===node.review);
	if (review?.kind==="scout" && review.correction?.ordinary && review.correction.resumed?.token===token &&
		!run.effects.some(e=>e.kind==="repair" && e.grain===node.grain.id && e.token===token && e.state==="done" && !e.error))
		fail("dispatch_held","Await confirmed delivery of the corrected task to the original writer");
	return node;
}

/** @param {Run} run @param {string} actor */
const reservations = (run, actor) => run.effects.filter(e => e.issuer === actor && unissued(e) && canDispatch(run, e));
/** @param {Run} run @param {string} ticket @param {string} actor */
const batchOf = (run, ticket, actor) => reviews(run).filter(e => e.callId === ticket && e.issuer === actor);
/** @param {import("./model.js").Review} e */
const needsContinuation=e=>e.state==="suspended" && e.providerRecovery==="needed";
/** @param {Effect} e */
const externalReply=e=>(e.tool==="create_session" || e.tool==="send_session_message") && awaitingReply(e) && !!e.callId;
/** @param {unknown} error */
const transientStatus=error=>contention(error) || error instanceof Error && "code" in error &&
	(error.code==="ETIMEDOUT" || error.code==="ECONNRESET");
// workflow.run rejects before creating a run when the session is full. Match only
// that admission error, including its persisted form from earlier readers.
const capacityRejection = /^Discovery unconfirmed: Error: This session already has [1-9]\d* active workflow runs, which is the concurrent limit\. Resume to retry unbound discovery\.$/;
const waitingForSlot = "Queued for workflow capacity; the issuing session will retry automatically.";
/** @param {import("./model.js").Review} e */
function requeueCapacity(e) {
	if (e.state !== "uncertain" || !e.callId || e.workflowId || !capacityRejection.test(e.error ?? "")) return false;
	survey(e,"requeue"); delete e.callId; e.error = waitingForSlot;
	return true;
}
/** @param {string} directory @param {Host} host */
export function createRuntime(directory, host) {
	/** @type {ReturnType<typeof openDatabase>|undefined} */ let database;
	let root, closed = false, outsideRepository = false, turnNumber = 0;
	const lifetime=new AbortController();
	/** @template T @param {()=>T} write */
	const recordReply=write=>persist(write,lifetime.signal,error=>host.log?.(`Foundry is waiting to record an original reply: ${String(error)}`));
	/** @type {Set<string>} */ const known = new Set();
	/** @type {Set<Promise<unknown>>} */ const background = new Set();
	/** @type {Set<{run:string,actor:string,token:string}>} */ const submitting = new Set();
	/** @type {Set<string>} */ const asking = new Set();
	/** @type {Map<string,Call>} */ const nativeCalls = new Map();
	/** @type {Map<string,Map<string,()=>Promise<void>>>} */ const scoutCalls = new Map();
	/** @type {Map<string,NodeJS.Timeout>} */ const capacityWakes = new Map();
	/** @type {Set<string>} */ const continuing = new Set();
	/** @type {Map<string,{discover:boolean,recover:boolean,work:Promise<void>}>} */ const wakes = new Map();
	/** @type {string|undefined} */ let existingPath;
	const cwd = () => root ??= rootAt(directory);
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
		return database ??= openDatabase(cwd(), file(), create, requireCurrentReader);
	}
	/** @param {string} id */
	const read = id => db().read(id) ?? fail("missing_run", `Unknown run ${id}`);
	const receipts = receiptWakes({ read, stamp: id => db().stamp(id), clock: host.watchReceipts ?? receiptClock,
		wake: (id, actor) => track(drive(id,actor,false,false)), log: error => host.log?.(`Foundry receipt observer: ${String(error)}`) });
	/** @param {Run} run @param {string} actor @param {boolean} [missing] @param {import("./supervision.mjs").Gate} [previous] @returns {import("./supervision.mjs").Observation} */
	function gate(run,actor,missing=false,previous) {
		const hold=run.policyHold, own=run.effects.filter(e=>e.issuer===actor);
		const unfinished=run.active && own.some(e=>e.kind==="scout" && needsContinuation(e));
		const ownerWork=previous==="issuer-permission" && run.active && actor===run.owner &&
			(reviews(run).some(r=>r.renewal?.state==="needed") || !!host.ask && questions(run).some(r=>!r.decision));
		// A paused issuer may still own an unissued reservation. Observe the owner's
		// later resume, without treating a readable policy as permission to undo a pause.
		const participant=!!(run.active || hold) && run.owner===actor || own.some(e=>awaitingReply(e) || unissued(e) && current(run,e));
		const state=watchState({expired:expired(run),managed:!run.active && hold?.issuer===actor,
			local:ownerWork || own.some(e=>!!e.permissionHold && unissued(e) && canDispatch(run,e)) || unfinished && previous==="issuer-permission",
			retryRead:unfinished && previous==="workflow-status",
			missing:run.active && participant && missing,participant});
		const pending=!!host.recover && run.active && !expired(run) && own.some(externalReply);
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
		if ((!recover && (only || !host.scoutState)) || !await observerExecutable()) return;
		const run=read(id), workflows=only?undefined:supervisor.statusReads(id,actor);
		if (!run.active || expired(run)) {workflows?.clear();return;}
		if(workflows)for(const [ticket,workflow] of workflows){
			if(batchOf(run,ticket,actor).some(e=>e.workflowId===workflow && awaitingReply(e)))observeWorkflow(id,ticket,actor,workflow);
			else workflows.delete(ticket);
		}
		if(!recover)return;
		await Promise.all(run.effects.flatMap(e=>externalReply(e) && e.issuer===actor && e.callId &&
			(!only || e.callId===only) && !nativeCalls.get(e.callId)?.inFlight ?
			[resolveCall(id,e,e.callId,()=>recover(e)).then(done=>done && !closed ? drive(id,actor,true,false) : undefined)] : []));
	}
	const supervisor=supervise({
		clock:host.watchRecovery ?? receiptClock,track,stamp:id=>db().stamp(id),
		sample:(id,actor,previous)=>gate(read(id),actor,previous==="missing-target",previous),
		tip:ref=>observeTarget(()=>commitAt(cwd(),ref)).target,
		permitted:async()=>await observerExecutable() && !await host.permissionBlocker() && await observerExecutable(),
		lookup:readCompletions,
		wake:async(id,actor,token)=>{
			if (!await observerExecutable()) return false;
			if (token) reactivate(id,actor,token);
			track(drive(id,actor,true)); // Sampling is independent of any slow native lookup or permission dialog in this dispatch.
			return true;
		},retryRead:contention,log:error=>host.log?.(`Foundry recovery observer: ${String(error)}`),
	});
	/** @param {string} actor */
	const writerSession = actor => known.has(actor) || hasLedger() && db().involving(actor).some(id => read(id).owner !== actor);
	/** @param {string} id @param {(run:Run)=>void} mutate */
	function change(id, mutate) {
		return db().planAndSwap(id, run => {
			const count = run.products.length, final = qualifiedProduct(run);
			const renewed = () => reviews(run).filter(r=>r.renewal?.state==="approved" && r.state==="observed").length;
			const prior = renewed();
			mutate(run);
			if (run.products.length !== count || qualifiedProduct(run) !== final)
				return () => observeTarget(() => commitAt(cwd(), run.policy.target)).target === run.products.at(-1)?.target;
			if (renewed()!==prior)
				return () => observeTarget(() => commitAt(cwd(),run.policy.target)).target === run.goal?.target;
		});
	}
	/** Check once for a batch, outside the write lock. A stale result must not pause unrelated work.
	 * @param {string} id @param {string} actor @param {Effect[]} batch */
	async function dispatchBlocker(id, actor, batch) {
		const block = await host.permissionBlocker();
		if (!await executable()) return "The issuing session is no longer in an executable mode.";
		if (!block && !batch.some(e => e.permissionHold)) return null;
		const expected = new Map(batch.map(e => [e.id, e.state]));
		const result = db().mutateLocked(id, run => {
			const live = reservations(run, actor);
			if (!live.some(e => expected.get(e.id) === e.state)) return;
			// Only the final notice can still be dispatched in a stopped goal. Never reopen it.
			const stop = block?.scope === "run" && run.active;
			const message = block ? `${block.message} Check session ${actor}.` +
				" Its next turn rechecks the hold; Foundry also watches for permitted settings." : null;
			const changed = message && live.some(e => e.permissionHold !== message);
			for (const e of live) {
				if (message) e.permissionHold = message;
				else delete e.permissionHold;
			}
			if (stop && message) { pause(run,{reason:message,effect:live.find(e=>expected.has(e.id)) ?? live[0]}); return { state: "paused", message }; }
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
			const e = run.effects.find(x => x.id === ctx.id);
			if (!e || e.tool === "workflow" || e.callId !== callId || e.issuer !== ctx.actor || !awaitingReply(e)) return true;
			try {
				receive(run, e, result, automatic);
			} catch (error) {
				journal(e,"unconfirmed");
				e.error = String(error);
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
	/** @param {string} id @param {Effect} effect @param {string} callId */
	const claim = (id, effect, callId) => {
		if (effect.tool==="workflow" || !(effect.recheck || effect.pair || effect.observer || effect.isolation || effect.production || effect.remedy) || !unissued(effect)) return db().mutateLocked(id, run => issue(run, effect, callId));
		let target = (effect.recheck ?? effect.pair)?.target;
		let claimed = false;
		db().planAndSwap(id,run => {
			if (effect.isolation) {
				target=run.independent?.target;
				claimed=target===commitAt(cwd(),run.policy.target) && !run.effects.some(x=>x.permissionHold) && issue(run,effect,callId);
			} else if (effect.production || effect.remedy) {
				const job=effect.production?effect:remedyWriter(run,effect);
				if (!job) fail("stale_assignment","Missing production repair binding");
				target=productionBasis(cwd(),run,job,effect.commit).target;
				claimed=issue(run,effect,callId);
			} else if (effect.observer) {
				target=effect.kind==="component" ? verifyObserver(cwd(),run,effect,text(effect.commit,"observer candidate"),true) :
					observerBasis(cwd(),run,effect).pair.target;
				claimed=issue(run,effect,callId);
			} else claimed = (effect.pair ? currentPair(cwd(),run,effect) : checkAuthority(cwd(),run,effect)) && issue(run,effect,callId);
			if (claimed) return () => !expired(run) && observeTarget(()=>commitAt(cwd(),run.policy.target)).target===target;
		});
		return claimed;
	};
	/** Merge wakeups for one issuer, never its in-flight calls or permission dialogs.
	 * @param {string} id @param {string} actor @param {boolean} [discover] @param {boolean} [recover] @returns {Promise<void>} */
	function drive(id, actor, discover = false, recover = true) {
		const key = JSON.stringify([id, actor]), prior = wakes.get(key);
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
	/** @param {string} id @param {string} actor @param {boolean} discover @param {boolean} recoverCalls */
	async function reconcile(id, actor, discover, recoverCalls) {
		if (!await executable()){
			supervisor.invalidate(id,actor);
			return;
		}
		const before=read(id), held=before.policyHold;
		supervisor.observe(id,actor,gate(before,actor));
		if (held?.issuer===actor && !expired(before) && !await host.permissionBlocker() && await executable())
			reactivate(id,actor,held.token);
		/** @type {import("./supervision.mjs").Gate|undefined} */ let deferredGate;
		if (before.active && !expired(before) && host.resumeScout && host.scoutSnapshot) {
			const tickets=new Map(reviews(before).flatMap(e=>e.issuer===actor && needsContinuation(e) && e.callId && e.workflowId ?
				[[e.callId,e.workflowId]] : []));
			for (const [ticket,native] of tickets) {
				const held=await continueScouts(id,actor,ticket,native,true);
				if (held) deferredGate=held;
			}
		}
		const recover = host.recover, lookups = [];
		if (recoverCalls) for (const e of read(id).effects) {
			// A same-session SDK notice has no native tool history. Never replay it.
			const callId = e.callId;
			if (!callId || e.issuer !== actor || e.tool === "session.send" || !awaitingReply(e)) continue;
			if (e.tool === "workflow") {
				if (e.workflowId) observeWorkflow(id,callId,actor,e.workflowId);
				else if (e.state === "issued" && !scoutCalls.has(callId)) unconfirmedScouts(id, actor, callId, "No workflow ID was recorded before reconnect.");
				continue;
			}
			if (!recover) continue;
			const call = nativeCalls.get(callId);
			if (call?.inFlight || call?.recoveredOn === turnNumber) continue;
			lookups.push(resolveCall(id, e, callId, () => recover(e)).then(terminal => terminal ? refill() : undefined));
		}
		await Promise.all([dispatch(), ...lookups]);
		async function refill() {
			await drive(id, actor, discover, false);
		}
		async function dispatch() {
			if (closed) return;
			const reply = [...submitting].findLast(s => s.run === id && s.actor === actor);
			let unavailable = false;
			const plan = (renew = false) => change(id, run => {
				const observed = run.active && !expired(run) ? observeTarget(() => commitAt(cwd(),run.policy.target)) : undefined;
				unavailable = !!observed && observed.target===undefined;
				if (unavailable) return;
				if (run.active && !expired(run)) for (const e of reviews(run)) {
					if (e.issuer !== actor) continue;
					requeueCapacity(e);
					if (e.state === "ready" && e.error === waitingForSlot && !currentReview(cwd(), run, e, checkpointSurvey(run,e) ? undefined : observed?.target))
						blockReview(e, "Superseded while waiting for workflow capacity.");
				}
				// Don't reserve newly available work on behalf of an issuer already on hold.
				if (!reservations(run, actor).some(e => e.permissionHold))
					advance(cwd(), run, actor, discover, { submitToken: reply?.token, target:observed?.target, renew });
			});
			let run = plan();
			if (!unavailable && actor===run.owner && run.active && !expired(run) && reviews(run).some(r=>r.renewal?.state==="needed")) {
				if (!await host.permissionBlocker() && await executable()) run=plan(true);
				else deferredGate="issuer-permission";
			}
			if (closed) return;
			receipts.observe(run, actor);
			supervisor.observe(id,actor,gate(run,actor,unavailable,deferredGate));
			if (unavailable) return;
			if (actor === run.owner && run.active && !expired(run) && host.ask && !asking.has(id) && questions(run).some(r => !r.decision)) {
				asking.add(id);
				track(presentQuestions(cwd(), () => closed ? undefined : db(), id, actor, host, executable, refill, recordReply).then(held=>{
					if (!closed && held) supervisor.observe(id,actor,gate(read(id),actor,false,held));
				}).finally(() => asking.delete(id)));
			}
			const batch = reservations(run, actor).filter(e => e.state === "ready" || e.permissionHold);
			if (!batch.length) return;
			if (await dispatchBlocker(id, actor, batch) !== null) return;
			const ready = batch.filter(e => e.state === "ready");
			if (!ready.length) return refill(); // Prepared calls are visible again; this issuer can now plan.
			const scouts = capacityWakes.has(id) ? [] : ready.filter(e => e.tool === "workflow");
			// SDK agent labels aren't unique identities. Give each frozen-reader job
			// its own dispatch so its native direct agent cannot belong to a peer job.
			const readers = scouts.filter(e => referenceRepo(e.wake?.key) && run.policy.squads.some(s => s.id === e.squad && investigation(e, s)));
			const ordinary = scouts.filter(e => !readers.includes(e));
			for (const jobs of [...(ordinary.length ? [ordinary] : []), ...readers.map(e => [e])]) {
				const ticket = randomUUID();
				if (db().mutateLocked(id, r => jobs.filter(e => issue(r, e, ticket)).length))
					watchScouts(id, ticket, actor, () => host.scout?.(id, ticket, actor) ?? Promise.reject(new Error("Workflow scouting is unavailable")));
			}
			// A sibling's native permission prompt must not hold up work unlocked by this reply.
			const jobs = ready.flatMap(e => host.idleWriter && e.kind === "writer" && e.tool === "create_session" ? [e] : []);
			await Promise.all([dispatchWriters(), ...ready.filter(e => e.tool !== "workflow" &&
				!(host.idleWriter && e.tool === "create_session")).map(send)]);

			async function dispatchWriters() {
				if (!jobs.length || !host.idleWriter) return;
				const match = await chooseWriters(cwd(), run, jobs, host.idleWriter, host.log);
				if (closed || await dispatchBlocker(id, actor, jobs) !== null) return;
				const live = match ? db().planAndSwap(id, match) : read(id), ids = new Set(jobs.map(e => e.id));
				await Promise.all(reservations(live, actor).filter(e => ids.has(e.id) && e.state === "ready" && !e.permissionHold).map(send));
			}
			/** @param {Effect} e */
			async function send(e) {
				const callId = randomUUID();
				if (!closed && claim(id, e, callId)) {
					if (e.tool === "bash") receipts.observe(read(id), actor);
					const completion = resolveCall(id, e, callId, async () => e.tool === "session.send"
						? { resultType: "success", messageId: await host.notify(text(e.args.message, "session notice")) }
						: host.execute(e.tool, e.args, callId), true);
					// Issuing the goal opens checkpoint discovery; don't wait for its native reply to schedule it.
					if (e.kind === "goal" && run.products.at(-1)?.commit === e.commit && run.scheduling?.checkpointReviews !== false)
						track(drive(id, actor, false, false));
					await completion;
				} else if (e.tool==="bash" && (e.recheck || e.pair || e.isolation)) return; // A later eligible issuer turn can recheck the approval.
				await refill();
			}
		}
	}
	/** @param {string} id @param {string} actor @param {string} ticket @param {string} message
	 * @param {(e:import("./model.js").Review)=>boolean} [pending] */
	function unconfirmedScouts(id, actor, ticket, message, pending=awaitingReply) {
		const queued = db().mutateLocked(id, r => {
			let deferred = false;
			for (const e of batchOf(r, ticket, actor).filter(pending)) {
				survey(e,"unconfirmed");
				e.error = `Discovery unconfirmed: ${message}. ${e.workflowId ? "Recheck the original workflow; no replacement started." : "Resume to retry unbound discovery."}`;
				if (requeueCapacity(e)) deferred = true;
			}
			return deferred && r.active && !expired(r);
		});
		if (queued) wakeCapacity(id,actor);
	}
	/** @param {string} id @param {string} actor @param {number} [delay] */
	function wakeCapacity(id, actor, delay=15_000) {
		if (capacityWakes.has(id)) return;
		capacityWakes.set(id, setTimeout(() => {
			capacityWakes.delete(id);
			if (!closed) track(Promise.resolve().then(() => capacityWaiting(read(id),actor) ? drive(id, actor, true, false) : undefined).catch(error=>{
				if(!closed && contention(error))wakeCapacity(id,actor,Math.min(60_000,delay*2));
				throw error;
			}));
		}, delay).unref());
	}
	/** @param {Run} run @param {string} actor */
	function capacityWaiting(run,actor) {
		return run.active && !expired(run) && reviews(run).some(e=>e.issuer===actor && e.state==="ready" &&
			!e.callId && !e.workflowId && e.error===waitingForSlot);
	}
	/** @param {Run} run @param {import("./model.js").Review} e @param {ScoutEnvelope} result */
	function settleScout(run, e, result) {
		if (e.workflowId && e.workflowId !== result.runId) fail("wrong_workflow", "Discovery result belongs to another workflow");
		if (e.workflowId && resumable(result)) {
			survey(e,"suspend");
			const disconnected=result.status==="halted" && result.failure?.type==="workflow_provider_disconnected";
			if (disconnected) e.providerRecovery ??= "needed";
			else if (e.providerRecovery==="needed") delete e.providerRecovery;
			const action = disconnected && e.providerRecovery==="needed" ? "The issuer will verify the provider and continue this workflow once." :
				e.issuer === run.owner ? `Use /foundry resume ${run.policy.source} in the owner session.` :
				`On explicit request resume the original workflow ID in its issuing session ${e.issuer}, without changing limits.`;
			e.error = `Discovery ${result.status}: workflow ${e.workflowId}. ${action}`;
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
			// Plan retry eligibility against one tip outside the lock. Recheck that exact tip at binding.
			const retries = batch.filter(e => e.retryOf && awaitingReply(e));
			const target = retries.length ? commitAt(cwd(), r.policy.target) : undefined;
			const guard = target ? () => commitAt(cwd(), r.policy.target) === target : undefined;
			for (const e of retries)
				if (!sameReviewInputs(cwd(), r, e, target) || e.diagnostic && e.diagnostic.receipt !== r.goal?.check)
					blockReview(e, "Superseded charter or product revision; the requested review was not dispatched.");
			const pending = batch.filter(e => awaitingReply(e) && currentPin(r, e));
			const held = !eligible || !r.active || expired(r) || block;
			if (pending.length && r.active && block?.scope === "run") pause(r,{reason:`${block.message} Check session ${actor}.`,effect:pending[0]});
			// A resumed body must not turn a permission race into a completed zero-job
			// workflow or discard its identity to get another launch.
			if (held && pending.some(e => e.workflowId)) {
				heldReason = block?.message ?? `Discovery cannot execute in session ${actor} while paused, expired or ineligible.`;
				return guard;
			}
			for (const e of pending) {
				if (held) {
					survey(e,"requeue"); delete e.callId;
					if (block) e.permissionHold = `${block.message} Check session ${actor}.`;
				} else {
					if (!e.workflowId && !e.retryOf && r.goal?.commit === e.base) {
						const squad = r.policy.squads.find(s => s.id === e.squad);
						if (squad && !investigation(e, squad)) attachNotes(r, e);
					}
					e.workflowId = workflowId; survey(e,"bind");
				}
				delete e.error;
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
			generationRoot(writerRoot(cwd(),run,n), text(n.generation, "generation commit"));
			db().planAndSwap(id, live => {
				const node = writable(live, actor, token);
				if (!node || node.generation !== n.generation || node.grain.id !== n.grain.id)
					fail("stale_assignment", "Assignment changed before recording the writer stop");
				if (live.effects.some(e => e.grain === node.grain.id && (e.permissionHold ||
					e.token === token && e.kind === "repair" && e.state !== "done")))
					fail("dispatch_held", "Resolve the pending assignment delivery or permission hold first");
				const job=productionWriter(live,token);
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
					node.reason = `Writer relinquished repair after component ${check} (exit ${failed.receipt?.exit}): ${reason}`;
					assign(node,"stop");
					return;
				}
				const receipt = inconclusiveRepair(node, live.effects.find(e => e.id === node.check));
				if (check && (!receipt || check !== node.check)) fail("stale_assignment", "Not the inconclusive component check for this inline repair");
				if (receipt) {
					node.stop = {kind:"writer-cannot-repair", detail:reason};
					node.candidate = receipt.commit;
					node.reason = `Writer cannot repair component ${node.check} under this assignment: ${reason}`;
					assign(node,"stop");
				} else stopForInput(node, reason);
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
			node.check = reserveCheck(r, actor, cwd(), commit, g.check, g.id, reports);
			const effect=r.effects.at(-1);
			if (observer?.observer) {
				if (effect?.kind!=="component") fail("invalid_observer","Missing writer component reservation");
				effect.observer={...observer.observer};
			}
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
				const action=select(workflow,"suspended","verified",{unused:!batch.some(e=>e.providerRecovery==="claimed"),
					disconnected:result.status==="halted" && result.failure?.type==="workflow_provider_disconnected",
					current:!!target && !run.independent && !activeDelivery(run) && !run.blocker && !run.conflict &&
						!run.effects.some(e=>e.permissionHold) && !contractConflict(origin,run.policy,target) &&
						pending.every(e=>sameReviewInputs(origin,run,e,target))}).action;
				if (action!=="continue") {
					if (result.status!=="halted" || result.failure?.type!=="workflow_provider_disconnected")
						for (const e of pending) settleScout(run,e,result);
					return;
				}
				for (const e of pending) e.providerRecovery="claimed";
				shouldResume=true;
				return ()=>observeTarget(()=>commitAt(origin,run.policy.target)).target===target;
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
		if (prior) {
			if (prior.owner !== actor || prior.policy.source !== filename)
				fail("run_conflict", "Another owner or contract already uses this run ID");
			const target = saved ? commitAt(origin,policy.target) : policy.base;
			const work = saved && movingSurvey(origin,prior,target);
			verifyContracts(origin,prior.policy,work?.target ?? target);
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
			const plan = prepareResume(prior, !!host.scoutSnapshot);
			if (!plan) return status(prior, actor);
			await requireReadyOwner(origin);
			change(policy.id, r => {
				plan.apply(r);
				if (plan.retryGoal) advance(origin, r, actor, false, { retryGoal: true });
			});
			await Promise.all([...plan.workflows].map(([ticket, workflowId]) => continueScouts(policy.id, actor, ticket, workflowId)));
		}
		await drive(policy.id, actor, true);
		return status(read(policy.id), actor);
	}
	/** @param {unknown} args @param {string} actor @returns {ReturnType<typeof status> & {release?:ReturnType<typeof releaseAssessment>}} */
	function inspect(args, actor) {
		const a = record(args); fields(a, ["run", "detail"]);
		const run = read(name(a.run, "run")), result = status(run, actor, a.detail);
		const tip = () => commitAt(cwd(), run.policy.target);
		const release = run.owner===actor && run.goal ? releaseAssessment(cwd(),run,tip) : undefined;
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
		if (op!=="pause" && activeDelivery(read(id))) fail("dispatch_held","An approved test delivery is in progress; wait for its original checks");
		if (op!=="pause" && read(id).independent) fail("ownership_transition","Independent checkpoint already reserved; the original ownership hold is not released");
		if (op === "workspace") {
			fields(a,["run","token"]);
			await requireReadyOwner(cwd());
			const token = text(a.token,"assignment token");
			const run = db().planAndSwap(id,r=>acceptWorkspace(r,actor,token,cwd())), n = writable(run,actor,token);
			if (!n?.workspace || n.state!=="writing") fail("stale_assignment","Need the current pooled writer's writable assignment");
			writerRoot(cwd(),run,n,true);
			return status(run,actor);
		}
		const baseline=op==="inspectBaseline" || op==="repairBaseline";
		if (baseline || op === "correct" || op === "reuse" || op === "restore" || op==="diagnose" || op==="checkpoint" || op==="remediate" || op==="deliver") {
			const origin = cwd(), run = read(id);
			let request;
			if(baseline){
				fields(a,["run","grains"]);
				request=prepareBaselines(origin,run,actor,a.grains,op==="inspectBaseline");
			}else{
				const prepare={correct:prepareCorrection,reuse:prepareReuse,restore:prepareRestoration,
					diagnose:prepareObserver,checkpoint:prepareCheckpoint,remediate:prepareProduction,deliver:prepareDelivery}[op];
				request=prepare(origin,run,actor,a,e=>db().verifySigned(id,e));
			}
			await requireReadyOwner(origin);
			const approved = await confirm(request.prompt);
			if (approved === false) fail("approval_declined","Request not approved. No assignment changed. Do not ask again without a fresh request.");
			if (approved !== true) fail("approval_required","Approval is unavailable; no assignment changed");
			await requireReadyOwner(origin);
			const after = db().planAndSwap(id,request.apply);
			if (op==="inspectBaseline" || op === "correct" && a.preview===undefined || op==="diagnose" && a.preview!==undefined) return status(after,actor);
			await drive(id,actor,false,op==="repairBaseline");
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
				if (e?.state==="ready" && await dispatchBlocker(id,actor,[e])===null) {
					const callId=randomUUID();
					if (claim(id,e,callId)) await resolveCall(id,e,callId,()=>host.execute(e.tool,e.args,callId),true);
				}
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
				pause(r);
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
			const ticket = randomUUID(), launch = host.scout ?? fail("unavailable", "Discovery workflow unavailable");
			db().planAndSwap(id, run => {
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
				if (!issue(run, fresh, ticket)) fail("stale_assignment", "Cannot issue fresh review");
				if (run.goal) delete run.goal.stall;
				const target = run.goal?.target;
				if (target) return () => commitAt(origin, run.policy.target) === target;
			});
			watchScouts(id, ticket, actor, () => launch(id, ticket, actor));
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
			const launch = host.scout ?? fail("unavailable", "Discovery workflow unavailable"), ticket = randomUUID();
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
				const preview = reserve(read(id));
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
			const after = db().planAndSwap(id, run => {
				const fresh = reserve(run);
				if (!fresh) return;
				if (source && fresh.iteration?.receipt !== approvedCheckpoint) fail("stale_assignment","The approved product checkpoint changed");
				if (!issue(run, fresh, ticket)) fail("stale_assignment", "Cannot issue focused review");
				const target = run.goal?.target;
				return () => commitAt(origin, run.policy.target) === target;
			});
			if (batchOf(after, ticket, actor).length) watchScouts(id, ticket, actor, () => launch(id, ticket, actor));
			return status(after, actor);
		}
		const reply = op === "submit" || op === "preview" ? { run: id, actor, token: text(a.token, "submission token") } : undefined;
		if (reply) {
			fields(a, op === "preview" ? ["run", "token"] : a.relinquish !== undefined ? ["run","token","relinquish"] : a.cannotRepair !== undefined ? ["run", "token", "cannotRepair"] :
				a.missingInput !== undefined ? ["run", "token", "missingInput"] : ["run", "token", "changedFrom", "usedArtifacts", "comparedArtifacts"]);
			// Check the host, not a local count lost on reload. Revalidate mode and ownership after the read.
			const run = read(id);
			if (host.runningHelpers && writable(run, actor, reply.token, a.changedFrom)) {
				const workflows = new Set(reviews(run).flatMap(r => r.issuer === actor && awaitingReply(r) && r.workflowId ? [r.workflowId] : []));
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
			return status(after, actor); // A preview never enters the scheduling or qualification paths.
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
			fields(a, ["run", "token", "file", "to"]);
			db().mutateLocked(id, preparePublication(cwd(), read(id), actor, a));
		}
		else if (op === "repin") {
			const origin = cwd(), request = prepareRepin(origin, read(id), actor, a,e=>db().verifySigned(id,e));
			await requireReadyOwner(origin);
			const approved = a.kind==="target" ? await host.confirm?.(request.prompt) : await confirm(request.prompt);
			if (approved === false) {
				const blocker = status(read(id), actor).blocker;
				fail("approval_declined", "Evaluator change not approved. No change or recheck was made. Do not ask again unless the operator requests it." +
					(blocker ? `\nCurrent run blocker: ${blocker}` : ""));
			}
			if (approved !== true) fail("approval_required", "The approval form is unavailable; the evaluator was not changed.");
			await requireReadyOwner(origin);
			db().planAndSwap(id, request.apply);
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
		const e = run.effects.find(e => e.issuer === actor && e.tool === tool && digest(e.args) === key && current(run, e));
		if (!e || e.state !== "ordinary" && !(e.state === "issued" && e.callId === callId))
			fail("unreserved_call", "Not a current prepared Foundry call");
		if (e.state === "ordinary") {
			if (!canDispatch(run, e)) admitted(run);
			const reason = await dispatchBlocker(id, actor, [e]);
			if (reason !== null) fail("dispatch_held", reason);
		}
		if (!claim(id, e, callId)) fail("unreserved_call", "The prepared call is no longer current");
		if (!nativeCalls.has(callId)) nativeCalls.set(callId, { run: id, id: e.id, actor });
	}
	/** @param {Promise<unknown>} p */
	function track(p) {
		const task = p.catch(e => host.log?.(`Foundry: ${String(e)}`)).finally(() => background.delete(task));
		background.add(task);
	}
	return {
		operation, inspect, pre, scoutBatch, scoutResult,
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
				e.nativeId = child.actor; e.boundAt = Date.now(); e.claimedRequest = request;
				journal(e,"confirm"); delete e.error; r.nodes[grain].worker = child.actor;
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
					for (const e of run.effects) if (externalReply(e) && e.issuer===actor && e.callId && !nativeCalls.has(e.callId))
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
