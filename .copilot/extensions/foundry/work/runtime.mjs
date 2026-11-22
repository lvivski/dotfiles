import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { openDatabase, ledgerPath } from "./database.mjs";
import { readPolicy } from "./contract.mjs";
import { presentQuestions } from "./decisions.mjs";
import { advance, newRun, parseObservation } from "./graph.mjs";
import { missingObservation, qualifiedProduct } from "./evidence.mjs";
import { admitted, assignment, awaitingReply, canDispatch, current, expired, identify, issue, receive, reserveCheck, unissued } from "./native.mjs";
import { checked } from "./plan.mjs";
import { capture, commitAt, retain, rootAt, verifyContracts } from "./product.mjs";
import { refusedCall } from "./recovery.mjs";
import { researchResult } from "./research.mjs";
import { blockReview, questions, reviews } from "./reviews.mjs";
import { scoutPacket } from "./scouts.mjs";
import { isPacket } from "./snapshot.mjs";
import { status } from "./status.mjs";
import { FoundryError, digest, fail, fields, name, record, text } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Effect} Effect */
/** @typedef {{run:string,id:string,actor:string,inFlight?:boolean,recoveredOn?:number}} Call */
/** @typedef {{runId:string,status:string,error?:string,reason?:string}} ScoutEnvelope */
/** @typedef {{execute:(tool:string,args:Effect["args"],id:string)=>Promise<unknown>,notify:(message:string)=>Promise<string>,recover?:(effect:Effect)=>Promise<unknown>,
 * ask?:(message:string)=>Promise<string|null>,
 * scout?:(run:string,dispatch:string,actor:string)=>Promise<ScoutEnvelope>,scoutState?:(workflowId:string)=>Promise<ScoutEnvelope>,
 * mode:()=>Promise<string>,helpersRunning?:()=>Promise<boolean>,permissionBlocker:()=>Promise<import("./permissions.mjs").PermissionBlock|null>,log?:(message:string)=>void}} Host */
/** @param {Run} run @param {string} [reason] */
function pause(run, reason) {
	run.active = false;
	if (reason) run.pauseReason = reason;
}

/** @param {Run} run @param {string} actor @param {string} token */
function writable(run, actor, token) {
	admitted(run);
	const node = Object.values(run.nodes).find(n => n.token === token && n.worker === actor) ??
		fail("stale_assignment", "No current worker assignment matches this token");
	if (node.state === "checking" || checked(node)) return;
	if (node.state !== "writing") fail("stale_assignment", "This attempt is no longer writable");
	return node;
}

