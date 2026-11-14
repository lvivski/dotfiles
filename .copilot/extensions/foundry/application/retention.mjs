import { errorCode, errorMessage, readJsonValue } from "../data.mjs";
import { fail, object, timestamp } from "../factory/fields.mjs";
import { assessRetention, retentionEvent, retentionId, retentionIntentId, retentionObservation, retentionOutcome, retentionScope, retentionSubject, sameRetention } from "../plan/retention.mjs";

/** @typedef {import("../types/retention.js").RetentionIntent} Intent */
/** @typedef {import("../types/retention.js").RetentionEvent} Event */
/** @typedef {import("../types/retention.js").RetentionResult} Result */
/** @typedef {import("../types/retention.js").RetentionOutcome} Outcome */

/** Constructor injection is trusted composition, never a tool-request capability.
 * There are no timers, cancellation/release operations, alternative routes or retries.
 * @param {import("../types/retention.js").RetentionDependencies} dependencies */
export function createRetentionOperations({ scope: inputScope, persistence, observations, artifacts, archive, clock = () => new Date().toISOString() }) {
	const scope = retentionScope(inputScope);
	const now = () => timestamp(clock(), "retention clock");
	/** @param {unknown} error @param {Intent | null} [intent] @param {unknown} [unpersisted] @returns {Result} */
	function held(error, intent = null, unpersisted) {
		return { state: "held", holds: [{ code: errorCode(error) ?? "retention_failed", reason: errorMessage(error), authority: "owning retention integration" }],
			intent, ...(unpersisted === undefined ? {} : { unpersisted }) };
	}
	/** @param {Intent} intent @returns {Result} */
	function result(intent) {
		const outcome = intent.outcomes.at(-1), assessment = intent.assessments.at(-1);
		if (outcome?.disposition === "archived") return { state: "archived", holds: [], intent };
		if (intent.start) return { state: "held", intent, holds: [{ code: `retention_${outcome?.disposition ?? "in_flight"}`,
			reason: "Retain the original operation and reconcile its outcome; never retry the archive route", authority: "native archive authority" }] };
		if (!assessment) fail("retention_assessment_missing", "Intent has no assessment");
		return { state: assessment.state, holds: assessment.holds, intent };
	}
	/** @param {unknown} input */
	const eventRequest = (input) => {
		object(input, ["eventId"], "completion notification");
		return retentionId(input.eventId, "eventId");
	};
	/** @param {unknown} input */
	const intentRequest = (input) => {
		object(input, ["intentId"], "intent request");
		return retentionId(input.intentId, "intentId");
	};
	/** @param {string} eventId */
	async function completion(eventId) {
		const event = retentionEvent(await observations.completion(eventId));
		if (event.id !== eventId) fail("retention_event_conflict", "Observer returned another canonical completion");
		return event;
	}
	/** @param {Event} event @param {Intent | null} previous */
	async function assess(event, previous) {
		const observation = retentionObservation(await observations.capture(structuredClone(event)));
		const manifest = await artifacts.inspect(structuredClone(event), structuredClone(observation));
		const assessment = assessRetention(scope, event, observation, manifest, now(), previous?.assessments ?? []);
		return persistence.assess(event, assessment);
	}
	/** @param {Event} event @param {Intent | null} previous */
	function exact(event, previous) {
		if (previous && !sameRetention(event, previous.event)) fail("retention_event_conflict", "A changed completion cannot reuse the original intent");
	}
	/** Completion is an assessment trigger only, never permission to archive.
	 * @param {unknown} input @returns {Promise<Result>} */
	async function completionEvent(input) {
		try {
			const event = await completion(eventRequest(input)), previous = persistence.read(retentionIntentId(event));
			exact(event, previous);
			return result(previous ?? await assess(event, null));
		} catch (error) { return held(error); }
	}
	/** A later authority release needs new observed evidence, not a released flag.
	 * @param {unknown} input @returns {Promise<Result>} */
	async function reassess(input) {
		try {
			object(input, ["eventId", "subject"], "subject reassessment");
			const event = await completion(retentionId(input.eventId)), subject = retentionSubject(input.subject);
			if (!sameRetention(event.subject, subject)) fail("retention_subject_changed", "Reassessment names another attempt or subject");
			const previous = persistence.read(retentionIntentId(event));
			exact(event, previous);
			if (previous?.start) return result(previous);
			return result(await assess(event, previous));
		} catch (error) { return held(error); }
	}
	/** @param {Intent} intent @param {unknown} value @returns {Result} */
	function retainOutcome(intent, value) {
		try {
			return result(persistence.outcome(intent.id, retentionOutcome(value)));
		} catch (error) {
			return held(error, intent, value);
		}
	}
	/** @param {Intent} intent @param {unknown} error @param {unknown} [receipt] @returns {Outcome} */
	function uncertain(intent, error, receipt = null) {
		if (!intent.start) fail("retention_intent_missing", "An unstarted operation cannot have an invocation outcome");
		return { version: 1, operationId: intent.start.operationId, subject: intent.event.subject, disposition: "uncertain",
			at: now(), source: "retention archive invocation boundary",
			receipt: readJsonValue(receipt), error: { code: errorCode(error) ?? "retention_invocation_uncertain", message: errorMessage(error) } };
	}
	/** An explicit continuation, separate from the completion-event hook. The native
	 * guard covers all awaited observations and the sole permission-preserving call.
	 * Persistence admission alone cannot acquire that guard or grant native permission.
	 * @param {unknown} input @returns {Promise<Result>} */
	async function execute(input) {
		/** @type {Intent | null} */
		let intent = null;
		try {
			intent = persistence.read(intentRequest(input));
			if (!intent) fail("retention_intent_missing", "Assess the canonical completion before execution");
			if (intent.start) return result(intent);
			if (!archive || typeof archive.withSubjectGuard !== "function" || typeof archive.reconcile !== "function") {
				fail("retention_action_time_unsupported", "Trusted action-time ownership, permission and race-exclusion semantics are unavailable");
			}
			const retained = intent;
			let guardOpen = true, entered = false;
			/** @type {Result | undefined} */
			let actionResult;
			try {
				const guarded = await archive.withSubjectGuard(structuredClone(retained.event.subject), async invoke => {
					if (!guardOpen || entered || typeof invoke !== "function") fail("retention_guard_invalid", "One live native exclusion scope and its supported invocation function are required");
					entered = true;
					const event = await completion(retained.event.id);
					if (!guardOpen) fail("retention_guard_invalid", "Native exclusion ended before current-state inspection");
					exact(event, retained);
					intent = await assess(event, persistence.read(retained.id));
					if (!guardOpen) fail("retention_guard_invalid", "Native exclusion ended before start admission");
					const candidate = result(intent);
					if (candidate.state !== "candidate") return actionResult = candidate;
					const assessment = intent.assessments.at(-1);
					if (!assessment) fail("retention_assessment_missing", "Current assessment is missing");
					intent = persistence.start(intent.id, intent.revision, assessment.id);
					if (!intent.start) fail("retention_start_missing", "Canonical admission did not retain the immutable operation");
					let raw;
					try {
						raw = await invoke(structuredClone(intent.start));
					} catch (error) {
						return actionResult = retainOutcome(intent, uncertain(intent, error));
					}
					try {
						const outcome = retentionOutcome(raw);
						if (outcome.operationId !== intent.start.operationId || !sameRetention(outcome.subject, intent.event.subject)) {
							fail("retention_outcome_mismatch", "Native result identifies another archive operation");
						}
						return actionResult = retainOutcome(intent, outcome);
					} catch (error) {
						// Invalid results remain original evidence, never success or a second call.
						try { return actionResult = retainOutcome(intent, uncertain(intent, error, raw)); }
						catch (recordError) { return actionResult = held(recordError, intent, raw); }
					}
				});
				if (!entered || !actionResult || guarded !== actionResult) fail("retention_guard_invalid", "Host guard did not await and return its exact action result");
				return guarded;
			} finally { guardOpen = false; }
		} catch (error) { return held(error, intent); }
	}
	/** Read-only reconciliation is the sole continuation after single-start admission.
	 * Missing/denied/uncertain results cannot select another route or reset admission.
	 * @param {unknown} input @returns {Promise<Result>} */
	async function reconcile(input) {
		/** @type {Intent | null} */
		let intent = null;
		try {
			intent = persistence.read(intentRequest(input));
			if (!intent) fail("retention_intent_missing", "No original intent to reconcile");
			if (!intent.start || (intent.outcomes.length && intent.outcomes.at(-1)?.disposition !== "uncertain")) return result(intent);
			if (!archive || typeof archive.reconcile !== "function") fail("retention_reconciliation_unsupported", "Exact original outcome observation is unavailable");
			const raw = await archive.reconcile(structuredClone(intent.start));
			return raw === null ? result(intent) : retainOutcome(intent, raw);
		} catch (error) { return held(error, intent); }
	}
	return Object.freeze({ completionEvent, reassess, execute, reconcile });
}
