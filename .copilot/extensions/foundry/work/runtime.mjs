import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { openDatabase, ledgerPath } from "./database.mjs";
import { readPolicy } from "./contract.mjs";
import { advance, newRun, observe } from "./graph.mjs";
import { admitted, assignment, capacityNotice, checkEffect, current, issue, receive } from "./native.mjs";
import { capture, commitAt, retain, rootAt, verifyContracts } from "./product.mjs";
import { refusedCall } from "./recovery.mjs";
import { digest, fail, fields, name, record, text } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Effect} Effect */
/** @typedef {{run:string,id:string,actor:string}} Call */
/** @typedef {{execute:(tool:string,args:Effect["args"],id:string)=>Promise<unknown>,recover?:(effect:Effect)=>Promise<unknown>,
 * mode:()=>Promise<string>,confirm:(message:string)=>Promise<boolean>,select:(message:string,options:string[])=>Promise<string|null>,log?:(message:string)=>void}} Host */
/** @param {Run} run @param {string} actor */
function status(run, actor) {
	const mine = run.owner === actor;
	const reviews = run.reviews.filter(r => mine || r.worker === actor);
	const nodes = Object.entries(run.nodes).filter(([, n]) => mine || n.worker === actor);
	if (!mine && !nodes.length && !reviews.length && !run.effects.some(e => e.nativeId === actor))
		fail("foreign_run", "No bound assignment in this run");
	const pending = run.effects.filter(e => (mine || e.issuer === actor) && e.state !== "done" && (current(run, e) || e.state === "uncertain" || e.state === "issued"));
	const checks = new Map(run.effects.filter(e => e.receipt).map(e => [e.id, e.receipt]));
	const last = run.products.at(-1);
	const latestReports = new Map(reviews.filter(r => r.observation).map(r => [r.squad, r]));
	return {
		run: run.id, active: run.active, direction: run.policy.direction, contract: { commit: run.policy.base, path: run.policy.source },
		limit: run.capacity.limit, deadline: run.policy.deadline, expired: Boolean(run.policy.deadline && Date.now() >= Date.parse(run.policy.deadline)),
		...(mine ? { proposedLimit: run.capacity.offer?.to, qualified: last?.commit ?? null, target: last?.target, outputs: last?.outputs ?? {}, discoveryError: run.discoveryError,
			questions: [...latestReports.values()].flatMap(r => r.observation?.outcome === "needs-decision"
				? [{ squad: r.squad, base: r.base, question: r.observation.reason, evidence: r.observation.evidence }] : []),
			products: run.products.map(p => ({ ...p, receipt: checks.get(p.check) })), candidate: run.join && { ...run.join, receipt: checks.get(run.join.check) } } : {}),
		blocker: run.blocker,
		reviews: reviews.map(({ worker, token, ...r }) => ({ ...r, worker, ...(actor === worker ? { token } : {}) })),
		nodes: nodes.map(([grain, n]) => ({
			grain, review: n.review, state: n.state, worker: n.worker, repairs: n.repairs, inputs: n.inputs, generation: n.generation,
			...(n.state === "waiting" ? { requires: run.policy.grains.find(g => g.id === grain)?.needs } : {}),
			...(actor === n.worker ? { token: n.token } : {}), checked: n.state === "published" || n.state === "qualified" ? n.candidate : undefined,
			receipt: n.check && checks.get(n.check), reason: n.reason,
		})),
		pending: pending.map(e => ({ id: e.id, issuer: e.issuer, kind: e.kind, state: e.state, reason: e.error })),
		prepared: run.active ? pending.filter(e => e.issuer === actor && e.state === "ordinary" && current(run, e)).map(e => ({ tool: e.tool, arguments: e.args })) : []
	};
}

