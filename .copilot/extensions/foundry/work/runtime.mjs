import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { openDatabase, ledgerPath } from "./database.mjs";
import { readPolicy } from "./contract.mjs";
import { advance, newRun, observe } from "./graph.mjs";
import { missingObservation } from "./goal.mjs";
import { admitted, assignment, awaitingReply, current, expired, identify, issue, receive, reserveCheck, unissued } from "./native.mjs";
import { checked } from "./plan.mjs";
import { capture, commitAt, retain, rootAt, verifyContracts } from "./product.mjs";
import { refusedCall } from "./recovery.mjs";
import { status } from "./status.mjs";
import { digest, fail, fields, name, record, text } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Effect} Effect */
/** @typedef {{run:string,id:string,actor:string,inFlight?:boolean,recoveredOn?:number}} Call */
/** @typedef {{execute:(tool:string,args:Effect["args"],id:string)=>Promise<unknown>,remind:(run:string,token:string)=>Promise<string>,recover?:(effect:Effect)=>Promise<unknown>,
 * mode:()=>Promise<string>,helpersRunning?:()=>Promise<boolean>,permissionBlocker:()=>Promise<import("./permissions.mjs").PermissionBlock|null>,confirm:(message:string)=>Promise<boolean>,select:(message:string,options:string[])=>Promise<string|null>,log?:(message:string)=>void}} Host */
/** @param {Run} run @param {string} [reason] */
function pause(run, reason) {
	run.active = false;
	delete run.capacity?.offer;
	if (reason) run.pauseReason = reason;
}

