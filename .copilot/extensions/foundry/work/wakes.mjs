import { checkReceipt } from "./evidence.mjs";
import { expired } from "./native.mjs";
import { awaitingReply } from "./reservation.mjs";
import { timelyChecks } from "./goal.mjs";
import { setTimeout as sleep } from "node:timers/promises";

/** @typedef {import("./model.js").Run} Run */
/** @param {()=>void} tick */
export function receiptClock(tick) {
	const timer = setInterval(tick, 15_000).unref();
	return () => clearInterval(timer);
}

/** @param {unknown} error */
export function contention(error) {
	if (!(error instanceof Error) || !("code" in error)) return false;
	if (error.code === "EINTR" || error.code === "EAGAIN" || error.code === "EBUSY") return true;
	// node:sqlite exposes the extended result code. Low byte: SQLITE_BUSY or SQLITE_LOCKED.
	return error.code === "ERR_SQLITE_ERROR" && "errcode" in error && typeof error.errcode === "number" &&
		[5, 6].includes(error.errcode & 0xff);
}

/** An already-returned result can outlive a busy transaction, not its issuer.
 * The callback must recheck the original identity on every attempt and perform no native action.
 * The callback may sample fresh authority before a conditional write; it must never replay the native request.
 * @template T @param {()=>T|Promise<T>} write @param {AbortSignal} signal @param {(e:unknown)=>void} log @returns {Promise<T|undefined>} */
export async function persist(write,signal,log){
	for(let delay=1000;!signal.aborted;delay=Math.min(15_000,delay*2)){
		try{const result=write();return result instanceof Promise ? await result : result;}
		catch(error){if(!contention(error))throw error;if(delay===1000)log(error);}
		try{await sleep(delay,undefined,{signal});}
		catch(error){if(!signal.aborted)throw error;}
	}
}

/** A changed ledger is a hint, not a verdict. Observe only already-issued checks;
 * an unchanged row needs neither snapshot decoding nor native history lookups.
 * @param {{read:(id:string)=>Run, stamp:(id:string)=>string, wake:(id:string,actor:string)=>void,
 * clock:typeof receiptClock, log:(e:unknown)=>void}} io */
export function receiptWakes(io) {
	/** @type {Map<string,{checks:string[],stop:()=>void,stamp?:string,delay:number,skip:number}>} */ const watches = new Map();
	/** @param {Run} run @param {string} actor */
	function observe(run, actor) {
		const id = run.id, key = JSON.stringify([id, actor]), prior = watches.get(key);
		const checks = run.active && !expired(run) ? run.effects.filter(e => (e.issuer === actor || run.owner === actor) &&
			e.tool === "bash" && e.callId && awaitingReply(e) && !e.permissionHold && !e.receipt).map(e => e.id) : [];
		if (!checks.length) { prior?.stop(); watches.delete(key); return; }
		if (prior) { prior.checks = checks; return; }
		const stop = io.clock(() => {
			const w = watches.get(key);
			if (!w) return;
			if (w.skip) { w.skip--; return; }
			try {
				const stamp = io.stamp(id);
				if (w.stamp === stamp) { w.delay = 0; return; }
				const next = io.read(id), selected = new Set(w.checks);
				w.stamp = stamp; w.delay = 0;
				const arrived = next.effects.some(e => selected.has(e.id) && checkReceipt(e));
				observe(next, actor);
				if (arrived && next.active && (!expired(next) || timelyChecks(next))) io.wake(id,actor);
			} catch (error) {
				if (!contention(error)) { w.stop(); watches.delete(key); io.log(error); return; }
				if (!w.delay) io.log(error);
				// Re-read only. Keep one clock per issuer, backing off to at most four ticks.
				w.delay = Math.min(4, w.delay * 2 || 1);
				w.skip = w.delay - 1;
			}
		});
		watches.set(key,{checks,stop,delay:0,skip:0});
	}
	return {observe, close() { for (const w of watches.values()) w.stop(); watches.clear(); }};
}
