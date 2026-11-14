import path from "node:path";
import { stableStringify } from "../digest.mjs";
import { enumeration, integer, list, object, strings, text } from "../factory/fields.mjs";
import { attemptIdentity } from "../plan/parallel-contracts.mjs";
import { createdChild } from "./dispatch.mjs";

/** @typedef {import("../types/parallel.js").AttemptIdentity} Attempt */
/** @typedef {ReturnType<typeof retentionSubject>} Subject */
/** @typedef {{code: string, message: string}} Hold */
/** @typedef {{epoch: string, sequence: number}} Checkpoint */
/** @typedef {{source: string, raw: unknown}} Receipt */
/** @typedef {{phase: string, source: string, raw?: unknown, error?: unknown}} Evidence */
/** @typedef {"inspected" | "held" | "unsupported" | "archived" | "denied" | "uncertain" | "not-archived"} Status */
/** @typedef {{subject: Subject, intentId: string | null, status: Status, code: string,
 * reasons: Hold[], evidence: Evidence[], receipt: Receipt | null}} RetentionResult */
/** @typedef {ReturnType<typeof observation>} Observation */
/** @typedef {{owner: string, sessionId: string, projectId: string, repositoryId: string, worktreePath: string}} Context */
/**
 * Internal composition contracts, NOT App APIs or schemas accepted from tool JSON.
 * The constructor is trusted code. Supplying these functions is not evidence that a
 * particular host implements them correctly; production composition must establish that.
 *
 * checkpoint/observe must use a common causally ordered host observation domain.
 * Observe reads current detail, then exhausts the associated session/task/attempt/run
 * inventory after that detail. Sequence numbers cannot be invented from local time.
 * Unknown/cross-host ordering, unavailable pages or uncorroborated aliases fail closed.
 *
 * assess consumes that observation and current canonical retention/consumer/evaluator
 * authorities. It must include source/ref/context/report/evaluator/artifact retention
 * outside every removable directory. This port does not implement that policy.
 *
 * conditionalArchive is an injected implementation obligation, not a feature flag or
 * ordinary archive_session wrapper. It must call reassess once, then atomically enforce
 * its conditions through the exact native archive_session effect, preserving native
 * permission. Its exclusion/conditional boundary must cover current identities,
 * activity/tasks/runs, PR/merge/automation, holds/retention and ALL workspace writers.
 * It must reject changes after reassessment before any effect, returning their reasons.
 * A snapshot, token, process lock, outbox fence or check-then-archive is insufficient.
 * Do not install this function unless the actual supported host provides that boundary.
 * The disabled extension-RPC route is unsupported. No alternative route is attempted.
 *
 * The canonical caller owns durable intent/start/outcome records. Call archive once
 * for a newly started intent, retain its entire result (including errors), then use
 * reconcile, never blind replay. There is no local retry/permission/hold database and
 * no exactly-once claim. Reconciliation requires an authoritative correlated native
 * operation disposition, not directory absence or an idle/listing observation.
 *
 * @typedef {object} RetentionHost
 * @property {string} source
 * @property {() => Context} [context]
 * @property {() => Promise<Checkpoint>} [checkpoint]
 * @property {(request: {subject: Subject, after: Checkpoint}) => Promise<Receipt>} [observe]
 * @property {(raw: unknown) => unknown} [decodeObservation]
 * @property {(observation: Observation) => Promise<{source: string, raw: unknown, reasons: Hold[]}>} [assess]
 * @property {() => "supported" | "unavailable" | "unproven" | "disabled"} [route]
 * @property {(request: {subject: Subject, intentId: string, reassess: () => Promise<RetentionResult>}) => Promise<Receipt>} [conditionalArchive]
 * @property {(raw: unknown) => unknown} [decodeArchive]
 * @property {(request: {subject: Subject, intentId: string, original: RetentionResult}) => Promise<Receipt | null>} [observeOutcome]
 * @property {(raw: unknown) => unknown} [decodeReconciliation]
 */

