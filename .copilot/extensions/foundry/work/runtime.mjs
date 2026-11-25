import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { preparePublication, reportedReferences } from "./artifacts.mjs";
import { prepareBaselines } from "./baseline.mjs";
import { attribute } from "./blockers.mjs";
import { childProof, grainForToken, issuerProof, linkedGeneration, reservation, verifyGeneration } from "./binding.mjs";
import { openDatabase, ledgerPath } from "./database.mjs";
import { readPolicy } from "./contract.mjs";
import { prepareCorrection } from "./correction.mjs";
import { presentQuestions } from "./decisions.mjs";
import { advance, currentReview, newRun, reserveChangedRepair, reserveIteration, retryableReview, sameReviewInputs } from "./graph.mjs";
import { baselineNotice, changedFrom, comparisonGoal, comparisonVerdict, goalReceipt, inconclusiveRepair, qualifiedProduct, relinquishable, stopForInput } from "./evidence.mjs";
import { observeTarget, releaseAssessment } from "./goal.mjs";
import { admitted, assignment, boundWriter, canDispatch, current, expired, identify, issue, receive, reserveCheck } from "./native.mjs";
import { awaitingReply, unissued } from "./reservation.mjs";
import { checked } from "./plan.mjs";
import { attachNotes, queueNote } from "./notes.mjs";
import { diagnosticLine, indexBudgetError } from "./pages.mjs";
import { configure } from "./policy.mjs";
import { chooseWriters } from "./pool.mjs";
import { acceptWorkspace, writerRoot } from "./workspace.mjs";
import { capture, changedFiles, commitAt, directoryBaseline, generationRoot, retain, rootAt, treeOf, verifyContracts } from "./product.mjs";
import { refusedCall } from "./recovery.mjs";
import { checkAuthority, prepareRecheck } from "./recheck.mjs";
import { prepareRepin } from "./repin.mjs";
import { prepareResume, resumable } from "./resume.mjs";
import { transferRequest } from "./transfer.mjs";
import { stoppedCheck, successorRequest } from "./successor.mjs";
import { reportReceiver } from "./reports.mjs";
import { retireGoal } from "./retirement.mjs";
import { prepareReuse } from "./reuse.mjs";
import { prepareRestoration } from "./restoration.mjs";
import { currentPair, preparePair } from "./pairing.mjs";
import { referenceText } from "./research.mjs";
import { blockReview, comparison, currentPin, investigation, questions, reserveReview, retireSuperseded, reviews, staleReaderMessage } from "./reviews.mjs";
import { scoutPacket } from "./scouts.mjs";
import { status } from "./status.mjs";
import { FoundryError, assignmentDirectory, digest, fail, fields, mixed, name, record, referenceRepo, relative, text, roots as scopePaths } from "./values.mjs";
import { boardFacts } from "./visibility.mjs";
import { receiptClock, receiptWakes } from "./wakes.mjs";

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
 * ask?:(message:string)=>Promise<string|null>,confirm?:(message:string)=>Promise<boolean>,
 * readHistory?:import("@github/copilot-sdk").CopilotSession["rpc"]["eventLog"]["read"],isResearcher?:(workflowId:string,agentId:string)=>Promise<boolean>,
 * scoutBudget?:()=>Promise<number>,scoutFailure?:(workflowId:string,label:string)=>Promise<string|undefined>,confirmNoReport?:(r:import("./model.js").Review)=>Promise<void>,
 * scout?:(run:string,dispatch:string,actor:string)=>Promise<ScoutEnvelope>,scoutState?:(workflowId:string)=>Promise<ScoutEnvelope>,
 * scoutSnapshot?:(workflowId:string)=>Promise<ScoutEnvelope>,resumeScout?:(workflowId:string)=>Promise<ScoutEnvelope>,
 * mode:()=>Promise<string>,idleWriter?:(id:string)=>Promise<string|undefined>,runningHelpers?:(workflows:string[])=>Promise<string[]>,permissionBlocker:()=>Promise<import("./permissions.mjs").PermissionBlock|null>,log?:(message:string)=>void,watchReceipts?:typeof receiptClock}} Host */