/** @param {Run} run @param {string} [retry] */
function activationPrompt({ policy, capacity }, retry) {
	const mode = policy.goalCheck ? `ongoing goal (finish check: ${policy.goalCheck})` : policy.seed ? "one-off" : "ongoing";
	const staffing = capacity ? `up to ${capacity.limit} concurrent scout/writer assignments (not counting in-session helpers)` : "no worker cap";
	return [
		`Start ${mode} Foundry run ${policy.id} at ${policy.base.slice(0, 12)} on ${policy.target} with ${staffing} and ${policy.repairs} repairs per grain?`,
		policy.direction,
		...policy.squads.flatMap(s => "areas" in s ? [`${s.id} may assign work in ${s.areas.join(", ")} using ${s.checks.join(", ")}.`] : []),
		...(retry ? [`Recheck the missing external evidence for ${retry} (rejoin first if the target has moved).`] : []),
	].join("\n");
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
const reservations = (run, actor) => run.effects.filter(e => e.issuer === actor && unissued(e) && current(run, e));

/** @param {string} directory @param {Host} host */
export function createRuntime(directory, host) {
	/** @type {ReturnType<typeof openDatabase>|undefined} */ let database;
	let root, closed = false, outsideRepository = false, turnNumber = 0;
	/** @type {Set<string>} */ const known = new Set();
	/** @type {Set<Promise<unknown>>} */ const background = new Set();
	/** @type {Set<{run:string,actor:string,token:string}>} */ const submitting = new Set();
	/** @type {Map<string,{token:string,open:boolean}>} */ const dialogs = new Map();
	/** @type {Map<string,Call>} */ const nativeCalls = new Map();
	/** @type {string|undefined} */ let existingPath;
	const cwd = () => root ??= rootAt(directory);
	const file = () => existingPath ??= ledgerPath(directory);
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
			const count = run.products.length, accepted = run.accepted;
			mutate(run);
			if (run.products.length !== count || run.accepted !== accepted)
				return () => commitAt(cwd(), run.policy.target) === run.products.at(-1)?.target;
		});
	}
	/** Check once for a batch, outside the write lock. A stale result must not pause unrelated work.
	 * @param {string} id @param {string} actor @param {Effect[]} batch */
	async function dispatchBlocker(id, actor, batch) {
		const block = await host.permissionBlocker();
		if (!await executable()) return "The issuing session is no longer in an executable mode.";
		if (!block && !batch.some(e => e.permissionHold)) return null;
		const message = block ? `${block.message} Check session ${actor}.` +
			(block.scope === "run" ? ` Then explicitly resume ${id} from its owner.` : " Its next turn rechecks the hold.") : null;
		const expected = new Map(batch.map(e => [e.id, e.state]));
		const transition = db().update(id, run => {
			const live = reservations(run, actor);
			if (!run.active || !live.some(e => expected.get(e.id) === e.state)) return "stale";
			if (block?.scope === "run" && message) { pause(run, message); return "paused"; }
			const changed = message && live.some(e => e.permissionHold !== message);
			for (const e of live) {
				if (message) e.permissionHold = message;
				else delete e.permissionHold;
			}
			return changed ? "held" : undefined;
		});
		if (transition === "stale") return "The reservation changed or the run is already paused. Check foundry_status.";
		if (transition) host.log?.(`Foundry ${id} ${transition}: ${message}`);
		return message;
	}
	/** @param {Call} ctx @param {string} callId @param {unknown} result @param {boolean} [automatic] */
	function settle(ctx, callId, result, automatic = false) {
		if (closed) return;
		const terminal = db().update(ctx.run, run => {
			const e = run.effects.find(x => x.id === ctx.id);
			if (!e || e.callId !== callId || e.issuer !== ctx.actor || !awaitingReply(e)) return true;
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
	/** Only the owner session presents choices. The proposal and decision survive reload, not the UI.
	 * @param {Run} run */
	async function askCapacity({ id, owner, capacity }) {
		const offer = capacity?.offer, prior = dialogs.get(id);
		if (!offer || prior?.open || prior?.token === offer.id) return;
		const { limit } = capacity;
		const dialog = { token: offer.id, open: true }, keep = `Keep ${limit}`, raise = `Increase to ${offer.to}`;
		dialogs.set(id, dialog);
		const waiting = offer.to - limit;
		let choice;
		try {
			choice = await host.select(`Foundry ${id} is at its worker cap of ${limit}. ${waiting} more ${waiting === 1 ? "assignment is" : "assignments are"} ready. Work continues while you decide; Keep means no more capacity questions for this run.`, [keep, raise]);
		} catch (error) {
			throw new Error(`Could not ask about the worker cap for ${id}; continuing at ${limit}: ${String(error)}`);
		} finally {
			dialog.open = false;
		}
		if (!await executable()) return;
		if (choice !== null && choice !== keep && choice !== raise) fail("invalid_choice", "Unknown worker-cap decision; cap unchanged");
		change(id, r => {
			if (!r.active || r.capacity?.limit !== limit || expired(r)) return;
			if (choice === raise) {
				if (r.capacity.offer?.id !== offer.id) return;
				advance(cwd(), r, owner, true);
				if (r.capacity.offer?.id !== offer.id) return;
				r.capacity.limit = offer.to;
			} else r.capacity.kept = true;
			delete r.capacity.offer;
		});
		if (choice === raise) await drive(id, owner, true);
	}
	/** @param {string} id @param {string} actor @param {boolean} [discover] */
	async function drive(id, actor, discover = false) {
		if (!await executable())
			return;
		const recover = host.recover, lookups = [];
		if (recover) for (const e of read(id).effects) {
			// A same-session SDK notice has no native tool history. Never replay it.
			const callId = e.callId;
			if (!callId || e.issuer !== actor || e.tool === "session.send" || !awaitingReply(e)) continue;
			const call = nativeCalls.get(callId);
			if (call?.inFlight || call?.recoveredOn === turnNumber) continue;
			lookups.push(resolveCall(id, e, callId, () => recover(e)).then(terminal => terminal ? refill() : undefined));
		}
		await Promise.all([dispatch(), ...lookups]);
		async function refill() {
			if (await executable()) await dispatch();
		}
		async function dispatch() {
			if (closed) return;
			const reply = [...submitting].findLast(s => s.run === id && s.actor === actor);
			const run = change(id, run => {
				// Don't reserve newly available work on behalf of an issuer already on hold.
				if (!reservations(run, actor).some(e => e.permissionHold))
					advance(cwd(), run, actor, discover, { submitToken: reply?.token });
			});
			if (!run.active || expired(run)) return;
			const batch = reservations(run, actor).filter(e => e.state === "ready" || e.permissionHold);
			if (!batch.length) {
				if (actor === run.owner && run.capacity?.offer) track(askCapacity(run));
				return;
			}
			if (await dispatchBlocker(id, actor, batch) !== null) return;
			const ready = batch.filter(e => e.state === "ready");
			if (!ready.length) return refill(); // Prepared calls are visible again; this issuer can now plan.
			// A sibling's native permission prompt must not hold up work unlocked by this reply.
			await Promise.all(ready.map(async e => {
				const callId = randomUUID();
				if (!closed && claim(id, e, callId))
					await resolveCall(id, e, callId, async () => e.tool === "session.send"
						? { resultType: "success", messageId: await host.remind(id, text(e.token, "repair token")) }
						: host.execute(e.tool, e.args, callId), true);
				await refill();
			}));
		}
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
			fail("context_changed", "Activation context changed during confirmation");
	}
	/** @param {unknown} source @param {string} actor */
	async function start(source, actor) {
		if (known.has(actor)) fail("worker_cannot_start", "Workers cannot activate or restart a run");
		if (!await executable()) fail("unsupported_mode", "Start only from an interactive or autopilot owner");
		const origin = cwd(), { policy, grains } = readPolicy(origin, source);
		const store = existsSync(file()) ? db() : undefined;
		if (store?.involving(actor).some(id => read(id).owner !== actor))
			fail("worker_cannot_start", "Workers cannot activate or restart a run");
		const prior = store?.read(policy.id);
		if (prior) {
			if (prior.owner !== actor || prior.policy.source !== policy.source)
				fail("run_conflict", "Another owner or contract already uses this run ID");
			verifyContracts(origin, prior.policy, policy.base);
			if (prior.accepted) return status(prior, actor);
		}
		const run = prior ?? newRun(origin, policy, actor, grains);
		admitted({ ...run, active: true });
		if (!prior?.active) {
			const retry = prior && missingObservation(prior) ? prior.goal : undefined;
			await requireReadyOwner(origin);
			if (!await host.confirm(activationPrompt(run, retry?.commit))) fail("activation_refused", "Foundry was not activated");
			await requireReadyOwner(origin);
			if (prior)
				change(policy.id, r => {
					if (r.active || retry && (r.goal?.check !== retry.check || !missingObservation(r)))
						fail("run_conflict", "Run activation changed while starting");
					r.active = true;
					delete r.pauseReason;
					admitted(r);
					if (retry) advance(origin, r, actor, false, { retryGoal: true });
				});
			else {
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
		if (op === "start") {
			fields(a, ["source"]);
			return start(a.source, actor);
		}
		const id = name(a.run, "run");
		if (op === "status") {
			fields(a, ["run"]);
			return status(read(id), actor);
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
			fail("unsupported_mode", "Plan mode cannot submit work or make an observation");
		if (op === "observe") {
			change(id, r => observe(cwd(), r, actor, a));
		}
		else if (reply) {
			submit(id, actor, reply.token);
			// A shell notification can drive the same actor before this call returns.
			submitting.add(reply);
		}
		else
			fail("unknown_operation", `Unknown Foundry operation ${op}`);
		try {
			await drive(id, actor, op === "observe");
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
			admitted(run);
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
		operation, pre,
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
				if (!database && !existsSync(file()))
					return;
				turnNumber++;
				for (const id of db().involving(actor)) {
					if (shellId && !read(id).effects.some(e => e.issuer === actor && e.tool === "bash" && e.args.shellId === shellId)) continue;
					track(drive(id, actor, true));
				}
			}
			catch (e) {
				if (!database && e instanceof Error && "stderr" in e && String(e.stderr).includes("not a git repository"))
					outsideRepository = true;
				else
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