/** @param {unknown} value */
export function retentionSubject(value) {
	object(value, ["attempt", "child", "coordinatorSessionId", "runIds"], "retention subject");
	return {
		attempt: attemptIdentity(value.attempt), child: createdChild(value.child),
		coordinatorSessionId: text(value.coordinatorSessionId, "coordinator session", 512),
		runIds: strings(value.runIds, "retained run identities", 128),
	};
}

/** @param {unknown} value */
function checkpoint(value) {
	object(value, ["epoch", "sequence"], "causal checkpoint");
	return { epoch: text(value.epoch, "host observation epoch", 512), sequence: integer(value.sequence, "host sequence", 0) };
}

/** @param {unknown} value */
function holds(value) {
	return list(value, "actionable holds", 128).map(item => {
		object(item, ["code", "message"], "hold");
		return { code: text(item.code, "hold code", 128), message: text(item.message, "hold reason", 4096) };
	});
}

/** @param {unknown} a @param {unknown} b */
const same = (a, b) => stableStringify(a) === stableStringify(b);
/** @param {string} parent @param {string} child */
const contains = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);
/** @param {string} code @param {string} message */
const hold = (code, message) => ({ code, message });

/** Normalized host data, not a replacement for the host's actual causal guarantees.
 * @param {unknown} value */
function observation(value) {
	object(value, ["subject", "after", "detailSequence", "inventorySequence", "activity", "workspace", "pages"], "retention observation");
	object(value.workspace, ["tracked", "untracked", "ignored"], "workspace observation");
	const pages = list(value.pages, "inventory pages", 64, 1).map(page => {
		object(page, ["cursor", "next", "sessions", "attempts", "runs"], "inventory page");
		return {
			cursor: page.cursor === null ? null : text(page.cursor, "page cursor", 512),
			next: page.next === null ? null : text(page.next, "next cursor", 512),
			sessions: list(page.sessions, "session identities", 128).map(retentionSubject),
			attempts: list(page.attempts, "actual attempts", 128).map(item => {
				object(item, ["identity", "taskStatus", "attemptStatus"], "actual attempt");
				return {
					identity: attemptIdentity(item.identity),
					taskStatus: enumeration(item.taskStatus, ["pending", "running", "done", "failed", "blocked", "cancelled", "unknown"], "task status"),
					attemptStatus: enumeration(item.attemptStatus, ["reserved", "running", "done", "failed", "blocked", "cancelled", "unknown"], "attempt status"),
				};
			}),
			runs: list(page.runs, "actual runs", 128).map(item => {
				object(item, ["runId", "attempt", "status"], "actual native run");
				return {
					runId: text(item.runId, "run ID", 512), attempt: attemptIdentity(item.attempt),
					status: enumeration(item.status, ["pending", "running", "paused", "completed", "failed", "cancelled", "unknown"], "native run status"),
				};
			}),
		};
	});
	return {
		subject: retentionSubject(value.subject), after: checkpoint(value.after),
		detailSequence: integer(value.detailSequence, "detail sequence", 0),
		inventorySequence: integer(value.inventorySequence, "inventory sequence", 0),
		activity: enumeration(value.activity, ["idle", "busy", "unknown"], "native activity"),
		workspace: {
			tracked: strings(value.workspace.tracked, "tracked changes", 128),
			untracked: strings(value.workspace.untracked, "untracked files", 128),
			ignored: strings(value.workspace.ignored, "ignored files", 128),
		},
		pages,
	};
}