/** @param {Run} run @param {string} actor */
const reservations = (run, actor) => run.effects.filter(e => e.issuer === actor && unissued(e) && canDispatch(run, e));
/** @param {Run} run @param {string} ticket @param {string} actor */
const batchOf = (run, ticket, actor) => reviews(run).filter(e => e.callId === ticket && e.issuer === actor);

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
		return database ??= openDatabase(cwd(), file(), create);
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
			if (stop && message) { pause(run, message); return { state: "paused", message }; }
			const changed = message && live.some(e => e.permissionHold !== message);
			for (const e of live) {
				if (message) e.permissionHold = message;
				else delete e.permissionHold;
			}
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
			const scouts = ready.filter(e => e.tool === "workflow");
			if (scouts.length) {
				const ticket = randomUUID();
				if (db().update(id, r => scouts.filter(e => issue(r, e, ticket)).length))
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
		db().update(id, r => {
			for (const e of batchOf(r, ticket, actor).filter(awaitingReply)) {
				e.state = "uncertain";
				e.error = `Discovery unconfirmed: ${message}. ${e.workflowId ? "Recheck the original workflow; no replacement started." : "Resume to retry unbound discovery."}`;
			}
		});
	}
	/** A workflow's terminal envelope accounts for missing reports, never for checked work.
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
			if (closed) return;
			const reconcile = db().update(id, r => {
				const batch = batchOf(r, ticket, actor), pending = batch.filter(awaitingReply);
				for (const e of pending) {
					if (e.workflowId && e.workflowId !== result.runId) fail("wrong_workflow", "Discovery result belongs to another workflow");
					blockReview(e, `Discovery ${result.status}: ${result.error ?? result.reason ?? "no report was received"}`);
				}
				return pending.length > 0 || batch.some(e => reports.has(e.id));
			});
			if (reconcile) track(drive(id, actor, true, false));
		}).catch(error => { if (!closed) unconfirmedScouts(id, actor, ticket, String(error)); })
			.catch(error => host.log?.(`Foundry discovery: ${String(error)}`)).finally(() => scoutCalls.delete(ticket));
	}
	/** @param {string} id @param {string} ticket @param {string} actor @param {string} workflowId */
	async function scoutBatch(id, ticket, actor, workflowId) {
		text(workflowId, "workflow ID");
		const block = await host.permissionBlocker(), eligible = await executable();
		const run = db().update(id, r => {
			const batch = batchOf(r, ticket, actor);
			if (!batch.length || batch.some(e => e.workflowId && e.workflowId !== workflowId))
				fail("foreign_assignment", "No matching Foundry discovery dispatch in this session");
			const pending = batch.filter(e => awaitingReply(e) && current(r, e));
			for (const e of pending) {
				if (!eligible || !r.active || expired(r) || block) {
					e.state = "ready"; delete e.callId; delete e.workflowId;
					if (block) e.permissionHold = `${block.message} Check session ${actor}.`;
				} else { e.workflowId = workflowId; e.state = "issued"; }
				delete e.error;
			}
			if (pending.length && r.active && block?.scope === "run") pause(r, `${block.message} Check session ${actor}.`);
			return r;
		});
		return batchOf(run, ticket, actor).filter(awaitingReply).map(r =>
			({ id: r.id, squad: r.squad, base: r.base, ...scoutPacket(cwd(), run, r) }));
	}
	/** @param {string} id @param {string} ticket @param {string} actor @param {string} workflowId @param {string} reviewId @param {unknown} raw @param {unknown} [packet] */
	async function scoutResult(id, ticket, actor, workflowId, reviewId, raw, packet) {
		const changed = db().update(id, r => {
			const q = batchOf(r, ticket, actor).find(e => e.id === reviewId && e.workflowId === workflowId);
			if (!q) fail("foreign_assignment", "Only the bound workflow may return this report");
			if (!awaitingReply(q)) return false;
			delete q.error;
			const squad = r.policy.squads.find(s => s.id === q.squad) ?? fail("invalid_charter", "No matching charter");
			try {
				if (raw === null && q.wake?.key !== "research") fail("missing_report", "No structured scout report was returned");
				if (!isPacket(packet) || packet.review !== q.id || packet.base !== q.base)
					fail("missing_packet", "Missing or mismatched journaled scout packet");
				q.observation = q.wake?.key === "research" ? researchResult(raw, squad.charter) : parseObservation(squad, raw);
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
	/** @param {string} id @param {string} actor @param {string} token */
	function submit(id, actor, token) {
		const run = read(id), n = writable(run, actor, token);
		if (!n) return;
		const g = n.grain;
		const commit = capture(cwd(), text(n.generation, "generation commit"), g.directory);
		db().update(id, r => {
			admitted(r);
			const node = r.nodes[g.id];
			if (!node || node.worker !== actor || node.token !== n.token || node.state !== "writing")
				fail("stale_assignment", "Assignment changed during capture");
			node.state = "checking";
			node.candidate = commit;
			node.check = reserveCheck(r, actor, cwd(), commit, g.check, g.id);
		});
	}
	/** @param {string} origin */
	async function requireReadyOwner(origin) {
		const block = await host.permissionBlocker();
		if (block !== null) fail("permissions_unready", block.message);
		if (!await executable() || cwd() !== origin)
			fail("context_changed", "Activation context changed during the permission check");
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
			if (prior?.active && !retry && !tickets.size) return status(prior, actor);
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
					}
					admitted(r);
					if (retry) advance(origin, r, actor, false, { retryGoal: true });
				});
			else {
				const run = newRun(origin, policy, actor, grains);
				admitted(run);
				retain(origin, policy.base);
				if (run.goal && run.goal.commit !== policy.base) retain(origin, run.goal.commit);
				db(true).insert(run);
			}
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
		const reply = op === "submit" ? { run: id, actor, token: text(a.token, "submission token") } : undefined;
		if (reply) {
			fields(a, ["run", "token"]);
			// Check the host, not a local count lost on reload. Revalidate mode and ownership after the read.
			if (host.helpersRunning && writable(read(id), actor, reply.token) && await host.helpersRunning())
				fail("helpers_running", "Native helpers are still running. Join them, integrate their work, then submit with the same token.");
		}
		if (!await executable())
			fail("unsupported_mode", "Plan mode cannot submit work");
		if (reply) {
			submit(id, actor, reply.token);
			// A shell notification can drive the same actor before this call returns.
			submitting.add(reply);
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
		close() { closed = true; database?.close(); database = undefined; },
	};
}
