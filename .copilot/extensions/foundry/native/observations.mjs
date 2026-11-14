import { readJsonValue } from "../data.mjs";
import { buildAssuranceSubject } from "../analysis/assurance.mjs";
import { validatePackageAssurance } from "../bridge/evidence.mjs";
import { analysisInputDigest, stableStringify } from "../digest.mjs";
import { enumeration, list, object, strings, text, timestamp } from "../factory/fields.mjs";
import { visualReport } from "../factory/visual.mjs";
import { normalizeRecoveryInventory } from "../inventory.mjs";
import { admissionIdentity, commitId, consumerEntry, effectReceipt } from "../plan/parallel-contracts.mjs";
import { DispatchNativeError } from "./admission.mjs";
import { createdChild } from "./dispatch.mjs";

/** @typedef {import("../types/parallel.js").ParallelHost & {state: "available"}} Host */
/** @typedef {Host["session"] & {repositoryId: string}} Context */
/** @typedef {{context: Context, subjectDigest: string, capturedAt: string, source: string, complete: boolean, value: unknown}} Capture */
/** These are trusted host-provider ports, NOT schemas offered by the nine tools.
 * The SDK currently supplies neither cross-child transcripts nor complete contributor
 * provenance. Missing providers remain absent and cannot be filled with request JSON.
 * @typedef {{
 * setup?: (input: {child: import("../types/parallel.js").ParallelChild, reservation: import("../types/parallel.js").ParallelReservation}) => Promise<Capture>,
 * child?: (input: Parameters<NonNullable<Host["observeChild"]>>[0]) => Promise<Capture>,
 * recovery?: (input: Parameters<NonNullable<Host["observeRecovery"]>>[0]) => Promise<Capture>,
 * outcomes?: (input: Parameters<NonNullable<Host["observeOutcomes"]>>[0]) => Promise<Capture>,
 * reconcile?: (input: {receipt: import("../types/parallel.js").EffectReceipt, payload: import("../types/json.js").JsonValue}) => Promise<Capture>,
 * reviews?: (input: {plan: import("../types/plan.js").FoundryPlan, taskId: string}) => Promise<Capture>,
 * contributors?: (input: {plan: import("../types/plan.js").FoundryPlan, taskId: string}) => Promise<Capture>
 * }} ObservationReaders */

/** @param {string} code @param {string} message @returns {never} */
export function hold(code, message) {
	throw new DispatchNativeError(code, message, "not-started");
}

/** @param {unknown} a @param {unknown} b */
const same = (a, b) => stableStringify(a) === stableStringify(b);

/** The read must come from the current host invocation, never metadata name matching.
 * @param {() => Context | null} current */
export function bindNativeContext(current) {
	if (typeof current !== "function") hold("dispatch_identity_unavailable", "Current native invocation identity is unavailable");
	const initial = current();
	if (!initial) hold("dispatch_identity_unavailable", "Current native invocation identity is unavailable");
	const pinned = structuredClone(initial);
	/** @param {"not-started" | "uncertain"} [disposition] @param {unknown} [receipt] */
	function check(disposition = "not-started", receipt = null) {
		const actual = current();
		if (!actual || !same(actual, pinned) || actual.inWorkflow !== false || actual.agentId !== undefined
			|| !actual.workspacePath || !actual.sessionId || !actual.projectId || !actual.repositoryId) {
			throw new DispatchNativeError("dispatch_invocation_owner", "Current coordinator, workspace, project or repository changed, or invocation is a workflow/subagent", disposition, readJsonValue(receipt));
		}
		return structuredClone(pinned);
	}
	check();
	return check;
}

/** @param {Context} context @param {import("../types/plan.js").FoundryPlan} plan */
export function requireOwnedPlan(context, plan) {
	if (plan.factory?.owner !== context.workspacePath || plan.factory.repositoryId !== context.repositoryId) {
		hold("dispatch_foreign_plan", "Current native owner/repository does not own this plan");
	}
}

/** Bounded observation validators: no subscription, polling, archive, replay or release.
 * @param {{check: ReturnType<typeof bindNativeContext>, readPlan: (id: string) => import("../types/plan.js").FoundryPlan,
 * readers?: ObservationReaders, clock?: () => string}} options */
