import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { preparePublication, reportedReferences } from "./artifacts.mjs";
import { childProof, issuerProof, linkedGeneration, reservation } from "./binding.mjs";
import { openDatabase, ledgerPath } from "./database.mjs";
import { readPolicy } from "./contract.mjs";
import { presentQuestions } from "./decisions.mjs";
import { advance, currentReview, newRun, parseObservation, reserveChangedRepair, retryableReview, sameReviewInputs } from "./graph.mjs";
import { changedFrom, missingObservation, qualifiedProduct } from "./evidence.mjs";
import { admitted, assignment, awaitingReply, boundWriter, canDispatch, current, expired, identify, issue, receive, reserveCheck, transferableWriter, unissued } from "./native.mjs";
import { checked } from "./plan.mjs";
import { capture, commitAt, generationRoot, retain, rootAt, verifyContracts } from "./product.mjs";
import { refusedCall } from "./recovery.mjs";
import { prepareRepin } from "./repin.mjs";
import { referenceText, researchResult } from "./research.mjs";
import { blockReview, currentPin, investigation, questions, reserveReview, retireSuperseded, reviews } from "./reviews.mjs";
import { scoutPacket } from "./scouts.mjs";
import { isPacket } from "./snapshot.mjs";
import { status } from "./status.mjs";
import { FoundryError, digest, fail, fields, name, record, referenceRepo, text } from "./values.mjs";

const readerFile = new URL("./reader.version", import.meta.url);
const loadedReader = readFileSync(readerFile, "utf8");
function requireCurrentReader() {
	try {
		if (readFileSync(readerFile, "utf8") === loadedReader) return;
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	fail("stale_reader", "The installed Foundry reader changed. Reload Foundry in this session, then check the original assignment's status. Do not restart the run.");
}

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Effect} Effect */
/** @typedef {{run:string,id:string,actor:string,inFlight?:boolean,recoveredOn?:number}} Call */
/** @typedef {{runId:string,status:string,error?:string,reason?:string,failure?:{type:string}}} ScoutEnvelope */
/** @typedef {{execute:(tool:string,args:Effect["args"],id:string)=>Promise<unknown>,notify:(message:string)=>Promise<string>,recover?:(effect:Effect)=>Promise<unknown>,
 * ask?:(message:string)=>Promise<string|null>,confirm?:(message:string)=>Promise<boolean>,
 * readHistory?:import("@github/copilot-sdk").CopilotSession["rpc"]["eventLog"]["read"],isResearcher?:(workflowId:string,agentId:string)=>Promise<boolean>,
 * scoutBudget?:()=>Promise<number>,scoutFailure?:(workflowId:string,label:string)=>Promise<string|undefined>,confirmNoReport?:(r:import("./model.js").Review)=>Promise<void>,
 * scout?:(run:string,dispatch:string,actor:string)=>Promise<ScoutEnvelope>,scoutState?:(workflowId:string)=>Promise<ScoutEnvelope>,
 * scoutSnapshot?:(workflowId:string)=>Promise<ScoutEnvelope>,resumeScout?:(workflowId:string)=>Promise<ScoutEnvelope>,
 * mode:()=>Promise<string>,runningHelpers?:(workflows:string[])=>Promise<string[]>,permissionBlocker:()=>Promise<import("./permissions.mjs").PermissionBlock|null>,log?:(message:string)=>void}} Host */
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
/** A halted attempt can also carry a declined limit change, accounting failure,
 * or other typed failure. Do not treat those as permission to resume.
 * @param {ScoutEnvelope} result */