/** @param {string} directory @param {Host} host */
export function createRuntime(directory, host) {
	/** @type {ReturnType<typeof openDatabase>|undefined} */ let database;
	let root, closed = false, outsideRepository = false;
	/** @type {Set<string>} */ const known = new Set();
	/** @type {Set<string>} */ const running = new Set();
	/** @type {Set<Promise<unknown>>} */ const background = new Set();
	/** @type {Set<string>} */ const attemptedRecovery = new Set();
	/** @type {Map<string,{token:string,open:boolean}>} */ const dialogs = new Map();
	/** @type {Map<string,Call>} */ const nativeCalls = new Map();
	/** @type {string|undefined} */ let existingPath;
	const cwd = () => root ??= rootAt(directory);
	const executable = async () => ["interactive", "autopilot"].includes(await host.mode());
	/** @param {boolean} [create] */
	function db(create = false) {
		if (closed)
			fail("runtime_closed", "Foundry is closed");
		if (!database) {
			if (!create && !existsSync(existingPath ??= ledgerPath(cwd())))
				fail("missing_run", "No Foundry run in this repository");
			database = openDatabase(cwd(), existingPath ??= ledgerPath(cwd()), create);
		}
		return database;
	}
	/** @param {string} id */
	const read = id => db().read(id) ?? fail("missing_run", `Unknown run ${id}`);
	/** @param {string} id @param {(run:Run)=>void} mutate */
	function change(id, mutate) {
		for (;;) {
			const run = read(id), before = digest(run), count = run.products.length;
			mutate(run);
			if (digest(run) === before)
				return;
			if (db().swap(before, run, () => run.products.length === count || commitAt(cwd(), run.policy.target) === run.products.at(-1)?.target))
				return;
		}
	}
	/** @param {Call} ctx @param {string} callId @param {unknown} result @param {boolean} [automatic] */
	function settle(ctx, callId, result, automatic = false) {
		if (closed) return;
		const terminal = db().update(ctx.run, run => {
			const e = run.effects.find(x => x.id === ctx.id);
			if (!e || e.callId !== callId || e.issuer !== ctx.actor || e.state !== "issued" && e.state !== "uncertain") return true;
			try {
				receive(run, e, result, automatic);
			} catch (error) {
				e.state = "uncertain";
				e.error = String(error);
			}
			return e.state !== "uncertain" && e.state !== "issued";
		});
		if (terminal) nativeCalls.delete(callId);
		return terminal;
	}
	/** @param {string} id @param {Effect} effect @param {string} actor */
	async function send(id, effect, actor) {
		const callId = randomUUID();
		const granted = db().update(id, run => {
			const e = run.effects.find(e => e.id === effect.id);
			if (!e || e.state !== "ready" || !run.active || !current(run, e))
				return false;
			issue(run, actor, e.tool, e.args, callId, e.id);
			return true;
		});
		if (!granted)
			return;
		const ctx = { run: id, id: effect.id, actor };
		nativeCalls.set(callId, ctx);
		running.add(callId);
		try {
			const result = await host.execute(effect.tool, effect.args, callId);
			settle(ctx, callId, result, true);
		}
		catch (error) {
			settle(ctx, callId, { resultType: "unconfirmed", error: String(error) });
		}
		finally {
			running.delete(callId);
		}
	}
	/** @param {string} id @param {string} actor */
	async function reconcile(id, actor) {
		if (!host.recover)
			return;
		for (const e of read(id).effects.filter(e => e.issuer === actor && (e.state === "issued" || e.state === "uncertain"))) {
			if (closed) return;
			if (!e.callId || running.has(e.callId) || attemptedRecovery.has(e.callId))
				continue;
			attemptedRecovery.add(e.callId);
			const ctx = { run: id, id: e.id, actor };
			nativeCalls.set(e.callId, ctx);
			try {
				const result = await host.recover(e);
				settle(ctx, e.callId, result);
			}
			catch (error) {
				settle(ctx, e.callId, { resultType: "unconfirmed", error: String(error) });
			}
		}
	}
	/** Only the owner session presents choices. The proposal and decision survive reload, not the UI.
	 * @param {Run} run @param {NonNullable<Run["capacity"]["offer"]>} offer */
	async function askCapacity(run, offer) {
		const { id, owner, capacity: { limit } } = run, prior = dialogs.get(id);
		if (prior?.open || prior?.token === offer.id) return;
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
		if (closed || !await executable()) return;
		if (choice !== null && choice !== keep && choice !== raise) fail("invalid_choice", "Unknown worker-cap decision; cap unchanged");
		change(id, r => {
			if (!r.active || r.capacity.limit !== limit || r.policy.deadline && Date.now() >= Date.parse(r.policy.deadline)) return;
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
		if (!await executable() || closed)
			return;
		await reconcile(id, actor);
		while (!closed) {
			change(id, run => advance(cwd(), run, actor, discover));
			const run = read(id);
			if (!run.active || run.policy.deadline && Date.now() >= Date.parse(run.policy.deadline))
				return;
			const ready = run.effects.filter(e => e.issuer === actor && e.state === "ready" && current(run, e));
			if (!ready.length) {
				const offer = run.capacity.offer;
				if (actor === run.owner && offer) track(askCapacity(run, offer));
				return;
			}
			await Promise.all(ready.map(e => send(id, e, actor)));
		}
	}
	/** @param {string} id @param {string} actor @param {Record<string,unknown>} a */
	function submit(id, actor, a) {
		fields(a, ["run", "token"]);
		const run = read(id);
		admitted(run);
		const [grain, n] = Object.entries(run.nodes).find(([, n]) => n.token === a.token && n.worker === actor) ??
			fail("stale_assignment", "No current worker assignment matches this token");
		if (n.state === "checking" || n.state === "published" || n.state === "qualified")
			return;
		if (n.state !== "writing")
			fail("stale_assignment", "This attempt is no longer writable");
		const g = run.policy.grains.find(g => g.id === grain) ?? fail("unknown_grain", "No assigned grain");
		const commit = capture(cwd(), text(n.generation, "generation commit"), g.directory);
		const check = checkEffect(run, actor, cwd(), commit, g.check, grain);
		db().update(id, r => {
			admitted(r);
			const node = r.nodes[grain];
			if (!node || node.worker !== actor || node.token !== n.token || node.state !== "writing")
				fail("stale_assignment", "Assignment changed during capture");
			node.state = "checking";
			node.candidate = commit;
			node.check = check.id;
			r.effects.push(check);
		});
	}
	/** @param {string} op @param {unknown} args @param {string} actor */
	async function operation(op, args, actor) {
		const a = record(args);
		if (op === "start") {
			fields(a, ["source"]);
			if (known.has(actor))
				fail("worker_cannot_start", "Workers cannot activate or restart a run");
			if (!await executable())
				fail("unsupported_mode", "Start only from an interactive or autopilot owner");
			const origin = cwd(), policy = readPolicy(origin, a.source), path = existingPath ??= ledgerPath(origin);
			const prior = existsSync(path) ? db().read(policy.id) : undefined;
			if (existsSync(path) && db().involving(actor).some(id => read(id).owner !== actor))
				fail("worker_cannot_start", "Workers cannot activate or restart a run");
			if (prior) {
				if (prior.owner !== actor || digest({ ...prior.policy, base: policy.base }) !== digest(policy))
					fail("run_conflict", "Another owner or contract already uses this run ID");
				verifyContracts(cwd(), prior.policy, policy.base);
			}
			const fresh = newRun(policy, actor);
			admitted(fresh);
			if (!prior?.active && !await host.confirm(`Start ${policy.seed ? "one-off" : "ongoing"} Foundry run ${policy.id} at ${policy.base.slice(0, 12)} on ${policy.target} with up to ${prior?.capacity.limit ?? policy.workers} concurrent workers and ${policy.repairs} repairs per grain?\n${policy.direction}`))
				fail("activation_refused", "Foundry was not activated");
			if (closed || cwd() !== origin || !await executable())
				fail("context_changed", "Activation context changed during confirmation");
			const store = db(true);
			if (prior)
				store.update(policy.id, r => {
					if (r.active !== prior.active)
						fail("run_conflict", "Run activation changed while starting");
					r.active = true;
				});
			else {
				retain(origin, policy.base);
				store.insert(fresh);
			}
			await drive(policy.id, actor, true);
			return status(read(policy.id), actor);
		}
		const id = name(a.run, "run"), run = read(id);
		if (op === "status") {
			fields(a, ["run"]);
			return status(run, actor);
		}
		if (op === "pause") {
			fields(a, ["run"]);
			db().update(id, r => {
				if (r.owner !== actor)
					fail("foreign_run", "Only the owner can pause");
				r.active = false;
				delete r.capacity.offer;
			});
			return status(read(id), actor);
		}
		if (!await executable())
			fail("unsupported_mode", "Plan mode cannot submit work or make an observation");
		if (op === "observe") {
			change(id, r => observe(cwd(), r, actor, a));
		}
		else if (op === "submit")
			submit(id, actor, a);
		else
			fail("unknown_operation", `Unknown Foundry operation ${op}`);
		known.add(actor);
		await drive(id, actor, op === "observe");
		return status(read(id), actor);
	}
	/** @param {string} tool @param {unknown} args */
	function identify(tool, args) {
		if (!args || typeof args !== "object" || Array.isArray(args)) return;
		const a = record(args);
		const message = tool === "create_session" && a.kickoff && typeof a.kickoff === "object" && "prompt" in a.kickoff
			? a.kickoff.prompt : tool === "send_session_message" ? a.message : undefined;
		const marker = typeof message === "string" ? assignment(message) : undefined;
		if (marker)
			return marker.run;
		if (tool === "send_session_message" && typeof message === "string") return capacityNotice(message);
		if (tool === "bash" && typeof a.command === "string" && a.command.includes("/work/runner.mjs' ") && /^foundry-[a-f0-9-]{36}$/.test(String(a.shellId)))
			return / '([A-Za-z0-9][A-Za-z0-9._-]*)' '[a-f0-9-]{36}'$/.exec(a.command)?.[1];
	}
	/** @param {string} tool @param {unknown} args @param {string} actor @param {string} callId */
	function pre(tool, args, actor, callId) {
		const id = identify(tool, args);
		if (!id)
			return;
		db().update(id, r => {
			const e = r.effects.find(e => e.issuer === actor && e.tool === tool && digest(e.args) === digest(args) && current(r, e));
			if (!e || e.state !== "ordinary" && !(e.state === "issued" && e.callId === callId))
				fail("unreserved_call", "Not a current prepared Foundry call");
			issue(r, actor, tool, args, callId, e.id);
			nativeCalls.set(callId, { run: id, id: e.id, actor });
		});
	}
	/** @param {Promise<unknown>} p */
	function track(p) {
		const task = p.catch(e => host.log?.(`Foundry: ${String(e)}`)).finally(() => background.delete(task));
		background.add(task);
	}
	return {
		operation, pre,
		/** @param {string} actor @param {string} prompt */
		bind(actor, prompt) {
			if (assignment(prompt)) known.add(actor);
		},
		/** @param {string} path */
		setDirectory(path) {
			if (directory === path)
				return;
			if (database || running.size)
				fail("workspace_changed", "Foundry's bound workspace changed; reopen the session");
			directory = path;
			root = undefined;
			existingPath = undefined;
			outsideRepository = false;
		},
		/** @param {string} actor */
		turn(actor) {
			if (closed || outsideRepository)
				return;
			try {
				if (!database && !existsSync(existingPath ??= ledgerPath(directory)))
					return;
				attemptedRecovery.clear();
				const ids = new Set(db().involving(actor));
				for (const id of ids)
					track(drive(id, actor, true));
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