export function createNativeObservations({ check, readPlan, readers = {}, clock = () => new Date().toISOString() }) {
	const ports = { ...readers };
	/** @template T @param {((input: T) => Promise<Capture>) | undefined} read @param {T} input */
	async function capture(read, input) {
		if (!read) hold("dispatch_observation_unavailable", "A current operation-specific host observation API is unavailable");
		const context = check(), requested = structuredClone(input), digest = analysisInputDigest(requested), after = clock();
		const result = await read(requested);
		check();
		object(result, ["context", "subjectDigest", "capturedAt", "source", "complete", "value"], "native observation");
		if (!same(result.context, context) || result.subjectDigest !== digest || analysisInputDigest(requested) !== digest) {
			hold("dispatch_observation_mismatch", "Native observation does not bind this unchanged request and current owner");
		}
		const at = timestamp(result.capturedAt, "native capture time");
		text(result.source, "native observation source", 4096);
		if (result.complete !== true) hold("dispatch_observation_incomplete", "Incomplete native evidence cannot establish an empty successful inventory");
		if (at < after || at > clock()) hold("dispatch_observation_stale", "Native evidence must be freshly captured within this read");
		return structuredClone(result);
	}
	/** @param {import("../types/parallel.js").AdmissionIdentity} identity */
	function owned(identity) {
		const context = check(), parsed = admissionIdentity(identity);
		if (parsed.owner !== context.workspacePath || parsed.repositoryId !== context.repositoryId) hold("dispatch_foreign_plan", "Foreign observation identity");
	}
	/** @param {import("../types/parallel.js").AdmissionIdentity} identity */
	function attempt(identity) {
		const key = admissionIdentity({ repositoryId: identity.repositoryId, owner: identity.owner, planId: identity.planId,
			taskId: identity.taskId, reservationId: identity.reservationId });
		owned(key);
		const plan = readPlan(identity.planId);
		requireOwnedPlan(check(), plan);
		const actual = plan.tasks.find(task => task.id === identity.taskId)?.attempts.at(-1);
		if (plan.id !== identity.planId || !actual || actual.reservationId !== identity.reservationId) hold("dispatch_attempt_mismatch", "Current reservation is unavailable or changed");
		return { ...key, attemptId: actual.id };
	}
	/** @param {{plan: import("../types/plan.js").FoundryPlan, taskId: string}} input */
	function delivered(input) {
		requireOwnedPlan(check(), input.plan);
		if (!same(readPlan(input.plan.id), input.plan)) hold("dispatch_context_stale", "Review authority cannot come from caller-authored or stale plans");
		const attempt = input.plan.tasks.find(task => task.id === input.taskId)?.attempts.at(-1);
		if (attempt?.status !== "done" || !attempt.commit || !attempt.sessionId) hold("parallel_assurance_delivery", "Assurance requires an exact current delivered attempt");
		return { commit: commitId(attempt.commit), producer: attempt.sessionId };
	}
	/** @type {Pick<Host, "observeSetup" | "observeChild" | "reconcile" | "observeRecovery" | "observeOutcomes" | "readReviews" | "readContributors">} */
	const observations = {};
	if (ports.setup) observations.observeSetup = async (child, reservation) => {
		if (!same(attempt(reservation.attempt), reservation.attempt)) hold("dispatch_attempt_mismatch", "Setup belongs to another attempt");
		const result = await capture(ports.setup, { child, reservation });
		object(result.value, ["sessionId", "message", "at", "source"], "actual setup turn");
		const value = result.value;
		if (value.sessionId !== child.sessionId || value.message !== reservation.initialization.acknowledgement
			|| timestamp(value.at, "setup turn time") > result.capturedAt || !same(attempt(reservation.attempt), reservation.attempt)) {
			hold("dispatch_setup_unconfirmed", "Only the exact child setup turn, not idle notification, is acknowledgement");
		}
		return { sessionId: child.sessionId, message: reservation.initialization.acknowledgement,
			at: timestamp(value.at, "setup turn time"), source: text(value.source, "setup turn source", 4096) };
	};
	if (ports.child) observations.observeChild = async input => {
		const context = check(), result = await capture(ports.child, input);
		object(result.value, ["child", "aliases", "baseBranch", "baseCommit", "head", "clean", "coordinatingCreatorSessionId"], "native child observation");
		const value = result.value, child = createdChild(value.child);
		if (child.creatorSessionId !== context.sessionId || value.coordinatingCreatorSessionId !== context.sessionId
			|| child.projectId !== context.projectId || child.sessionId !== input.child.sessionId
			|| child.worktreePath !== input.child.worktreePath) hold("dispatch_child_mismatch", "Fresh canonical child/creator/project/worktree differs");
		const aliases = strings(value.aliases, "canonical aliases", 16, 1);
		if (aliases.length !== 1 || aliases[0] !== child.sessionId) hold("dispatch_inventory_ambiguous", "Alias equivalence is not established by this protocol");
		if (typeof value.clean !== "boolean") hold("dispatch_bootstrap_drift", "Actual clean-state observation is missing");
		return { child, aliases, capturedAt: result.capturedAt, source: result.source, complete: true,
			baseBranch: text(value.baseBranch, "reserved base branch", 512), baseCommit: commitId(value.baseCommit),
			head: commitId(value.head), clean: value.clean };
	};
	if (ports.recovery) observations.observeRecovery = async input => {
		const expected = attempt(input.identity);
		const result = await capture(ports.recovery, input), inventory = normalizeRecoveryInventory(result.value);
		if (!same(attempt(input.identity), expected)) hold("dispatch_attempt_mismatch", "Attempt changed during recovery capture");
		if (!inventory.complete || inventory.capturedAt < input.after || inventory.capturedAt !== result.capturedAt || inventory.source !== result.source) {
			hold("dispatch_observation_incomplete", "Recovery needs fresh complete sourced session AND run observations");
		}
		for (const entry of [...inventory.sessions, ...inventory.runs]) {
			if (!same(entry.attempt, expected)) hold("dispatch_observation_mismatch", "Recovery inventory contains a foreign attempt");
		}
		return inventory;
	};
	if (ports.outcomes) observations.observeOutcomes = async input => {
		const expected = attempt(input.identity);
		for (const receipt of input.receipts) {
			const { attemptId, ...identity } = effectReceipt(receipt).attempt;
			if (!same(identity, input.identity) || !same(receipt.attempt, expected)) hold("dispatch_observation_mismatch", "Requested effect belongs to another admission");
		}
		const result = await capture(ports.outcomes, input), values = list(result.value, "native outcomes", input.receipts.length).map(effectReceipt);
		if (!same(attempt(input.identity), expected)) hold("dispatch_attempt_mismatch", "Attempt changed during effect capture");
		if (new Set(values.map(value => value.id)).size !== values.length) hold("dispatch_observation_mismatch", "Duplicate native outcome");
		for (const value of values) {
			const original = input.receipts.find(receipt => receipt.id === value.id);
			if (!original || !same(value.attempt, original.attempt) || value.kind !== original.kind || value.epoch !== original.epoch
				|| value.payloadDigest !== original.payloadDigest || value.at < original.at || value.at > result.capturedAt
				|| original.sessionId !== null && value.sessionId !== original.sessionId || original.runId !== null && value.runId !== original.runId
				|| ["intent", "in-flight"].includes(value.state)) hold("dispatch_observation_mismatch", "Outcome cannot change immutable effect, attempt or native identity");
		}
		// Unobserved effects remain unresolved in the canonical journal.
		return values;
	};
	if (ports.reconcile) observations.reconcile = async (receipt, payload) => {
		if (!same(attempt(receipt.attempt), receipt.attempt)) hold("dispatch_attempt_mismatch", "Reconciliation belongs to another attempt");
		const result = await capture(ports.reconcile, { receipt, payload });
		if (!same(attempt(receipt.attempt), receipt.attempt)) hold("dispatch_attempt_mismatch", "Attempt changed during reconciliation");
		if (result.value === null) return null;
		object(result.value, ["receipt", "payload", "result"], "correlated native result");
		if (!same(result.value.receipt, receipt) || !same(result.value.payload, payload)) hold("dispatch_observation_mismatch", "Reconciliation must correlate the exact retained effect and complete payload");
		const native = result.value.result;
		object(native, ["value", "raw", "source"], "native result");
		return { value: native.value, raw: readJsonValue(native.raw), source: text(native.source, "native result source", 4096) };
	};
	if (ports.reviews) observations.readReviews = async input => {
		delivered(input);
		const result = await capture(ports.reviews, input);
		delivered(input);
		const reviews = list(result.value, "native review applicability", 4, 4).map(value => {
			object(value, ["kind", "required", "reason", "reviewers"], "review applicability");
			const kind = enumeration(value.kind, ["implementation", "architecture", "security", "visual"], "review kind");
			if (typeof value.required !== "boolean") hold("parallel_review_required", "Review applicability must be explicit");
			return { kind, required: value.required, reason: text(value.reason, "applicability reason", 2048),
				reviewers: strings(value.reviewers, "independent reviewers", 32, value.required ? 1 : 0) };
		});
		if (new Set(reviews.map(value => value.kind)).size !== 4) hold("parallel_review_required", "Every review modality must be retained");
		return reviews;
	};
	if (ports.contributors) observations.readContributors = async input => {
		const delivery = delivered(input), result = await capture(ports.contributors, input);
		delivered(input);
		object(result.value, ["commit", "authors"], "complete native contributors");
		const commit = commitId(result.value.commit), authors = strings(result.value.authors, "all contributing sessions and runtime agents", 128, 1);
		if (commit !== delivery.commit || !authors.includes(delivery.producer)) hold("parallel_contributors_mismatch", "Contributors must include the exact delivered producer and all runtime helpers");
		return { commit, authors, complete: true, source: result.source, capturedAt: result.capturedAt };
	};
	return Object.freeze(observations);
}