/** @param {Observation} value @param {Subject} subject @param {Checkpoint} after */
function observationHolds(value, subject, after) {
	/** @type {Hold[]} */
	const reasons = [];
	if (!same(value.subject, subject)) reasons.push(hold("identity-changed", "Canonical owner/subject/project/repository/worktree/attempt/run identity changed"));
	if (!same(value.after, after) || value.detailSequence <= after.sequence || value.inventorySequence <= value.detailSequence) {
		reasons.push(hold("stale-inventory", "Require detail after the checkpoint and exhaustive inventory causally after detail in the same host epoch"));
	}
	const cursors = new Set();
	for (const [index, page] of value.pages.entries()) {
		if (page.cursor !== (index === 0 ? null : value.pages[index - 1].next) || cursors.has(page.cursor)
			|| (index < value.pages.length - 1 && page.next === null) || (index === value.pages.length - 1 && page.next !== null)) {
			reasons.push(hold("incomplete-inventory", "Inventory pages are missing, repeated or not exhausted"));
			break;
		}
		cursors.add(page.cursor);
	}
	const sessions = value.pages.flatMap(page => page.sessions);
	const attempts = value.pages.flatMap(page => page.attempts);
	const runs = value.pages.flatMap(page => page.runs);
	if (sessions.length !== 1 || !same(sessions[0], subject)) reasons.push(hold("ambiguous-session", "Require one exact canonical owned session; conflicting aliases are not ownership"));
	if (attempts.length !== 1 || !same(attempts[0]?.identity, subject.attempt)) reasons.push(hold("attempt-inventory-changed", "Actual task/attempt inventory differs from the retained binding; reconcile newly discovered work"));
	if (runs.length !== subject.runIds.length || new Set(runs.map(run => run.runId)).size !== runs.length
		|| runs.some(run => !subject.runIds.includes(run.runId) || !same(run.attempt, subject.attempt))) {
		reasons.push(hold("run-inventory-changed", "Missing, foreign or newly discovered native runs require canonical reconciliation"));
	}
	if (attempts.some(item => !["done", "failed", "cancelled"].includes(item.taskStatus) || !["done", "failed", "cancelled"].includes(item.attemptStatus))
		|| runs.some(run => !["completed", "failed", "cancelled"].includes(run.status))) {
		reasons.push(hold("nonterminal-work", "Actual tasks, attempts and native runs must all have terminal dispositions"));
	}
	if (value.activity !== "idle") reasons.push(hold("activity-unsettled", "Current native activity is busy or unknown"));
	for (const kind of /** @type {const} */ (["tracked", "untracked", "ignored"])) {
		if (value.workspace[kind].length) reasons.push(hold(`workspace-${kind}`, `Retain ${kind} workspace bytes: ${value.workspace[kind].join(", ")}`));
	}
	return reasons;
}

/** @param {unknown} value @param {Subject} subject @param {string} intentId @param {boolean} reconciliation */
function disposition(value, subject, intentId, reconciliation) {
	object(value, ["subject", "intentId", "operation", "status", "reasons", ...(reconciliation ? ["basis"] : [])], "native archive disposition");
	if (!same(retentionSubject(value.subject), subject) || value.intentId !== intentId || value.operation !== "archive_session") {
		throw new Error("Native archive disposition has a foreign subject, intent or operation");
	}
	if (reconciliation && value.basis !== "native-operation") throw new Error("Reconciliation lacks authoritative native operation evidence");
	const status = enumeration(value.status, ["archived", "held", "denied", "unsupported", "uncertain", "not-archived"], "archive disposition");
	const reasons = holds(value.reasons);
	if ((status === "archived" && reasons.length) || (status !== "archived" && !reasons.length)) throw new Error("Disposition must retain consistent actionable reasons");
	return { status, reasons };
}

