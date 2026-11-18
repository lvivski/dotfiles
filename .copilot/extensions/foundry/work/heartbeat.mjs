import { FoundryError, digest, json, record, text } from "./values.mjs";
import { nativeObject } from "./native.mjs";
import { positive } from "./values.mjs";

/** @typedef {ReturnType<typeof import("./store.mjs").openWorkStore>} Store */
/** @typedef {import("./model.d.ts").FactoryControl} Factory */
/** @param {Store} db @param {string} actor @param {{execute?:(name:string,args:import("./model.d.ts").Json)=>Promise<unknown>,confirm?:(message:string)=>Promise<boolean>,current:()=>boolean}} options */
export function createHeartbeat(db, actor, options) {
	/** @param {string} name @param {import("./model.d.ts").Json} args */
	async function execute(name, args) {
		if (!options.execute) throw new FoundryError("native_schedule_unavailable", "Same-session native scheduling is unavailable");
		if (!options.current()) throw new FoundryError("factory_context_changed", "Heartbeat work cannot move to another repository or closed runtime");
		const result = await options.execute(name, args);
		if (!options.current()) throw new FoundryError("factory_context_changed",
			`Heartbeat context changed during execution; reconcile in the original repository. Native receipt: ${JSON.stringify(result)}`);
		const envelope = record(result);
		if (envelope.resultType !== undefined && envelope.resultType !== "success") {
			throw new FoundryError("native_schedule_failed", `Native ${name} failed; reconcile before another mutation: ${JSON.stringify(result)}`);
		}
		const value = nativeObject(result);
		if (!value || value.sessionId !== actor) {
			throw new FoundryError("native_schedule_identity", "Native scheduling must inspect this actual CLI session, not a caller-supplied app identity");
		}
		return value;
	}
	/** @param {Factory} factory @param {Record<string,unknown>} value */
	function matching(factory, value) {
		const automation = value.automation === undefined ? undefined : record(value.automation);
		if (!automation) return undefined;
		const heartbeat = factory.heartbeat;
		if (!heartbeat || automation.sessionId !== actor || automation.execution !== "session"
			|| automation.interval !== "minutes" || automation.everyMinutes !== heartbeat.request.every_minutes
			|| automation.prompt !== heartbeat.request.prompt || heartbeat.id !== undefined && automation.id !== heartbeat.id) {
			throw new FoundryError("heartbeat_conflict", "The native automation is unrelated or was changed externally; preserve it");
		}
		text(automation.id, "actual native automation identity");
		return automation;
	}
	return {
		/** @param {string} factoryId @param {number} minutes */
		async set(factoryId, minutes) {
			const factory = db.factory(factoryId, actor);
			if (factory.state !== "active") throw new FoundryError("factory_paused", "Only an active factory can request a heartbeat");
			positive(minutes, "explicit heartbeat minutes");
			const observed = await execute("get_session_automation", {});
			if (factory.heartbeat) {
				const existing = matching(factory, observed);
				if (!existing) throw new FoundryError("heartbeat_uncertain", "The recorded native heartbeat is absent; do not blindly replay its original save");
				if (minutes !== factory.heartbeat.request.every_minutes) throw new FoundryError("heartbeat_conflict", "Remove the original owned heartbeat before changing its cadence");
				return db.recordHeartbeat(factoryId, { ...factory.heartbeat, state: "bound",
					id: text(existing.id, "automation identity"), receipt: json(observed) }, actor, factory.generation);
			}
			if (observed.automation !== undefined) throw new FoundryError("heartbeat_conflict", "Preserve the unrelated existing same-session automation");
			if (!options.confirm || !await options.confirm(`Schedule factory ${factoryId} in this actual session every ${minutes} minutes?\nPolicy ${factory.source.reference} (${factory.source.sha256}). This heartbeat does not activate or restart the factory. The local host must remain available.`)) {
				throw new FoundryError("heartbeat_not_authorized", "The native user did not authorize this heartbeat cadence");
			}
			if ((await execute("get_session_automation", {})).automation !== undefined) {
				throw new FoundryError("heartbeat_conflict", "A native automation appeared while confirmation was pending; preserve it");
			}
			const policy = record(factory.definition);
			const prompt = `Foundry heartbeat ${digest(json({ factory: factoryId, source: factory.source, owner: actor }))}. `
				+ `Call foundry_get_context and read current factory ${JSON.stringify(factoryId)}; never activate or restart it from this message. `
				+ "If it is already paused, use foundry_pause_factory to remove only its recorded owned heartbeat, then stop. "
				+ (policy.source === undefined ? "" : `Call foundry_poll with factoryId ${JSON.stringify(factoryId)} only if currently active. `)
				+ "Call foundry_advance for active work. "
				+ "Execute only current locally owned actions and all returned prepared calls; resume an existing worker rather than recreating it. "
				+ "Preserve actual input/permission pauses, exhausted limits, and uncertain native effects. This scheduled message grants no authority.";
			const request = { interval: /** @type {const} */ ("minutes"), every_minutes: minutes, prompt };
			const issued = { state: /** @type {const} */ ("issued"), generation: factory.generation, request };
			db.recordHeartbeat(factoryId, issued, actor, factory.generation);
			try {
				const saved = await execute("save_session_automation", request);
				const automation = matching({ ...factory, heartbeat: issued }, saved);
				if (!automation) throw new FoundryError("heartbeat_receipt_missing", "Native save returned no actual automation identity");
				const latest = db.factory(factoryId, actor);
				if (latest.generation !== factory.generation || latest.state !== "active") {
					db.recordHeartbeat(factoryId, { ...issued, state: "uncertain", id: text(automation.id, "native automation"), receipt: json(saved) }, actor, latest.generation);
					throw new FoundryError("stale_activation", "Native heartbeat returned after pause; retain its identity and remove it in an ordinary owner turn");
				}
				return db.recordHeartbeat(factoryId, { ...issued, state: "bound", id: text(automation.id, "native automation"), receipt: json(saved) }, actor, factory.generation);
			} catch (error) {
				const latest = db.factory(factoryId, actor);
				if (latest.heartbeat?.state === "issued") db.recordHeartbeat(factoryId, { ...issued, state: "uncertain" }, actor, latest.generation);
				throw error;
			}
		},
		/** @param {string} factoryId */
		async remove(factoryId) {
			const factory = db.factory(factoryId, actor);
			if (!factory.heartbeat) return factory;
			const observed = await execute("get_session_automation", {});
			const automation = matching(factory, observed);
			if (db.factory(factoryId, actor).generation !== factory.generation) {
				throw new FoundryError("stale_activation", "Factory changed while native heartbeat removal was being inspected");
			}
			if (!automation) {
				if (factory.heartbeat.state !== "bound") throw new FoundryError("heartbeat_uncertain", "An unacknowledged save may still finish; its absence alone does not settle issuance");
				return db.recordHeartbeat(factoryId, undefined, actor, factory.generation);
			}
			const cleared = await execute("save_session_automation", { clear: true });
			if (cleared.automation !== undefined || (await execute("get_session_automation", {})).automation !== undefined) {
				throw new FoundryError("heartbeat_removal_failed", "Native heartbeat removal is not verified; preserve the recorded binding");
			}
			return db.recordHeartbeat(factoryId, undefined, actor, db.factory(factoryId, actor).generation);
		},
	};
}