/** Delegate all input authority and writes to the canonical package materializer.
 * The trusted entry reader is the existing bridge's journal-bound consumer entry.
 * @param {{check: ReturnType<typeof bindNativeContext>, inputs: import("../types/parallel.js").InputPort,
 * entry: (descriptor: import("../types/parallel.js").ReservedInputs) => import("../types/parallel.js").ConsumerEntry | null}} options */
export function createNativeInputs({ check, inputs, entry }) {
	/** @param {import("../types/parallel.js").AttemptIdentity} attempt */
	function owned(attempt) {
		const context = check();
		if (attempt.owner !== context.workspacePath || attempt.repositoryId !== context.repositoryId) hold("dispatch_foreign_plan", "Foreign consumer");
	}
	return {
		/** @type {import("../types/parallel.js").InputPort["resolve"]} */
		resolve(attempt, bootstrap, required) {
			owned(attempt);
			const descriptor = inputs.resolve(attempt, bootstrap, required);
			check();
			return descriptor;
		},
		/** @type {import("../types/parallel.js").InputPort["materialize"]} */
		async materialize(descriptor, supplied) {
			owned(descriptor.consumer);
			const authorized = entry(descriptor);
			if (!authorized || !same(consumerEntry(authorized, descriptor), consumerEntry(supplied, descriptor))) {
				hold("parallel_consumer_held", "Successful exact attachment and unchanged handoff are required");
			}
			check();
			const artifacts = await inputs.materialize(descriptor, authorized);
			check("uncertain", artifacts);
			return artifacts;
		},
	};
}

