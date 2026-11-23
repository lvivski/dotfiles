import { remainingAssignments } from "./capacity.mjs";
import { checkpointReceipt, checkReceipt } from "./evidence.mjs";
import { admitted } from "./native.mjs";
import { productOutputs } from "./plan.mjs";
import { commitAt, verifyContracts } from "./product.mjs";
import { history, refusedCall } from "./recovery.mjs";
import { digest, fail, record } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").NativeCall} NativeCall */
/** @param {Run} run @param {string} actor @param {string} check */
function attempt(run, actor, check) {
	if (actor !== run.owner) fail("foreign_run", "Only the original owner can retire its goal runner");
	const e = run.effects.find(e => e.id === check);
	if (e?.kind !== "goal" || e.issuer !== actor) fail("wrong_issuer", "Select a goal check issued by this owner");
	return e;
}

/** @param {string} cwd @param {Run} run @param {NativeCall} e */
function selection(cwd, run, e) {
	admitted(run);
	const at = run.goal, product = run.products.at(-1), target = commitAt(cwd, run.policy.target);
	if (!at || at.check !== e.id || at.commit !== e.commit || !product || at.target !== target || product.commit !== at.commit ||
		product.target !== target || !checkpointReceipt(run, product.check, product.commit) || e.check !== run.policy.goalCheck ||
		e.evaluatorRevision !== run.repins?.at(-1)?.revision || run.join || run.blocker || run.conflict ||
		run.effects.some(x => x.permissionHold && x.issuer === run.owner) || !e.runnerStarted || e.runnerClaim || !e.callId ||
		e.args.shellId !== `foundry-${e.id}` || !(e.state === "issued" || e.state === "uncertain") ||
		run.effects.some(x => x !== e && x.issuer === e.issuer && (x.callId === e.callId || x.args.shellId === e.args.shellId)))
		fail("not_recoverable", "Need the current unreceipted legacy goal on its original checked product, target and pin, without a hold");
	verifyContracts(cwd, run.policy, target);
	const outputs = productOutputs(run, target, remainingAssignments(run));
	if (!outputs || !Object.values(run.nodes).some(n => n.state === "published"))
		fail("no_new_work", "No joinable published outputs; retirement does not retry the old goal");
	return { target, commit: at.commit, pin: e.evaluatorRevision ?? run.policy.base, product: product.check, call: e.callId, outputs,
		directories: Object.values(run.nodes).filter(n => n.state === "published").map(n => n.grain.directory) };
}

/** Require native termination AND the matching shell reader's SDK result. Diagnostic text
 * alone (including an operator-supplied log) is neither process identity nor a verdict.
 * @param {NonNullable<import("./runtime.mjs").Host["readHistory"]>} read @param {NativeCall} e */
export async function terminalProof(read, e) {
	const shell = e.args.shellId;
	/** @type {Map<string,string>} */ const reads = new Map();
	let notification, proof, launch;
	for await (const ev of history(read, ["system.notification","tool.execution_start","tool.execution_complete","permission.completed"])) {
		if ((ev.type === "permission.completed" || ev.type === "tool.execution_complete") && ev.data.toolCallId === e.callId &&
			refusedCall(ev) === e.callId) fail("conflicting_evidence", "Original goal launch has a native refusal");
		if (ev.type === "system.notification") {
			const k = ev.data.kind;
			if (k.type !== "shell_completed" || k.shellId !== shell) continue;
			if (notification || k.exitCode !== 1 || k.description !== e.args.description)
				fail("conflicting_evidence", "Conflicting terminal notification for the reserved shell");
			notification = ev.id;
		} else if (ev.type === "tool.execution_start") {
			const d = ev.data, tool = d.toolName.split(".").at(-1);
			if (tool !== "bash" && tool !== "read_bash" && d.toolCallId !== e.callId) continue;
			const a = record(d.arguments ?? {});
			if (d.toolCallId === e.callId || tool === "bash" && a.shellId === shell) {
				if (launch || notification || tool !== "bash" || d.toolCallId !== e.callId || digest(a) !== digest(e.args))
					fail("conflicting_evidence", "Shell identity reused or original launch arguments differ");
				launch = ev.id;
			}
			if (tool === "read_bash" && a.shellId === shell && notification) {
				if (reads.has(d.toolCallId)) fail("conflicting_evidence", "Ambiguous native shell read");
				reads.set(d.toolCallId, ev.id);
			}
		} else if (ev.type === "tool.execution_complete" && reads.has(ev.data.toolCallId)) {
			const d = ev.data, telemetry = d.toolTelemetry, output = d.result?.content, exit = record(telemetry?.metrics ?? {}).exit_code;
			const readId = reads.get(d.toolCallId);
			if (notification && readId && d.success && record(telemetry?.properties ?? {}).shell_error_category === "command_nonzero_exit" && exit === 1 &&
				typeof output === "string" && output.trimEnd().endsWith(`<shellId: ${shell} completed with exit code 1>`) &&
				/^FoundryError: Invalid Foundry dispatch\r?$/m.test(output) && /\bat decode \(file:\/\/[^\n]+\/snapshot\.mjs:\d+:\d+\)/.test(output) &&
				/\bat snapshot \(file:\/\/[^\n]+\/database\.mjs:\d+:\d+\)/.test(output))
				proof ??= { notification, read: readId, completion: ev.id };
			else if (exit !== undefined) fail("conflicting_evidence", "Terminal read does not confirm the runner's decoder failure");
		}
	}
	return proof ?? fail("missing_history", "Need the exact native terminal notification and read_bash result showing the runner's decoder failure");
}

/** @param {string} cwd @param {string} actor @param {string} check @param {{
 * read:()=>Run, ready:()=>Promise<void>, history:import("./runtime.mjs").Host["readHistory"],
 * confirm:import("./runtime.mjs").Host["confirm"], swap:(fn:(r:Run)=>(()=>boolean)|void)=>Run}} io */
export async function retireGoal(cwd, actor, check, io) {
	const run = io.read(), e = attempt(run, actor, check);
	if (e.state === "retired") return false;
	if (e.receipt) {
		if (!checkReceipt(e) || run.goal?.check !== check || !run.active) return false;
		await io.ready();
		return true; // Reconcile actual evidence instead of recording an infrastructure failure.
	}
	const selected = selection(cwd, run, e);
	await io.ready();
	const proof = await terminalProof(io.history ?? fail("missing_history", "Original owner history unavailable"), e);
	const approved = await io.confirm?.(`Retire failed runner ${e.id} in ${run.id}? Its native shell terminated without recording a goal verdict at ${selected.commit} under ${selected.pin}. Do not rerun this check. Integrate the retained outputs in ${selected.directories.join(", ")} and check the new product.`);
	if (!approved) fail(approved === false ? "approval_declined" : "approval_required", "Retirement not approved; no work changed");
	await io.ready();
	let reconcile = false;
	io.swap(live => {
		reconcile = false;
		const original = attempt(live, actor, check);
		if (original.state === "retired") return;
		if (original.receipt) {
			reconcile = !!checkReceipt(original) && live.goal?.check === check && live.active;
			return;
		}
		if (digest(selection(cwd, live, original)) !== digest(selected))
			fail("stale_assignment", "Goal, evaluator, or retained outputs changed during approval");
		original.state = "retired"; original.retirement = proof; delete original.error;
		reconcile = true;
		return () => commitAt(cwd, live.policy.target) === selected.target;
	});
	return reconcile;
}