/** @param {Run} run @param {string} [reason] */
function pause(run, reason) {
	run.active = false;
	if (reason) run.pauseReason = reason;
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
	return node;
}

/** @param {Run} run @param {string} actor */
const reservations = (run, actor) => run.effects.filter(e => e.issuer === actor && unissued(e) && canDispatch(run, e));
/** @param {Run} run @param {string} ticket @param {string} actor */
const batchOf = (run, ticket, actor) => reviews(run).filter(e => e.callId === ticket && e.issuer === actor);
// workflow.run rejects before creating a run when the session is full. Match only
// that admission error, including its persisted form from earlier readers.
const capacityRejection = /^Discovery unconfirmed: Error: This session already has [1-9]\d* active workflow runs, which is the concurrent limit\. Resume to retry unbound discovery\.$/;
const waitingForSlot = "Queued for workflow capacity; the issuing session will retry automatically.";
/** @param {import("./model.js").Review} e */
function requeueCapacity(e) {
	if (e.state !== "uncertain" || !e.callId || e.workflowId || !capacityRejection.test(e.error ?? "")) return false;
	e.state = "ready"; delete e.callId; e.error = waitingForSlot;
	return true;
}
/** @param {string} directory @param {Host} host */
export function createRuntime(directory, host) {
	/** @type {ReturnType<typeof openDatabase>|undefined} */ let database;
	let root, closed = false, outsideRepository = false, turnNumber = 0;
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
	/** @param {string} actor */
	const writerSession = actor => known.has(actor) || hasLedger() && db().involving(actor).some(id => read(id).owner !== actor);
	/** @param {string} id @param {(run:Run)=>void} mutate */
	function change(id, mutate) {
		return db().planAndSwap(id, run => {
			const count = run.products.length, final = qualifiedProduct(run);
			mutate(run);
			if (run.products.length !== count || qualifiedProduct(run) !== final)
				return () => observeTarget(() => commitAt(cwd(), run.policy.target)).target === run.products.at(-1)?.target;
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
				(stop ? ` Then explicitly resume ${id} from its owner.` : " Its next turn rechecks the hold.") : null;
			const changed = message && live.some(e => e.permissionHold !== message);
			for (const e of live) {
				if (message) e.permissionHold = message;
				else delete e.permissionHold;
			}
			if (stop && message) { pause(run, message); return { state: "paused", message }; }
			return { state: changed ? "held" : undefined, message };
		});
		if (!result) return "The reservation changed or the run is already paused. Check foundry_status.";
		if (result.state) host.log?.(`Foundry ${id} ${result.state}: ${result.message}`);
		return result.message;
	}
	/** @param {Call} ctx @param {string} callId @param {unknown} result @param {boolean} [automatic] */
	function settle(ctx, callId, result, automatic = false) {
		if (closed) return;
		const terminal = db().mutateLocked(ctx.run, run => {
			const e = run.effects.find(x => x.id === ctx.id);
			if (!e || e.tool === "workflow" || e.callId !== callId || e.issuer !== ctx.actor || !awaitingReply(e)) return true;
			try {
				receive(run, e, result, automatic);
			} catch (error) {
				e.state = "uncertain";
				e.error = String(error);
			}
			return !awaitingReply(e);
		});
		if (terminal) nativeCalls.delete(callId);
		return terminal;
	}
	/** @param {string} id @param {Effect} e @param {string} callId @param {()=>Promise<unknown>} invoke @param {boolean} [automatic] */
	async function resolveCall(id, e, callId, invoke, automatic = false) {
		const ctx = { run: id, id: e.id, actor: e.issuer, inFlight: true, recoveredOn: automatic ? undefined : turnNumber };
		nativeCalls.set(callId, ctx);
		let result;
		try { result = await invoke(); }
		catch (error) { result = { resultType: "unconfirmed", error: String(error) }; }
		finally { ctx.inFlight = false; }
		return settle(ctx, callId, result, automatic);
	}
	/** @param {string} id @param {Effect} effect @param {string} callId */
	const claim = (id, effect, callId) => {
		if (effect.tool!=="bash" || !(effect.recheck || effect.pair) || !unissued(effect)) return db().mutateLocked(id, run => issue(run, effect, callId));
		const target = (effect.recheck ?? effect.pair)?.target;
		let claimed = false;
		db().planAndSwap(id,run => {
			claimed = (effect.pair ? currentPair(cwd(),run,effect) : checkAuthority(cwd(),run,effect)) && issue(run,effect,callId);
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
		});
		const wake = { discover, recover, work }; wakes.set(key, wake);
		return work;
	}
	/** @param {string} id @param {string} actor @param {boolean} discover @param {boolean} recoverCalls */
	async function reconcile(id, actor, discover, recoverCalls) {
		if (!await executable())
			return;
		const recover = host.recover, lookups = [];
		if (recoverCalls) for (const e of read(id).effects) {
			// A same-session SDK notice has no native tool history. Never replay it.
			const callId = e.callId;
			if (!callId || e.issuer !== actor || e.tool === "session.send" || !awaitingReply(e)) continue;
			if (e.tool === "workflow") {
				if (!scoutCalls.has(callId)) {
					const { workflowId } = e, lookup = host.scoutState;
					if (workflowId && lookup) watchScouts(id, callId, actor, () => lookup(workflowId));
					else if (!e.workflowId && e.state === "issued") unconfirmedScouts(id, actor, callId, "No workflow ID was recorded before reconnect.");
				}
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
			const run = change(id, run => {
				const observed = run.active && !expired(run) ? observeTarget(() => commitAt(cwd(),run.policy.target)) : undefined;
				unavailable = !!observed && observed.target===undefined;
				if (unavailable) return;
				if (run.active && !expired(run)) for (const e of reviews(run)) {
					if (e.issuer !== actor) continue;
					requeueCapacity(e);
					if (e.state === "ready" && e.error === waitingForSlot && !currentReview(cwd(), run, e, observed?.target))
						blockReview(e, "Superseded while waiting for workflow capacity.");
				}
				// Don't reserve newly available work on behalf of an issuer already on hold.
				if (!reservations(run, actor).some(e => e.permissionHold))
					advance(cwd(), run, actor, discover, { submitToken: reply?.token, target:observed?.target });
			});
			receipts.observe(run, actor);
			if (unavailable) return;
			if (actor === run.owner && run.active && !expired(run) && host.ask && !asking.has(id) && questions(run).some(r => !r.decision)) {
				asking.add(id);
				track(presentQuestions(cwd(), () => closed ? undefined : db(), id, actor, host, executable, refill).finally(() => asking.delete(id)));
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
				} else if (e.tool==="bash" && (e.recheck || e.pair)) return; // A later eligible issuer turn can recheck the approval.
				await refill();
			}
		}
	}
	/** @param {string} id @param {string} actor @param {string} ticket @param {string} message */
	function unconfirmedScouts(id, actor, ticket, message) {
		const queued = db().mutateLocked(id, r => {
			let deferred = false;
			for (const e of batchOf(r, ticket, actor).filter(awaitingReply)) {
				e.state = "uncertain";
				e.error = `Discovery unconfirmed: ${message}. ${e.workflowId ? "Recheck the original workflow; no replacement started." : "Resume to retry unbound discovery."}`;
				if (requeueCapacity(e)) deferred = true;
			}
			return deferred && r.active && !expired(r);
		});
		if (queued) wakeCapacity(id,actor);
	}
	/** @param {string} id @param {string} actor */
	function wakeCapacity(id, actor) {
		if (capacityWakes.has(id)) return;
		capacityWakes.set(id, setTimeout(() => {
			capacityWakes.delete(id);
			if (!closed) track(Promise.resolve().then(() => capacityWaiting(read(id),actor) ? drive(id, actor, true, false) : undefined));
		}, 15_000).unref());
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
			e.state = "suspended";
			const action = e.issuer === run.owner ? `Use /foundry resume ${run.policy.source} in the owner session.` :
				`On explicit request resume the original workflow ID in its issuing session ${e.issuer}, without changing limits.`;
			e.error = `Discovery ${result.status}: workflow ${e.workflowId}. ${action}`;
			retireSuperseded(run, e);
		} else blockReview(e, `Discovery ${result.status}: ${result.failure?.type ?? result.error ?? result.reason ?? "no report was received"}`);
	}
	/** A workflow's settled attempt accounts for missing reports, never for checked work.
	 * @param {string} id @param {string} ticket @param {string} actor @param {()=>Promise<ScoutEnvelope>} invoke */
	function watchScouts(id, ticket, actor, invoke) {
		// Arm these continuations on the issuing call path. A workflow body only
		// journals and signals its report; it must not launch the next workflow.
		/** @type {Map<string,()=>Promise<void>>} */ const reports = new Map();
		for (const r of batchOf(read(id), ticket, actor).filter(awaitingReply)) {
			let signal = () => {};
			const reported = new Promise(resolve => { signal = () => resolve(undefined); });
			const wake = reported.then(() => { if (!closed) return drive(id, actor, true, false); });
			reports.set(r.id, () => { reports.delete(r.id); signal(); return wake; });
		}
		scoutCalls.set(ticket, reports);
		void Promise.resolve().then(invoke).then(result => {
			if (closed || scoutCalls.get(ticket) !== reports) return;
			const reconcile = db().mutateLocked(id, r => {
				const batch = batchOf(r, ticket, actor), pending = batch.filter(awaitingReply);
				for (const e of pending) settleScout(r, e, result);
				return pending.length > 0 || batch.some(e => reports.has(e.id));
			});
			if (reconcile) track(drive(id, actor, true, false));
		}, error => { if (!closed && scoutCalls.get(ticket) === reports) unconfirmedScouts(id, actor, ticket, String(error)); })
			.catch(error => host.log?.(`Foundry discovery: ${String(error)}`)).finally(() => {
				if (scoutCalls.get(ticket) === reports) scoutCalls.delete(ticket);
			});
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
			if (pending.length && r.active && block?.scope === "run") pause(r, `${block.message} Check session ${actor}.`);
			// A resumed body must not turn a permission race into a completed zero-job
			// workflow or discard its identity to get another launch.
			if (held && pending.some(e => e.workflowId)) {
				heldReason = block?.message ?? `Discovery cannot execute in session ${actor} while paused, expired or ineligible.`;
				return guard;
			}
			for (const e of pending) {
				if (held) {
					e.state = "ready"; delete e.callId;
					if (block) e.permissionHold = `${block.message} Check session ${actor}.`;
				} else {
					if (!e.workflowId && !e.retryOf && r.goal?.commit === e.base) {
						const squad = r.policy.squads.find(s => s.id === e.squad);
						if (squad && !investigation(e, squad)) attachNotes(r, e);
					}
					e.workflowId = workflowId; e.state = "issued";
				}
				delete e.error;
			}
			return guard;
		});
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
				if (args.relinquish !== undefined) {
					const failed = relinquishable(live,node);
					if (!failed || failed.id !== check || node.candidate)
						fail("stale_assignment", "Not the bound writer's current relinquishable component repair");
					if (live.effects.some(e => e.grain === node.grain.id && (awaitingReply(e) || unissued(e) && current(live,e))))
						fail("dispatch_held", "Resolve the outstanding assignment call first");
					db().verifySigned(id,failed);
					node.stop = {kind:"writer-relinquished",detail:reason};
					node.reason = `Writer relinquished repair after component ${check} (exit ${failed.receipt?.exit}): ${reason}`;
					node.state = "blocked";
					return;
				}
				const receipt = inconclusiveRepair(node, live.effects.find(e => e.id === node.check));
				if (check && (!receipt || check !== node.check)) fail("stale_assignment", "Not the inconclusive component check for this inline repair");
				if (receipt) {
					node.stop = {kind:"writer-cannot-repair", detail:reason};
					node.candidate = receipt.commit;
					node.reason = `Writer cannot repair component ${node.check} under this assignment: ${reason}`;
					node.state = "blocked";
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
			let target;
			const review = node.review && r.effects.find(e => e.id === node.review);
			const previous = review && review.kind === "scout" && review.predecessor;
			if (node.restoration && (typeof g.directory!=="string" || directoryBaseline(cwd(),commit,g.directory)?.tree!==node.restoration.tree))
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
			node.state = "checking";
			node.candidate = commit;
			node.check = reserveCheck(r, actor, cwd(), commit, g.check, g.id, reports);
			if (target) return () => commitAt(cwd(), r.policy.target) === target;
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
	/** SDK observations settle per attempt. Only this explicit owner path may
	 * continue a verified workflow; waitForRun and ordinary turns never do.
	 * @param {string} id @param {string} actor @param {string} ticket @param {string} workflowId */
	async function continueScouts(id, actor, ticket, workflowId) {
		const lookup = host.scoutSnapshot, resume = host.resumeScout;
		if (!lookup || !resume) return;
		const origin = cwd();
		const result = await lookup(workflowId);
		if (result.runId !== workflowId) fail("wrong_workflow", "Discovery lookup returned another workflow");
		if (result.status === "pending" || result.status === "running") return;
		if (!await executable()) return;
		if (resumable(result)) await requireReadyOwner(origin);
		if (continuing.has(ticket)) return;
		const shouldResume = db().mutateLocked(id, run => {
			if (run.owner !== actor || !run.active || expired(run)) return false;
			const pending = batchOf(run, ticket, actor).filter(e => e.workflowId === workflowId && awaitingReply(e));
			for (const e of pending) settleScout(run, e, result);
			return pending.some(e => e.state === "suspended");
		});
		if (shouldResume) {
			// Replace any observer that may still be delivering the prior paused envelope.
			continuing.add(ticket);
			watchScouts(id, ticket, actor, () => resume(workflowId).finally(() => continuing.delete(ticket)));
		}
	}
	/** @param {unknown} source @param {string} actor @param {boolean} resume */
	async function start(source, actor, resume) {
		if (writerSession(actor)) fail("worker_cannot_start", "Workers cannot activate or restart a run");
		if (!await executable()) fail("unsupported_mode", "Start only from an interactive or autopilot owner");
		const origin = cwd(), { policy, grains } = readPolicy(origin, source);
		const store = existsSync(file()) ? db() : undefined;
		const prior = store?.read(policy.id);
		if (resume && !prior) fail("missing_run", `No run to resume for ${policy.source}`);
		if (prior) {
			if (prior.owner !== actor || prior.policy.source !== policy.source)
				fail("run_conflict", "Another owner or contract already uses this run ID");
			verifyContracts(origin, prior.policy, policy.base);
			if (prior.goal && qualifiedProduct(prior)) return status(prior, actor);
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
		} else if (!prior.active || resume) {
			const plan = prepareResume(prior, resume, !!host.scoutSnapshot);
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
		const missing = release ? (["target-unavailable","ownership-conflict"].includes(release.reason) && "error" in release && release.error) :
			run.active && observeTarget(tip).error;
		return { ...result, ...(release && {release}),
			...(typeof missing==="string" && !result.blocker?.includes(missing) ? {blocker:[result.blocker,missing].filter(Boolean).join("\n")} : {}) };
	}
	/** @param {string} op @param {unknown} args @param {string} actor */
	async function operation(op, args, actor) {
		if (op === "status") return inspect(args, actor);
		const a = record(args);
		if (op === "start" || op === "resume") {
			fields(a, ["source"]);
			return start(a.source, actor, op === "resume");
		}
		const id = name(a.run, "run");
		if (op === "workspace") {
			fields(a,["run","token"]);
			await requireReadyOwner(cwd());
			const token = text(a.token,"assignment token");
			const run = db().planAndSwap(id,r=>acceptWorkspace(r,actor,token,cwd())), n = writable(run,actor,token);
			if (!n?.workspace || n.state!=="writing") fail("stale_assignment","Need the current pooled writer's writable assignment");
			writerRoot(cwd(),run,n,true);
			return status(run,actor);
		}
		if (op === "correct" || op === "reuse" || op === "restore" || op==="pair") {
			const origin = cwd(), request = op==="restore" || op==="pair" ? (op==="pair" ? preparePair : prepareRestoration)(origin,read(id),actor,a,e=>db().verifySigned(id,e)) :
				(op === "reuse" ? prepareReuse : prepareCorrection)(origin,read(id),actor,a);
			await requireReadyOwner(origin);
			const approved = await host.confirm?.(request.prompt);
			if (approved === false) fail("approval_declined","Request not approved. No assignment changed. Do not ask again without a fresh request.");
			if (approved !== true) fail("approval_required","Approval is unavailable; no assignment changed");
			await requireReadyOwner(origin);
			const after = db().planAndSwap(id,request.apply);
			if (op === "correct") return status(after,actor);
			await drive(id,actor,false,false);
			return status(read(id),actor);
		}
		if (op === "recheck") {
			fields(a,["run","check"]);
			const origin = cwd(), before = read(id);
			const request = prepareRecheck(origin,before,actor,name(a.check,"check"),e=>db().verifySigned(id,e));
			if (!request) return status(before,actor,"proof");
			await requireReadyOwner(origin);
			const approved = await host.confirm?.(request.prompt);
			if (approved!==true) fail(approved===false ? "approval_declined" : "approval_required","Fresh observation not approved. No check was reserved.");
			await requireReadyOwner(origin);
			db().planAndSwap(id,request.apply);
			await drive(id,actor,false,false);
			return status(read(id),actor,"proof");
		}
		if (op === "retire") {
			fields(a, ["run","check"]);
			const origin = cwd(), reconcile = await retireGoal(origin, actor, name(a.check, "goal check"), {
				read: () => read(id), ready: () => requireReadyOwner(origin), history: host.readHistory,
				confirm: host.confirm, swap: fn => db().planAndSwap(id, fn) });
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
				await presentQuestions(cwd(), () => closed ? undefined : db(), id, actor, host, executable, () => drive(id, actor, true), request);
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
			const i = prior.iteration;
			if (sourceBlob && i?.source) {
				const approved = await host.confirm?.(`Open one replacement scout for blocked review ${review} of ${i.directory}/ in ${id}?\n` +
					`Checked product: ${prior.base}. Passing checkpoint: ${i.receipt}. Settled goal: ${i.source.goal}. Offered blob: ${i.blob}.\n` +
					`Question: ${i.question}\nOmitted source: ${i.source.file} at ${sourceBlob}\n${i.source.excerpt}\n` +
					"The original report stays blocked. Only a new report citing delivered evidence can staff work; no writer or check is replayed.");
				if (approved !== true) fail(approved===false?"approval_declined":"approval_required","No recovery approved; no replacement was started.");
			} else {
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
				const approved = await host.confirm?.(`Open one source-backed review for ${id}, ${input.directory}/ on checked product ${source.commit}?\n` +
					`Passing checkpoint: ${approvedCheckpoint}. Current ${input.successor?"settled":"exit-2"} goal: ${input.receipt}. Offered blob: ${input.blob}.\n` +
					`Question: ${input.question}\nVerbatim source at ${source.commit}:${source.file}:\n${source.excerpt}\n` +
					(input.files ? `If staffed, the writer may edit the whole primary directory and these exact existing regular files: ${JSON.stringify(input.files)}. No sibling files or parent directories.\n` : "") +
					(input.successor ? `Authorize one fresh narrow successor ${input.successor.to} to stopped assignment ${input.successor.from}, original signed component ${input.successor.check}, only on this product and only if this review supports it. All other paths remain reserved. Start from the current product, not the stopped writer's bytes. No previous receipt is replayed or promoted.` :
					input.transfer ? `Approve a conditional ownership transfer from ${input.transfer.from}@${input.transfer.candidate} to ${input.transfer.to} on this checkpoint. The parent retains ALL other paths, including future siblings. Only a matching, still-eligible proposal applies the transfer; no receipts or inputs are rewritten.` :
					"Approve a comparison only. No failure, release verdict, writer reassignment or check is implied. Only a supported scout proposal can staff a repair."));
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
				live.preview = commit;
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
		else if (op === "publish" && (a.baselines !== undefined || a.readBaselines !== undefined)) {
			const inspect = a.readBaselines !== undefined, key = inspect ? "readBaselines" : "baselines";
			fields(a, ["run", key]);
			const origin = cwd(), request = prepareBaselines(origin, read(id), actor, a[key], inspect);
			await requireReadyOwner(origin);
			const approved = await host.confirm?.(request.prompt);
			if (approved === false) fail("approval_declined", "Baseline access not approved. No assignment changed. Do not ask again without a fresh request.");
			if (approved !== true) fail("approval_required", "Baseline approval is unavailable; no access granted.");
			await requireReadyOwner(origin);
			db().planAndSwap(id, request.apply);
			if (inspect) return status(read(id), actor);
		}
		else if (op === "publish") {
			fields(a, ["run", "token", "file", "to"]);
			db().mutateLocked(id, preparePublication(cwd(), read(id), actor, a));
		}
		else if (op === "repin") {
			const origin = cwd(), request = prepareRepin(origin, read(id), actor, a);
			if (a.kind === "product") await requireReadyOwner(origin);
			const approved = await host.confirm?.(request.prompt);
			if (approved === false) {
				const blocker = status(read(id), actor).blocker;
				fail("approval_declined", "Evaluator change not approved. No change or recheck was made. Do not ask again unless the operator requests it." +
					(blocker ? `\nCurrent run blocker: ${blocker}` : ""));
			}
			if (approved !== true) fail("approval_required", "The approval form is unavailable; the evaluator was not changed.");
			if (a.kind === "product") await requireReadyOwner(origin);
			else if (!await executable()) fail("unsupported_mode", "The owner session is no longer executable");
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
				e.state = "done"; delete e.error; r.nodes[grain].worker = child.actor;
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
			try {
				if (hasLedger()) for (const id of db().involving(actor)) {
					if (capacityWaiting(read(id),actor)) wakeCapacity(id,actor);
				}
			} catch (error) {
				host.log?.(`Foundry capacity recovery: ${String(error)}`);
			}
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
		/** @param {string} callId @param {unknown} result @param {string} actor */
		post(callId, result, actor) {
			const ctx = nativeCalls.get(callId);
			if (ctx?.actor === actor && settle(ctx, callId, result))
				track(drive(ctx.run, actor));
		},
		async flush() {
			while (background.size)
				await Promise.all([...background]);
		},
		close() {
			closed = true;
			receipts.close();
			for (const timer of capacityWakes.values()) clearTimeout(timer);
			capacityWakes.clear(); database?.close(); database = undefined;
		},
	};
}