/** @param {{subject: Subject, host?: RetentionHost}} options */
export function createNativeRetention(options) {
	const bound = retentionSubject(options.subject);
	const host = options.host;
	const source = host ? text(host.source, "trusted host source", 4096) : "retention host unavailable";
	/** Every call receives a new value; no caller or injected callback can rewrite the binding. */
	const subject = () => retentionSubject(bound);
	/** @param {Status} status @param {string} code @param {Hold[]} reasons @param {Evidence[]} evidence
	 * @param {string | null} [intentId] @param {Receipt | null} [receipt] @returns {RetentionResult} */
	const result = (status, code, reasons, evidence, intentId = null, receipt = null) =>
		({ subject: subject(), intentId, status, code, reasons, evidence: [...evidence], receipt });
	/** @param {string} code @param {string} message @param {string | null} [intentId] */
	const unsupported = (code, message, intentId = null) => result("unsupported", code, [hold(code, message)], [], intentId);

	/** @param {Evidence[]} evidence */
	function ownerHolds(evidence) {
		if (!host?.context) throw new Error("Current native context is unavailable");
		const current = host.context();
		evidence.push({ phase: "context", source, raw: current });
		object(current, ["owner", "sessionId", "projectId", "repositoryId", "worktreePath"], "current owner context");
		for (const key of /** @type {const} */ (["owner", "sessionId", "projectId", "repositoryId", "worktreePath"])) text(current[key], key, 4096);
		if (!path.isAbsolute(current.worktreePath) || path.normalize(current.worktreePath) !== current.worktreePath
			|| path.parse(bound.child.worktreePath).root === bound.child.worktreePath
			|| contains(bound.child.worktreePath, current.worktreePath) || contains(current.worktreePath, bound.child.worktreePath)
			|| bound.child.sessionId === current.sessionId || bound.child.sessionId === bound.coordinatorSessionId) {
			return [hold("owner-or-self", "Never archive the owner/self worktree or overlapping worktree roots")];
		}
		if (bound.attempt.owner !== current.owner || bound.attempt.repositoryId !== current.repositoryId
			|| bound.child.projectId !== current.projectId || bound.child.creatorSessionId !== current.sessionId
			|| bound.coordinatorSessionId !== current.sessionId) {
			return [hold("foreign-subject", "Subject must remain owned by this exact current native coordinator/project/repository")];
		}
		return [];
	}

	/** @returns {Promise<RetentionResult>} */
	async function inspect() {
		if (!host?.context || !host.checkpoint || !host.observe) return unsupported("unsupported-observation", "Current identity and causally ordered host observation are required");
		if (!host.decodeObservation) return unsupported("unsupported-decoder", "No supported native observation decoder");
		if (!host.assess) return unsupported("unsupported-retention", "Current canonical retention and hold assessment is unavailable");
		/** @type {Evidence[]} */
		const evidence = [];
		try {
			const identityHolds = ownerHolds(evidence);
			if (identityHolds.length) return result("held", identityHolds[0].code, identityHolds, evidence);
			const after = checkpoint(await host.checkpoint());
			evidence.push({ phase: "checkpoint", source, raw: after });
			const raw = await host.observe({ subject: subject(), after: { ...after } });
			evidence.push({ phase: "observation", source: raw.source, raw: raw.raw });
			text(raw.source, "native observation source", 4096);
			const observed = observation(host.decodeObservation(structuredClone(raw.raw)));
			const reasons = [...ownerHolds(evidence), ...observationHolds(observed, bound, after)];
			if (reasons.length) return result("held", reasons[0].code, reasons, evidence);
			const assessment = await host.assess(observed);
			evidence.push({ phase: "assessment", source: assessment.source, raw: assessment.raw });
			object(assessment, ["source", "raw", "reasons"], "retention assessment");
			text(assessment.source, "canonical retention source", 4096);
			const retentionHolds = holds(assessment.reasons);
			return result(retentionHolds.length ? "held" : "inspected", retentionHolds[0]?.code ?? "inspection-only", retentionHolds, evidence);
		} catch (error) {
			evidence.push({ phase: "inspection-error", source, error });
			return result("held", "observation-unconfirmed", [hold("observation-unconfirmed", "Retain the original observation/decoder/assessment error; eligibility is unconfirmed")], evidence);
		}
	}

	/** @param {unknown} request @returns {Promise<RetentionResult>} */
	async function archive(request) {
		object(request, ["intentId"], "canonical archive intent");
		const intentId = text(request.intentId, "intent ID", 512);
		if (!host?.route) return unsupported("unsupported-route", "No current supported permission-preserving native archive route", intentId);
		if (!host.conditionalArchive) return unsupported("unsupported-race-safety", "Host cannot exclude eligibility changes through the native archive effect", intentId);
		if (!host.decodeArchive) return unsupported("unsupported-decoder", "No supported native archive-result decoder", intentId);
		if (!host.observeOutcome || !host.decodeReconciliation) return unsupported("unsupported-reconciliation",
			"Authoritative correlated original-operation outcome observation and decoding are required before archival", intentId);
		/** @type {Evidence[]} */
		const evidence = [];
		/** @type {Receipt | null} */
		let receipt = null;
		let invoked = false, assessments = 0, accepted = false, closed = false;
		try {
			const route = host.route();
			evidence.push({ phase: "route", source, raw: route });
			if (route !== "supported") return result("unsupported", "unsupported-route", [hold("unsupported-route", "Native route is unavailable, disabled or unproven; no fallback")], evidence, intentId);
			const preliminary = await inspect();
			evidence.push(...preliminary.evidence);
			if (preliminary.status !== "inspected") return { ...preliminary, intentId, evidence };
			invoked = true;
			receipt = await host.conditionalArchive({
				subject: subject(), intentId,
				async reassess() {
					if (closed || assessments++) throw new Error("Archive boundary must reassess exactly once while active");
					const route = host.route?.();
					evidence.push({ phase: "action-route", source, raw: route });
					if (route !== "supported") return unsupported("unsupported-route", "Native route changed before the effect; preserve the subject", intentId);
					const current = await inspect();
					evidence.push(...current.evidence);
					accepted = current.status === "inspected";
					return { ...current, intentId };
				},
			});
			closed = true;
			evidence.push({ phase: "archive", source: receipt.source, raw: receipt.raw });
			text(receipt.source, "native archive source", 4096);
			const decoded = disposition(host.decodeArchive(structuredClone(receipt.raw)), bound, intentId, false);
			if (decoded.status === "archived" && (assessments !== 1 || !accepted)) throw new Error("Archive result lacks a successful action-boundary reassessment");
			return result(decoded.status, decoded.reasons[0]?.code ?? "native-archived", decoded.reasons, evidence, intentId, receipt);
		} catch (error) {
			closed = true;
			evidence.push({ phase: invoked ? "archive-error" : "route-error", source, error });
			const code = invoked ? "archive-uncertain" : "route-unconfirmed";
			return result(invoked ? "uncertain" : "unsupported", code, [hold(code, "Retain the original error/result; do not retry archive or infer success from worktree absence")], evidence, intentId, receipt);
		}
	}

	/** Read-only. The canonical caller supplies its original persisted result, not a new
	 * synthetic receipt. Return that receipt unchanged even when reconciliation resolves it.
	 * @param {RetentionResult} original @returns {Promise<RetentionResult>} */
	async function reconcile(original) {
		const intentId = text(original.intentId, "original intent ID", 512);
		if (!same(retentionSubject(original.subject), bound)) throw new Error("Cannot reconcile another subject");
		const evidence = [...original.evidence];
		/** @param {string} code @param {string} message */
		const unresolved = (code, message) => result("uncertain", code, [hold(code, message)], evidence, intentId, original.receipt);
		if (!host?.context || !host.observeOutcome || !host.decodeReconciliation) return unresolved("unsupported-reconciliation", "Authoritative identity-bound native operation reconciliation is unavailable");
		try {
			const reasons = ownerHolds(evidence);
			if (reasons.length) return unresolved(reasons[0].code, reasons[0].message);
			const observed = await host.observeOutcome({ subject: subject(), intentId, original });
			if (observed === null) return unresolved("disposition-unresolved", "No authoritative correlated operation disposition; absence is not success");
			evidence.push({ phase: "reconciliation", source: observed.source, raw: observed.raw });
			text(observed.source, "native reconciliation source", 4096);
			const decoded = disposition(host.decodeReconciliation(structuredClone(observed.raw)), bound, intentId, true);
			if (["archived", "not-archived", "denied"].includes(original.status) && decoded.status !== original.status) {
				return unresolved("conflicting-disposition", "Original receipt and native reconciliation conflict; preserve both");
			}
			return result(decoded.status, decoded.reasons[0]?.code ?? "native-archived", decoded.reasons, evidence, intentId, original.receipt);
		} catch (error) {
			evidence.push({ phase: "reconciliation-error", source, error });
			return unresolved("disposition-unresolved", "Retain original and reconciliation evidence; native disposition remains unconfirmed");
		}
	}
	return { inspect, archive, reconcile };
}
