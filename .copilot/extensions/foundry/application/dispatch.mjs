import { errorCode, errorMessage, isList, isRecord, readJsonValue, readRecord } from "../data.mjs";
import { analysisInputDigest, stableStringify } from "../digest.mjs";
import { fail, integer } from "../factory/fields.mjs";
import { admissionIdentity, reservedInputs } from "../plan/parallel-contracts.mjs";
import { validatePlan } from "../plan/validation.mjs";

/** @typedef {import("../types/parallel.js").AdmissionIdentity} Identity */
/** @typedef {import("../types/parallel.js").AttemptIdentity} Attempt */
/** @typedef {import("../types/parallel.js").EffectReceipt} Receipt */
/** @typedef {import("../types/parallel.js").AdmissionRecord} Admission */
/** @typedef {import("../types/json.js").JsonValue} Json */
/** @typedef {import("../native/admission.mjs").NativeResult} NativeResult */
/** @typedef {ReturnType<typeof import("../native/dispatch.mjs").createNativeDispatch>} NativeDispatch */
/** @typedef {ReturnType<NativeDispatch["dispatchReservation"]>} Reservation */
/** @typedef {ReturnType<NativeDispatch["createdChild"]>} Child */
/** @typedef {{identity: Identity, request: import("../requests.mjs").Request<"completeTask">, terminalRunIds: string[]}} Completion */

/** @param {Admission} record */
const fence = (record) => ({ admission: record.identity, revision: record.revision, epoch: record.epoch });
/** @param {Attempt} attempt @param {Receipt["kind"]} kind */
const effectId = (attempt, kind) => `${kind}-${analysisInputDigest(attempt)}`;
/** @param {unknown} error */
const held = (error) => ({ state: /** @type {const} */ ("held"), code: errorCode(error) ?? "dispatch_failed", reason: errorMessage(error) });

/**
 * Bounded coordinator entry: call runReady once on an App notification or explicit request,
 * or reconcile one admitted identity with dispatch. There are no subscriptions or timers.
 * T-003 supplies reserve/ready and the only admission store. T-007 composes host observation
 * and complete input-resolution ports; metadata or this journal cannot authorize them.
 *
 * @param {{
 * admission: import("../types/parallel.js").AdmissionPort,
 * journal: ReturnType<typeof import("../storage/dispatch.mjs").createDispatchJournal>,
 * native: NativeDispatch,
 * plans: ReturnType<typeof import("../native/admission.mjs").createNativeAdmission>,
 * inputs?: Pick<import("../types/parallel.js").InputPort, "resolve">,
 * reserve: (identity: Identity) => Promise<Reservation>,
 * ready: () => Promise<Identity[]>,
 * clock?: () => string
 * }} dependencies
 */