const resumable = result => (result.status === "paused" || result.status === "halted") &&
	(!result.failure || result.failure.type === "workflow_provider_disconnected");

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
	/** @param {string} id @param {(run:Run)=>void} mutate */
	function change(id, mutate) {
		return db().change(id, run => {
			const count = run.products.length, final = qualifiedProduct(run);
			mutate(run);
			if (run.products.length !== count || qualifiedProduct(run) !== final)
				return () => commitAt(cwd(), run.policy.target) === run.products.at(-1)?.target;
		});
	}
	/** Check once for a batch, outside the write lock. A stale result must not pause unrelated work.
	 * @param {string} id @param {string} actor @param {Effect[]} batch */
	async function dispatchBlocker(id, actor, batch) {
		const block = await host.permissionBlocker();
		if (!await executable()) return "The issuing session is no longer in an executable mode.";
		if (!block && !batch.some(e => e.permissionHold)) return null;
		const expected = new Map(batch.map(e => [e.id, e.state]));
		const result = db().update(id, run => {
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
		const terminal = db().update(ctx.run, run => {
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
	const claim = (id, effect, callId) => db().update(id, run => issue(run, effect, callId));
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
			const run = change(id, run => {
				if (run.active && !expired(run)) for (const e of reviews(run)) {
					if (e.issuer !== actor) continue;
					requeueCapacity(e);
					if (e.state === "ready" && e.error === waitingForSlot && !currentReview(cwd(), run, e))
						blockReview(e, "Superseded while waiting for workflow capacity.");
				}
				// Don't reserve newly available work on behalf of an issuer already on hold.
				if (!reservations(run, actor).some(e => e.permissionHold))
					advance(cwd(), run, actor, discover, { submitToken: reply?.token });
			});
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
				if (db().update(id, r => jobs.filter(e => issue(r, e, ticket)).length))
					watchScouts(id, ticket, actor, () => host.scout?.(id, ticket, actor) ?? Promise.reject(new Error("Workflow scouting is unavailable")));
			}
			// A sibling's native permission prompt must not hold up work unlocked by this reply.
			await Promise.all(ready.filter(e => e.tool !== "workflow").map(async e => {
				const callId = randomUUID();
				if (!closed && claim(id, e, callId))
					await resolveCall(id, e, callId, async () => e.tool === "session.send"
						? { resultType: "success", messageId: await host.notify(text(e.args.message, "session notice")) }
						: host.execute(e.tool, e.args, callId), true);
				await refill();
			}));
		}
	}
	/** @param {string} id @param {string} actor @param {string} ticket @param {string} message */
	function unconfirmedScouts(id, actor, ticket, message) {
		const queued = db().update(id, r => {
			let deferred = false;
			for (const e of batchOf(r, ticket, actor).filter(awaitingReply)) {
				e.state = "uncertain";
				e.error = `Discovery unconfirmed: ${message}. ${e.workflowId ? "Recheck the original workflow; no replacement started." : "Resume to retry unbound discovery."}`;
				if (requeueCapacity(e)) deferred = true;
			}
			return deferred && r.active && !expired(r);
		});
		if (queued && !capacityWakes.has(id)) {
			// Slots may belong to unrelated workflows. No local completion or user
			// turn is guaranteed; coalesce retries through the normal dispatch path.
			capacityWakes.set(id, setTimeout(() => {
				capacityWakes.delete(id);
				if (!closed) track(drive(id, actor, true, false));
			}, 15_000).unref());
		}
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
			const reconcile = db().update(id, r => {
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
		const admission = db().update(id, r => {
			const batch = batchOf(r, ticket, actor);
			if (!batch.length || batch.some(e => e.workflowId && e.workflowId !== workflowId))
				fail("foreign_assignment", "No matching Foundry discovery dispatch in this session");
			for (const e of batch)
				if (e.retryOf && awaitingReply(e) && !sameReviewInputs(cwd(), r, e))
					blockReview(e, "Superseded charter or product revision; the requested review was not dispatched.");
			const pending = batch.filter(e => awaitingReply(e) && currentPin(r, e));
			const held = !eligible || !r.active || expired(r) || block;
			if (pending.length && r.active && block?.scope === "run") pause(r, `${block.message} Check session ${actor}.`);
			// A resumed body must not turn a permission race into a completed zero-job
			// workflow or discard its identity to get another launch.
			if (held && pending.some(e => e.workflowId))
				return { held: block?.message ?? `Discovery cannot execute in session ${actor} while paused, expired or ineligible.` };
			for (const e of pending) {
				if (held) {
					e.state = "ready"; delete e.callId;
					if (block) e.permissionHold = `${block.message} Check session ${actor}.`;
				} else { e.workflowId = workflowId; e.state = "issued"; }
				delete e.error;
			}
			return { run: r };
		});
		const run = admission.run ?? fail("bound_discovery_held", admission.held);
		const pending = batchOf(run, ticket, actor).filter(r => awaitingReply(r) && currentPin(run, r));
		if (!pending.length) return [];
		return pending.flatMap(r => {
			try {
				if (budgetError) fail("packet_budget", budgetError);
				return [{ id: r.id, squad: r.squad, base: r.base, ...scoutPacket(cwd(), run, r, budget) }];
			}
			catch (error) {
				if (!(error instanceof FoundryError) || error.code !== "packet_budget") throw error;
				db().update(id, live => {
					const job = batchOf(live, ticket, actor).find(e => e.id === r.id && e.workflowId === workflowId);
					if (job && awaitingReply(job)) blockReview(job, error.message);
				});
				return [];
			}
		});
	}
	/** @param {string} id @param {string} ticket @param {string} actor @param {string} workflowId @param {string} reviewId @param {unknown} raw @param {unknown} [packet] */
	async function scoutResult(id, ticket, actor, workflowId, reviewId, raw, packet) {
		/** @type {string|undefined} */ let diagnostic;
		if (raw === null && host.scoutFailure) {
			const job = batchOf(read(id), ticket, actor).find(e => e.id === reviewId && e.workflowId === workflowId && awaitingReply(e));
			if (job) {
				try { diagnostic = await host.scoutFailure(workflowId, `scout:${job.squad}:${job.id}@${job.base}`); }
				catch (error) { diagnostic = `No report; native diagnostic lookup failed: ${String(error)}`; }
			}
		}
		const changed = db().update(id, r => {
			const q = batchOf(r, ticket, actor).find(e => e.id === reviewId && e.workflowId === workflowId);
			if (!q) fail("foreign_assignment", "Only the bound workflow may return this report");
			if (!awaitingReply(q)) return false;
			delete q.error;
			const squad = r.policy.squads.find(s => s.id === q.squad) ?? fail("invalid_charter", "No matching charter");
			try {
				const research = investigation(q, squad);
				if (raw === null && diagnostic) fail("missing_report", diagnostic);
				if (raw === null && !research) fail("missing_report", "No structured scout report was returned");
				if (!isPacket(packet) || packet.review !== q.id || packet.base !== q.base)
					fail("missing_packet", "Missing or mismatched journaled scout packet");
				q.observation = research ? researchResult(raw, squad.charter) : parseObservation(squad, raw);
				q.packet = packet; q.state = "reported";
			} catch (error) {
				if (!(error instanceof FoundryError)) throw error;
				blockReview(q, `Invalid scout result: ${error.message}`);
			}
			return true;
		});
		// On reconnect without a local watcher, the durable report is consumed
		// by the next issuer reconciliation, not by a nested workflow launch.
		if (changed) await scoutCalls.get(ticket)?.get(reviewId)?.();
	}
	/** @param {string} id @param {string} actor @param {string} token @param {Record<string,unknown>} args */
	function submit(id, actor, token, args) {
		const from = args.changedFrom, run = read(id), n = writable(run, actor, token, from);
		if (args.missingInput !== undefined) {
			if (!n) fail("stale_assignment", "An already submitted attempt cannot report a missing input");
			const reason = text(args.missingInput, "missing input and why it is needed");
			if (reason.length > 2048) fail("invalid_field", "Describe the missing input in at most 2048 characters");
			generationRoot(cwd(), text(n.generation, "generation commit"));
			db().update(id, live => {
				const node = writable(live, actor, token);
				if (!node || node.generation !== n.generation || node.grain.id !== n.grain.id)
					fail("stale_assignment", "Assignment changed before recording the missing input");
				if (live.effects.some(e => e.grain === node.grain.id && e.token === token &&
					(e.permissionHold || e.kind === "repair" && e.state !== "done")))
					fail("dispatch_held", "Resolve the pending assignment delivery or permission hold first");
				node.state = "blocked";
				node.reason = `Writer reports missing input: ${reason}`;
			});
			return; // No directory capture, new component reservation, or inferred permission.
		}
		if (!n) return;
		const g = n.grain;
		const reports = reportedReferences(run, n, args);
		const commit = capture(cwd(), text(n.generation, "generation commit"), g.directory);
		const result = db().change(id, r => {
			const node = writable(r, actor, token, from);
			if (!node || node.grain.id !== g.id || digest(n) !== digest(node))
				fail("stale_assignment", "Assignment changed during capture");
			let target;
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
		await requireReadyOwner(cwd());
		const result = await lookup(workflowId);
		if (result.runId !== workflowId) fail("wrong_workflow", "Discovery lookup returned another workflow");
		if (result.status === "pending" || result.status === "running") return;
		if (!await executable()) return;
		if (continuing.has(ticket)) return;
		const shouldResume = db().update(id, run => {
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
		if (known.has(actor)) fail("worker_cannot_start", "Workers cannot activate or restart a run");
		if (!await executable()) fail("unsupported_mode", "Start only from an interactive or autopilot owner");
		const origin = cwd(), { policy, grains } = readPolicy(origin, source);
		const store = existsSync(file()) ? db() : undefined;
		if (store?.involving(actor).some(id => read(id).owner !== actor))
			fail("worker_cannot_start", "Workers cannot activate or restart a run");
		const prior = store?.read(policy.id);
		if (resume && !prior) fail("missing_run", `No run to resume for ${policy.source}`);
		if (prior) {
			if (prior.owner !== actor || prior.policy.source !== policy.source)
				fail("run_conflict", "Another owner or contract already uses this run ID");
			verifyContracts(origin, prior.policy, policy.base);
			if (prior.goal && qualifiedProduct(prior)) return status(prior, actor);
		}
		if (policy.deadline && Date.now() >= Date.parse(policy.deadline)) fail("deadline", "The authorized deadline has elapsed");
		if (!prior?.active || resume) {
			const retry = prior && missingObservation(prior) ? prior.goal : undefined;
			const tickets = new Map(prior?.effects.filter(e => e.tool === "workflow" && e.state === "uncertain" && !e.workflowId).map(e => [e.id, e.callId]));
			const bound = new Map(resume && prior && host.scoutSnapshot ? reviews(prior).flatMap(e =>
				e.issuer === actor && e.workflowId && e.callId && awaitingReply(e) ? [[e.callId, e.workflowId]] : []) : []);
			const writers = new Map(resume && prior ? prior.effects.filter(e => transferableWriter(prior, e)).map(e => [e.id, e.issuer]) : []);
			if (prior?.active && !retry && !tickets.size && !bound.size && !writers.size) return status(prior, actor);
			await requireReadyOwner(origin);
			if (prior)
				change(policy.id, r => {
					if (r.active !== prior.active || retry && (r.goal?.check !== retry.check || !missingObservation(r)))
						fail("run_conflict", "Run activation changed while starting");
					r.active = true;
					delete r.pauseReason;
					// An interrupted, unbound discovery cannot have spent an agent call. Invalidate its old ticket.
					for (const e of r.effects) if (e.tool === "workflow" && e.state === "uncertain" && !e.workflowId &&
						e.callId && tickets.get(e.id) === e.callId) {
						e.issuer = actor; e.state = "ready"; delete e.callId; delete e.error;
						retireSuperseded(r, e);
					}
					admitted(r);
					// issue() also compares the issuer inside its transaction. An old permission
					// read and a takeover can never both claim the same reservation.
					for (const e of r.effects) if (writers.get(e.id) === e.issuer && transferableWriter(r, e)) e.issuer = actor;
					if (retry) advance(origin, r, actor, false, { retryGoal: true });
				});
			else {
				const run = newRun(origin, policy, actor, grains);
				admitted(run);
				retain(origin, policy.base);
				if (run.goal && run.goal.commit !== policy.base) retain(origin, run.goal.commit);
				db(true).insert(run);
			}
			await Promise.all([...bound].map(([ticket, workflowId]) => continueScouts(policy.id, actor, ticket, workflowId)));
		}
		await drive(policy.id, actor, true);
		return status(read(policy.id), actor);
	}
	/** @param {string} op @param {unknown} args @param {string} actor */
	async function operation(op, args, actor) {
		const a = record(args);
		if (op === "start" || op === "resume") {
			fields(a, ["source"]);
			return start(a.source, actor, op === "resume");
		}
		const id = name(a.run, "run");
		if (op === "status") {
			fields(a, ["run", "detail"]);
			return status(read(id), actor, a.detail);
		}
		if (op === "pause") {
			fields(a, ["run"]);
			db().update(id, r => {
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
			const review = name(a.review, "review"), origin = cwd(), prior = retryableReview(origin, read(id), actor, review);
			if (prior.issuer !== actor || !host.confirmNoReport) fail("missing_history", "Need the original workflow's issuer-scoped native no-report evidence in the owner session");
			await requireReadyOwner(origin);
			await host.confirmNoReport(prior);
			await requireReadyOwner(origin);
			const ticket = randomUUID(), launch = host.scout ?? fail("unavailable", "Discovery workflow unavailable");
			db().update(id, run => {
				const live = retryableReview(origin, run, actor, review);
				if (digest(live) !== digest(prior)) fail("stale_assignment", "Review changed during native verification");
				const fresh = reserveReview(run, actor, live.squad, live.base, live.version, live.wake);
				fresh.retryOf = live.id;
				if (!issue(run, fresh, ticket)) fail("stale_assignment", "Cannot issue fresh review");
				if (run.goal) delete run.goal.stall;
			});
			watchScouts(id, ticket, actor, () => launch(id, ticket, actor));
			return status(read(id), actor);
		}
		const reply = op === "submit" ? { run: id, actor, token: text(a.token, "submission token") } : undefined;
		if (reply) {
			fields(a, a.missingInput !== undefined ? ["run", "token", "missingInput"] : ["run", "token", "changedFrom", "usedArtifacts", "comparedArtifacts"]);
			// Check the host, not a local count lost on reload. Revalidate mode and ownership after the read.
			const run = read(id);
			if (host.runningHelpers && writable(run, actor, reply.token, a.changedFrom)) {
				const workflows = new Set(reviews(run).flatMap(r => r.issuer === actor && awaitingReply(r) && r.workflowId ? [r.workflowId] : []));
				const helpers = await host.runningHelpers([...workflows]);
				if (helpers.length) fail("helpers_running", `Native helpers are still running: ${helpers.join(", ")}. Join them, integrate their work, then submit with the same token.`);
			}
			if (a.changedFrom !== undefined || a.missingInput !== undefined) await requireReadyOwner(cwd());
		}
		if (!await executable())
			fail("unsupported_mode", "Plan mode cannot change a Foundry run");
		if (reply) {
			reply.token = submit(id, actor, reply.token, a) ?? reply.token;
			// A shell notification can drive the same actor before this call returns.
			submitting.add(reply);
		}
		else if (op === "publish") {
			fields(a, ["run", "token", "file", "to"]);
			db().update(id, preparePublication(cwd(), read(id), actor, a));
		}
		else if (op === "repin") {
			const request = prepareRepin(cwd(), read(id), actor, a);
			const approved = await host.confirm?.(request.prompt);
			if (approved === false) {
				const blocker = status(read(id), actor).blocker;
				fail("approval_declined", "Evaluator change not approved. No change or recheck was made. Do not ask again unless the operator requests it." +
					(blocker ? `\nCurrent run blocker: ${blocker}` : ""));
			}
			if (approved !== true) fail("approval_required", "The approval form is unavailable; the evaluator was not changed.");
			if (!await executable()) fail("unsupported_mode", "The owner session is no longer executable");
			change(id, request.apply);
		}
		else
			fail("unknown_operation", `Unknown Foundry operation ${op}`);
		try {
			await drive(id, actor);
			return status(read(id), actor);
		} finally {
			if (reply) submitting.delete(reply);
		}
	}
	/** @param {string} tool @param {unknown} args @param {string} actor @param {string} callId */
	async function pre(tool, args, actor, callId) {
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
		operation, pre, scoutBatch, scoutResult,
		/** @param {unknown} args @param {string} actor */
		async claimWriter(args, actor) {
			const a = record(args); fields(a, ["run", "grain"]);
			const id = name(a.run, "run"), grain = name(a.grain, "grain"), origin = cwd();
			const run = read(id), job = reservation(run, grain), issuer = job.e.issuer === actor;
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
			const conflict = db().update(id, r => {
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
			if (prompt && assignment(prompt)) known.add(actor);
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
			for (const timer of capacityWakes.values()) clearTimeout(timer);
			capacityWakes.clear(); database?.close(); database = undefined;
		},
	};
}