/** @typedef {{plan: import("../types/plan.js").FoundryPlan, taskId: string, repository: string,
 * input: Omit<Parameters<typeof buildAssuranceSubject>[0], "authors" | "reviews">}} AssuranceContext */

/** Current canonical subject and native observations are constructor ports; the report
 * cannot supply reviewer authority. Existing Git/visual evaluators own assessment.
 * @param {{check: ReturnType<typeof bindNativeContext>, readSubject: () => AssuranceContext,
 * observations: Pick<Host, "readReviews" | "readContributors">}} options */
export function createNativeAssurance({ check, readSubject, observations }) {
	async function prepare() {
		const context = structuredClone(readSubject());
		requireOwnedPlan(check(), context.plan);
		if (!observations.readReviews || !observations.readContributors) hold("dispatch_observation_unavailable", "Current independent review and complete contributor providers are required");
		const request = { plan: context.plan, taskId: context.taskId };
		const [reviews, contributors] = await Promise.all([observations.readReviews(request), observations.readContributors(request)]);
		check();
		if (!same(readSubject(), context)) hold("dispatch_context_stale", "Canonical assurance subject changed during observation");
		const subject = buildAssuranceSubject({ ...context.input, authors: contributors.authors, reviews });
		const actual = context.plan.tasks.find(task => task.id === context.taskId)?.attempts.at(-1), identity = check();
		if (!actual || actual.status !== "done" || actual.commit !== subject.delivery.commit || actual.sessionId !== subject.producer
			|| context.repository !== context.plan.repository.workingDirectory
			|| !same(subject.delivery.attempt, { repositoryId: identity.repositoryId, owner: identity.workspacePath,
				planId: context.plan.id, taskId: context.taskId, attemptId: actual.id, reservationId: actual.reservationId })) {
			hold("parallel_assurance_delivery", "Assurance subject must retain the exact current delivered attempt, producer and repository");
		}
		if (contributors.complete !== true || contributors.commit !== subject.delivery.commit) hold("parallel_contributors_mismatch", "Complete contributors must bind this exact delivery");
		return { context, subject };
	}
	return {
		async prepare() { return (await prepare()).subject; },
		/** @param {unknown} report */
		async assess(report) {
			const { context, subject } = await prepare(), at = new Date().toISOString();
			const result = validatePackageAssurance(context.repository, subject, report, at);
			for (const entry of result.evaluations) {
				const definition = subject.definitions.find(item => item.id === entry.evaluation.id && item.revision === entry.evaluation.revision);
				if (!definition) hold("parallel_assurance_evaluator", "Pinned evaluator definition is missing");
				for (const state of visualReport(definition.evaluation, entry.report, subject.delivery.commit, entry.outcome) ?? []) {
					if (!state.capture) continue;
					const age = Date.parse(at) - Date.parse(state.capture.capturedAt);
					if (age < 0 || age > definition.evaluation.maxAgeSeconds * 1000) hold("parallel_assurance_stale", "Native capture is future-dated or older than the pinned evaluator permits");
				}
			}
			check();
			if (!same(readSubject(), context)) hold("dispatch_context_stale", "Canonical assurance subject changed during assessment");
			return result;
		},
	};
}