export function createDispatchOperations({ admission, journal, native, plans, inputs, reserve, ready, clock = () => new Date().toISOString() }) {
	/** @param {Identity} identity */
	function owned(identity) {
		identity = admissionIdentity(identity);
		if (identity.owner !== native.transport.owner) fail("dispatch_foreign_plan", "Dispatch cannot control foreign-owner admissions");
		const record = admission.read(identity);
		if (!record || stableStringify(record.identity) !== stableStringify(identity)) fail("dispatch_admission_missing", "No authoritative owned admission");
		return record;
	}
	/** @param {Attempt} attempt */
	function current(attempt) {
		const { attemptId, ...identity } = attempt;
		const record = owned(identity);
		if (stableStringify(record.attempt) !== stableStringify(attempt)) fail("dispatch_attempt_mismatch", "The authoritative attempt changed");
		return record;
	}
	/** @param {Attempt} attempt @param {Receipt["kind"]} kind */
	const find = (attempt, kind) => {
		const authoritative = current(attempt).receipts.find(receipt => receipt.kind === kind);
		const persisted = journal.read(attempt).find(receipt => receipt.kind === kind);
		if (stableStringify(authoritative) !== stableStringify(persisted)) fail("dispatch_journal_mismatch", "Admission and journal receipts disagree; recovered success is not authority");
		return persisted;
	};
	/** @param {Receipt} receipt */
	function savedResult(receipt) {
		const saved = journal.outcomes(receipt.attempt, receipt.id).at(-1);
		if (!isRecord(saved) || typeof saved.source !== "string" || !Object.hasOwn(saved, "raw") || !Object.hasOwn(saved, "value") || Object.hasOwn(saved, "error")) {
			fail("dispatch_receipt_missing", "Successful effect lacks its durable native result");
		}
		return { value: saved.value, raw: readJsonValue(saved.raw), source: saved.source };
	}
	/** @param {Receipt} receipt @param {Json} result */
	function retain(receipt, result) {
		const record = current(receipt.attempt);
		try {
			return admission.withFence(fence(record), tx => journal.recordResult(tx, receipt, result));
		} catch (error) {
			if (errorCode(error) !== "revision_conflict") throw error;
			const actual = find(receipt.attempt, receipt.kind);
			// Compare the complete durable postcondition; no stale write is replayed.
			if (actual && stableStringify(actual) === stableStringify(receipt)
				&& journal.outcomes(receipt.attempt, receipt.id).some(item => stableStringify(item) === stableStringify(result))) return actual;
			throw error;
		}
	}
	/** @param {Attempt} attempt @param {Receipt["kind"]} kind @param {Json} payload
	 * @param {(correlation: string) => Promise<NativeResult>} invoke @param {(value: unknown) => string} decode */
	async function effect(attempt, kind, payload, invoke, decode) {
		const payloadDigest = analysisInputDigest(payload);
		let receipt = find(attempt, kind);
		if (receipt && receipt.payloadDigest !== payloadDigest) fail("parallel_receipt_identity", "Prepared native effect changed across callbacks");
		if (!receipt) {
			const record = current(attempt);
			receipt = admission.withFence(fence(record), tx => journal.prepare(tx, {
				id: effectId(attempt, kind), attempt, kind, epoch: record.epoch, payloadDigest,
				state: "intent", sessionId: null, runId: null, source: "prepared by owning coordinator", at: clock(),
			}, payload));
		}
		if (receipt.state === "succeeded") {
			const result = savedResult(receipt);
			const returnedId = decode(result.value);
			if (returnedId !== (kind === "workflow" ? receipt.runId : receipt.sessionId)) fail("dispatch_receipt_mismatch", "Saved native result identity differs from its successful receipt");
			return { receipt, result };
		}
		if (receipt.state === "definitive-failure" || receipt.state === "cancelled-before-start") fail("dispatch_effect_terminal", "Failed/cancelled native effect requires the admission authority's disposition, not replay");
		let result;
		try {
			if (receipt.state === "intent") {
				const record = current(attempt);
				const id = receipt.id;
				receipt = admission.withFence(fence(record), tx => journal.start(tx, id));
				// start is the cancellation linearization point. No await occurs before invocation.
				result = await invoke(receipt.id);
			} else {
				result = await native.reconcile(receipt, payload);
				if (!result) fail("dispatch_effect_uncertain", "Retained effect has no exact authoritative outcome; keep reservation/resources held");
			}
			const id = decode(result.value);
			const completed = { ...receipt, state: /** @type {const} */ ("succeeded"),
				sessionId: kind === "workflow" ? null : id, runId: kind === "workflow" ? id : null,
				source: result.source, at: clock() };
			retain(completed, readJsonValue({ ...result, startedAt: receipt.at }));
			return { receipt: completed, result };
		} catch (error) {
			const latest = find(attempt, kind);
			if (latest?.state === "in-flight" && errorCode(error) !== "revision_conflict" && errorCode(error) !== "dispatch_already_started") {
				const nativeError = native.classifyError(error);
				const outcome = nativeError?.disposition === "definitive-failure"
					? /** @type {const} */ ("definitive-failure") : /** @type {const} */ ("uncertain");
				retain({ ...latest, state: outcome, source: result?.source ?? `${errorCode(error) ?? "native-error"}: ${errorMessage(error)}`.slice(0, 4096), at: clock() },
					readJsonValue({ source: result?.source ?? "native failure", raw: result?.raw ?? nativeError?.receipt ?? null,
						value: result?.value ?? null, startedAt: receipt.at, error: { code: errorCode(error) ?? "dispatch_failed", message: errorMessage(error) } }));
			}
			throw error;
		}
	}
	/** @param {Reservation} reservation @param {string} sessionId @param {string} branch */
	async function attached(reservation, sessionId, branch) {
		const status = await plans.status(reservation.attempt.planId);
		const attempt = status.plan.tasks.find(task => task.id === reservation.attempt.taskId)?.attempts.find(item => item.id === reservation.attempt.attemptId);
		if (attempt?.sessionId !== sessionId || attempt.branch !== branch || attempt.reservationId !== reservation.attempt.reservationId
			|| attempt.status !== "running" || status.plan.status !== "running") return null;
		return status;
	}
	/** @param {unknown} value @param {Reservation} reservation @param {Child} child */
	function attachmentResult(value, reservation, child) {
		const plan = validatePlan(isRecord(value) && "plan" in value ? value.plan : value);
		const attempt = plan.tasks.find(task => task.id === reservation.attempt.taskId)?.attempts.find(item => item.id === reservation.attempt.attemptId);
		if (plan.id !== reservation.attempt.planId || plan.factory?.owner !== reservation.attempt.owner
			|| plan.factory.repositoryId !== reservation.attempt.repositoryId || plan.status !== "running"
			|| attempt?.sessionId !== child.sessionId || attempt.branch !== child.branch
			|| attempt.reservationId !== reservation.attempt.reservationId || attempt.status !== "running") {
			fail("dispatch_attachment_unconfirmed", "Recovered attachment receipt is not the exact owned native postcondition");
		}
		return child.sessionId;
	}
	/** @param {Identity} identity */
	async function dispatch(identity) {
		try {
			identity = admissionIdentity(identity);
			if (identity.owner !== native.transport.owner) fail("dispatch_foreign_plan", "Foreign-owner dispatch is forbidden");
			const previous = admission.read(identity);
			const stored = previous?.attempt ? journal.payload(previous.attempt, "creation") : null;
			const reservation = native.dispatchReservation(isRecord(stored) ? stored.reservation : await reserve(identity));
			const { attemptId, ...reservedIdentity } = reservation.attempt;
			if (stableStringify(reservedIdentity) !== stableStringify(identity)) fail("dispatch_attempt_mismatch", "Reservation returned another admission");
			if (current(reservation.attempt).phase !== "reserved") fail("parallel_fenced", "Cancellation or terminal admission forbids dispatch");
			if (reservation.inputs) {
				if (!inputs) fail("dispatch_input_resolver_unavailable", "Complete producer inputs require the owned resolver; metadata alone is not delivery evidence");
				const resolved = reservedInputs(inputs.resolve(reservation.attempt, reservation.inputs.bootstrap, reservation.requiredInputs));
				if (stableStringify(resolved) !== stableStringify(reservation.inputs)) fail("dispatch_inputs_changed", "Owned producer resolution differs from the reserved immutable handoff");
			}
			native.preflight();
			const beforeCreation = await plans.status(identity.planId);
			const reserved = beforeCreation.plan.tasks.find(task => task.id === identity.taskId)?.attempts.find(item => item.id === reservation.attempt.attemptId);
			if (beforeCreation.plan.status !== "running" || beforeCreation.plan.factory?.repositoryId !== identity.repositoryId
				|| reserved?.reservationId !== identity.reservationId || reserved.baseBranch !== reservation.baseBranch
				|| !["reserved", "running"].includes(reserved.status)) fail("dispatch_reservation_unconfirmed", "Fresh owned native reservation is missing or no longer active");
			if (!find(reservation.attempt, "creation") && (reserved.status !== "reserved" || reserved.sessionId !== null)) {
				fail("dispatch_reservation_unconfirmed", "An attached attempt without this journal's creation receipt cannot create another child");
			}
			const creation = await effect(reservation.attempt, "creation", readJsonValue({
				reservation, arguments: native.createArguments(reservation),
			}), correlation => native.create(reservation, correlation), value => native.decodeCreated(value, reservation).sessionId);
			const created = native.decodeCreated(creation.result.value, reservation);
			const attachment = find(reservation.attempt, "attachment");
			let child = created;
			if (!attachment || attachment.state === "intent") {
				const started = journal.outcomes(reservation.attempt, creation.receipt.id).find(item => isRecord(item) && typeof item.startedAt === "string");
				const creationStartedAt = isRecord(started) && typeof started.startedAt === "string" ? started.startedAt : creation.receipt.at;
				const corroboration = await native.corroborate(created, reservation, creationStartedAt);
				child = corroboration.child;
				const status = await plans.status(reservation.attempt.planId);
				if (status.plan.status !== "running") fail("parallel_fenced", "Native plan is not running");
				const payload = readJsonValue({ child, baseCommit: reservation.baseCommit, expectedRevision: status.plan.revision, corroboration });
				const prepared = attachment ? journal.payload(reservation.attempt, "attachment") : payload;
				if (!isRecord(prepared) || stableStringify(prepared.child) !== stableStringify(child)
					|| prepared.baseCommit !== reservation.baseCommit || prepared.expectedRevision !== status.plan.revision) {
					fail("dispatch_attachment_changed", "Fresh attachment arguments differ from the unstarted durable intent; do not execute under its old digest");
				}
				await effect(reservation.attempt, "attachment", readJsonValue(prepared), async correlation => {
					try {
						return await plans.attach(reservation.attempt, status.plan.revision, { ...child, baseCommit: reservation.baseCommit }, correlation);
					} catch (error) {
						if (errorCode(error) !== "revision_conflict") throw error;
						const matching = await attached(reservation, child.sessionId, child.branch);
						if (matching) return matching;
						throw error;
					}
				}, value => attachmentResult(value, reservation, child));
			} else {
				const payload = journal.payload(reservation.attempt, "attachment");
				if (!isRecord(payload) || !isRecord(payload.child)) fail("dispatch_receipt_missing", "Attachment lacks canonical child receipt");
				child = native.createdChild(payload.child);
				if (child.sessionId !== created.sessionId || child.projectId !== created.projectId
					|| child.creatorSessionId !== created.creatorSessionId || child.worktreePath !== created.worktreePath) fail("dispatch_child_mismatch", "Durable attachment changed the created child");
				await effect(reservation.attempt, "attachment", readJsonValue(payload), async () => {
					throw new Error("Existing attachment cannot be relaunched");
				}, value => attachmentResult(value, reservation, child));
			}
			if (!await attached(reservation, child.sessionId, child.branch)) fail("dispatch_attachment_unconfirmed", "Fresh owned native attachment postcondition is missing");
			const handoff = await effect(reservation.attempt, "handoff", readJsonValue({ child, delegationPrompt: reservation.delegationPrompt, inputs: reservation.inputs }),
				correlation => native.handoff(reservation, child, correlation), value => native.decodeHandoff(value, child.sessionId));
			return { state: /** @type {const} */ ("handed-off"), sessionId: child.sessionId, receipt: handoff.receipt,
				inputsMaterialized: false, executionObserved: false };
		} catch (error) { return held(error); }
	}
	/** @param {Attempt} attempt @param {Json} launchSpec */
	async function launch(attempt, launchSpec) {
		try {
			current(attempt);
			native.transport.ensure("run_dynamic_workflow");
			const launched = await effect(attempt, "workflow", readJsonValue(launchSpec), correlation => native.launch(launchSpec, correlation), native.decodeRun);
			return { state: /** @type {const} */ ("launched"), runId: launched.receipt.runId, receipt: launched.receipt };
		} catch (error) { return held(error); }
	}
	/** @param {Completion} completion */
	async function complete({ identity, request, terminalRunIds }) {
		try {
			const record = owned(identity);
			if (!record.attempt || request.planId !== identity.planId || request.taskId !== identity.taskId || request.attemptId !== record.attempt.attemptId) {
				fail("dispatch_delivery_mismatch", "Completion must identify the exact owned reservation");
			}
			if (record.phase === "cancelling" || record.phase === "claim-held") fail("parallel_fenced", "Cancellation/unfinished reservation forbids a new native completion mutation");
			const handoff = find(record.attempt, "handoff");
			if (handoff?.state !== "succeeded" || !handoff.sessionId) fail("dispatch_delivery_unconfirmed", "Delivery requires a successful handoff receipt");
			const matches = (/** @type {import("../types/plan.js").FoundryPlan} */ plan) => {
				const item = plan.tasks.find(task => task.id === request.taskId)?.attempts.find(item => item.id === request.attemptId);
				const expectedEvidence = request.evidence === undefined ? [] : request.evidence;
				return item?.status === request.status && item.sessionId === handoff.sessionId && item.commit === (request.commit ?? null)
					&& item.resultSummary === (request.resultSummary ?? null) && (request.branch === undefined || item.branch === request.branch)
					&& item.reservationId === identity.reservationId && item.prUrl === (request.prUrl ?? null)
					&& isList(expectedEvidence) && item.evidence.length === expectedEvidence.length
					&& expectedEvidence.every((expected, index) => {
						if (!isRecord(expected)) return false;
						const actual = typeof expected.checkId === "string" ? item.evidence.find(entry => entry.checkId === expected.checkId) : item.evidence[index];
						return actual !== undefined && Object.entries(expected)
							.every(([key, value]) => stableStringify(readRecord(actual)[key]) === stableStringify(value));
					});
			};
			let terminal;
			try { terminal = record.delivery ? await plans.status(identity.planId) : await plans.complete(request); }
			catch (error) {
				if (errorCode(error) !== "revision_conflict") throw error;
				terminal = await plans.status(identity.planId);
				if (!matches(terminal.plan)) throw error;
			}
			if (!matches(terminal.plan)) fail("dispatch_delivery_mismatch", "Terminal postcondition does not match intended delivery");
			if (request.status !== "done" || !request.commit) fail("dispatch_terminal_requires_settlement", "Failure is durable; admission cancellation/settlement must retain all owned effects");
			const receipt = { attempt: record.attempt, sessionId: handoff.sessionId, commit: request.commit,
				planRevision: terminal.plan.revision, source: terminal.source, terminalRunIds };
			const fresh = owned(identity);
			if (fresh.delivery) {
				if (fresh.delivery.commit !== receipt.commit || fresh.delivery.sessionId !== receipt.sessionId
					|| stableStringify(fresh.delivery.terminalRunIds) !== stableStringify(terminalRunIds)) fail("dispatch_delivery_mismatch", "Admission delivery differs");
			} else {
				try { admission.deliver(fence(fresh), receipt); }
				catch (error) {
					if (errorCode(error) !== "revision_conflict" || stableStringify(owned(identity).delivery) !== stableStringify(receipt)) throw error;
				}
			}
			return { state: /** @type {const} */ ("delivered"), receipt };
		} catch (error) { return held(error); }
	}
	return {
		dispatch, launch, complete,
		/** Record ALL terminal notifications before asking the admission owner for ready work.
		 * Each identity is visited once, with an explicit caller-supplied bound; never poll.
		 * @param {{limit: number, completions?: Completion[]}} input */
		async runReady({ limit, completions = [] }) {
			integer(limit, "dispatch batch bound", 1, 128);
			if (completions.length > 128) fail("dispatch_batch_invalid", "Completion batch exceeds 128");
			for (const completion of completions) {
				const result = await complete(completion);
				if (result.state === "held") return { state: /** @type {const} */ ("held"), results: [result] };
			}
			const candidates = await ready();
			const unique = [...new Map(candidates.map(identity => [stableStringify(admissionIdentity(identity)), identity])).values()];
			const results = [];
			for (const identity of unique.slice(0, limit)) results.push(await dispatch(identity));
			return { state: /** @type {const} */ ("bounded"), results };
		},
	};
}
