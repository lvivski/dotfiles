import { isList, isOneOf } from "../data.mjs";
import { effectiveDeliveryRequirement } from "../plan/delivery.mjs";
import { FoundryDomainError } from "../plan/fields.mjs";
import { validateTaskTopology } from "../plan/graph.mjs";
import { latestSuccessfulAttempt } from "../plan/queries.mjs";
import { validateEvaluationTarget } from "../plan/schemas/factory.mjs";
import { validatePlan } from "../plan/validation.mjs";
import { DELIVERY_REQUIREMENT, EVIDENCE_OUTCOME, EVIDENCE_TYPE, LIMITS, PLAN_ID_PATTERN, TASK_STATUS } from "../plan/values.mjs";
import { validateFrozenFactoryContext } from "./context.mjs";
import { analysisInputDigest } from "../digest.mjs";
import { plainObject, text } from "./fields.mjs";
import { fail } from "../errors.mjs";

/** @typedef {import("../types/analysis.js").VerificationInput} VerificationInput */
/** @typedef {import("../types/analysis.js").VerificationFactory} VerificationFactory */

const PLAN_ID_REGEX = new RegExp(PLAN_ID_PATTERN);

/**
 * Derives a stable acceptance-criterion ID.
 *
 * @param {string} taskId
 * @param {number} index
 * @returns {string}
 */
export function criterionId(taskId, index) {
	return `${taskId}-C${String(index + 1).padStart(3, "0")}`;
}

/**
 * Builds canonical verification input from each task's latest successful attempt.
 *
 * @param {import("../types/plan.js").FoundryPlan} plan
 * @returns {VerificationInput}
 */
export function buildVerificationInput(plan) {
	validatePlan(plan);
	if (plan.tasks.some((task) => task.status !== TASK_STATUS.DONE)) {
		fail(
			"implementation_incomplete",
			"Verification input requires every implementation task to be done",
		);
	}
	/** @type {import("../types/plan.js").FoundryTask[]} */
	const tasks = plan.tasks;
	const { verifyTask, targetTask } = validateTaskTopology(tasks, plan.evaluationTarget ?? null);
	const verifier = latestSuccessfulAttempt(verifyTask);
	const target = targetTask ? latestSuccessfulAttempt(targetTask) : null;
	if (!verifier || (!target && !plan.evaluationTarget) || verifier.sessionId === null) {
		fail("implementation_incomplete", "Verification input requires a completed verifier report");
	}
	const reportTarget = plan.evaluationTarget ? {
		candidateId: plan.evaluationTarget.candidateId, taskId: null, attemptId: null,
		branch: null, commit: plan.evaluationTarget.commit, prUrl: null,
	} : (() => {
		if (!targetTask || !target) fail("implementation_incomplete", "Verifier target delivery is missing");
		return { taskId: targetTask.id, attemptId: target.id, branch: target.branch, commit: target.commit, prUrl: target.prUrl };
	})();
	const factoryInput = plan.factory ? {
		binding: structuredClone(plan.factory), evaluations: structuredClone(verifier.factoryEvaluations ?? []),
		...(plan.factoryVerification ? { context: structuredClone(plan.factoryVerification) } : {}),
	} : undefined;
	if (factoryInput) validateFrozenFactoryContext(factoryInput);
	/** @type {Omit<VerificationInput, "inputDigest">} */
	const normalized = {
		planId: plan.id,
		objective: plan.objective,
		...(plan.evaluationTarget ? { evaluationTarget: structuredClone(plan.evaluationTarget) } : {}),
		tasks: plan.tasks
			.filter((task) => task.kind === "implement")
			.sort((left, right) => left.id.localeCompare(right.id))
			.map((task) => {
				const attempt = latestSuccessfulAttempt(task);
				if (!attempt) {
					fail("implementation_incomplete", `Task ${task.id} has no successful attempt`);
				}
				return {
					id: task.id,
					attemptId: attempt.id,
					criteria: task.acceptanceCriteria.map((criterion, index) => ({
						id: criterionId(task.id, index),
						text: criterion,
					})),
					resultSummary: attempt.resultSummary,
					evidence: attempt.evidence.map((entry) => ({
						...entry,
						attemptId: attempt.id,
					})),
					delivery: {
						requirement: effectiveDeliveryRequirement(task),
						baseBranch: attempt.baseBranch,
						branch: attempt.branch,
						commit: attempt.commit,
						prUrl: attempt.prUrl,
						integrationRequired: attempt.integrationRequired,
					},
				};
			}),
		verificationReport: {
			taskId: verifyTask.id,
			attemptId: verifier.id,
			sessionId: verifier.sessionId,
			target: reportTarget,
			observedCommit: verifier.commit,
			resultSummary: verifier.resultSummary,
			evidence: verifier.evidence.map((entry) => ({
				...entry,
				attemptId: verifier.id,
			})),
		},
		...(factoryInput ? { factory: factoryInput } : {}),
	};
	return {
		...normalized,
		inputDigest: analysisInputDigest(normalized),
	};
}

/**
 * Validates and canonicalizes evidence-only verification input.
 *
 * @param {unknown} value
 * @returns {VerificationInput}
 */
export function normalizeVerificationInput(value) {
	const input = plainObject(value, "input");
	/** @type {VerificationFactory | undefined} */
	let factory;
	if (input.factory !== undefined) {
		const suppliedFactory = plainObject(input.factory, "factory");
		if (Object.keys(suppliedFactory).some((key) => !["binding", "evaluations", "context"].includes(key))) fail("invalid_analysis_input", "Unexpected factory verification field");
		try {
			validateFrozenFactoryContext(suppliedFactory);
			factory = suppliedFactory;
		} catch (error) {
			if (!(error instanceof FoundryDomainError)) throw error;
			fail("invalid_analysis_input", "Factory verification data failed domain validation", { code: error.code, path: error.path, message: error.message });
		}
	}
	const evaluationTarget = input.evaluationTarget;
	if (evaluationTarget !== undefined) {
		try { validateEvaluationTarget(evaluationTarget); }
		catch (error) {
			if (!(error instanceof FoundryDomainError)) throw error;
			fail("invalid_analysis_input", error.message, { code: error.code, path: error.path });
		}
		if (factory?.binding.purpose !== "evaluation" || factory.binding.candidateId !== evaluationTarget?.candidateId) fail("invalid_analysis_input", "Evaluation-only verification requires its exact factory binding");
	}
	if (factory?.binding.purpose === "evaluation" && evaluationTarget === undefined) fail("invalid_analysis_input", "Read-only verification must retain its external target");
	const planId = text(input.planId, "input.planId", LIMITS.planId);
	if (!PLAN_ID_REGEX.test(planId)) {
		fail("invalid_analysis_input", "input.planId must be a lowercase Foundry plan slug");
	}
	if (!isList(input.tasks)
		|| input.tasks.length < (evaluationTarget ? 0 : 1)
		|| (evaluationTarget && input.tasks.length !== 0)
		|| input.tasks.length > LIMITS.tasks) {
		fail(
			"invalid_analysis_input",
			`input.tasks must contain 1-${LIMITS.tasks} tasks`,
		);
	}
	/** @type {Omit<VerificationInput, "inputDigest" | "verificationReport"> & {verificationReport: VerificationInput["verificationReport"] | null}} */
	const normalized = {
		planId,
		...(factory ? { factory: structuredClone(factory) } : {}),
		...(evaluationTarget ? { evaluationTarget: structuredClone(evaluationTarget) } : {}),
		objective: text(input.objective, "input.objective", LIMITS.objective),
		verificationReport: null,
		tasks: input.tasks.map((rawTask, taskIndex) => {
			const task = plainObject(rawTask, `input.tasks[${taskIndex}]`);
			const id = text(task.id, `input.tasks[${taskIndex}].id`, 5);
			if (!/^T-\d{3}$/.test(id)) {
				fail(
					"invalid_analysis_input",
					`input.tasks[${taskIndex}].id must use T-001 format`,
				);
			}
			if (!isList(task.criteria)
				|| task.criteria.length < 1
				|| task.criteria.length > LIMITS.acceptanceCriteria) {
				fail(
					"invalid_analysis_input",
					`input.tasks[${taskIndex}].criteria must contain 1-${LIMITS.acceptanceCriteria} entries`,
				);
			}
			const criteria = task.criteria.map((rawCriterion, criterionIndex) => {
				const criterion = plainObject(
					rawCriterion,
					`input.tasks[${taskIndex}].criteria[${criterionIndex}]`,
				);
				const expectedId = criterionId(id, criterionIndex);
				if (criterion.id !== expectedId) {
					fail(
						"invalid_analysis_input",
						`criterion ${criterion.id} must be ${expectedId}`,
					);
				}
				return {
					id: expectedId,
					text: text(
						criterion.text,
						`input.tasks[${taskIndex}].criteria[${criterionIndex}].text`,
						LIMITS.acceptanceCriterion,
					),
				};
			});
			const attemptId = text(
				task.attemptId,
				`input.tasks[${taskIndex}].attemptId`,
				LIMITS.attemptId,
			);
			if (!new RegExp(`^${id}-A\\d{3}$`).test(attemptId)) {
				fail(
					"invalid_analysis_input",
					`input.tasks[${taskIndex}].attemptId must belong to ${id}`,
				);
			}
			if (!isList(task.evidence)
				|| task.evidence.length < 1
				|| task.evidence.length > LIMITS.evidence) {
				fail(
					"invalid_analysis_input",
					`input.tasks[${taskIndex}].evidence must contain 1-${LIMITS.evidence} entries`,
				);
			}
			const evidence = task.evidence.map(/** @returns {import("../types/plan.js").FoundryEvidence & {attemptId: string}} */(rawEvidence, evidenceIndex) => {
				const evidenceEntry = plainObject(
					rawEvidence,
					`input.tasks[${taskIndex}].evidence[${evidenceIndex}]`,
				);
				const expectedId = `${attemptId}-E${String(evidenceIndex + 1).padStart(3, "0")}`;
				if (evidenceEntry.id !== expectedId || evidenceEntry.attemptId !== attemptId) {
					fail("invalid_analysis_input", `Evidence ${evidenceIndex + 1} must belong to ${attemptId}`);
				}
				if (!isOneOf(evidenceEntry.type, Object.values(EVIDENCE_TYPE))) {
					fail("invalid_analysis_input", `Evidence ${expectedId} has an invalid type`);
				}
				if (!isOneOf(evidenceEntry.outcome, Object.values(EVIDENCE_OUTCOME))) {
					fail("invalid_analysis_input", `Evidence ${expectedId} has an invalid outcome`);
				}
				if (evidenceEntry.trust !== "claimed") {
					fail("invalid_analysis_input", `Evidence ${expectedId} must remain claimed`);
				}
				if (evidenceEntry.checkId !== null) {
					fail("invalid_analysis_input", `Evidence ${expectedId} cannot set checkId`);
				}
				return {
					id: expectedId,
					type: evidenceEntry.type,
					summary: text(
						evidenceEntry.summary,
						`input.tasks[${taskIndex}].evidence[${evidenceIndex}].summary`,
						LIMITS.evidenceItem,
					),
					source: evidenceEntry.source === null
						? null
						: text(
							evidenceEntry.source,
							`input.tasks[${taskIndex}].evidence[${evidenceIndex}].source`,
							LIMITS.evidenceSource,
						),
					outcome: evidenceEntry.outcome,
					producer: text(
						evidenceEntry.producer,
						`input.tasks[${taskIndex}].evidence[${evidenceIndex}].producer`,
						LIMITS.producer,
					),
					checkId: null,
					trust: "claimed",
					attemptId,
				};
			});
			const delivery = plainObject(
				task.delivery,
				`input.tasks[${taskIndex}].delivery`,
			);
			/**
			 * Validates a nullable bounded delivery field.
			 *
			 * @param {unknown} value
			 * @param {string} field
			 * @param {number} maximum
			 * @returns {string | null}
			 */
			const normalizeNullable = (value, field, maximum) => value === null
				? null
				: text(value, field, maximum);
			const requirement = delivery.requirement;
			if (!isOneOf(requirement, Object.values(DELIVERY_REQUIREMENT))) {
				fail(
					"invalid_analysis_input",
					`input.tasks[${taskIndex}].delivery.requirement is invalid`,
				);
			}
			if (!isList(delivery.integrationRequired)
				|| delivery.integrationRequired.length > LIMITS.dependencies) {
				fail(
					"invalid_analysis_input",
					`input.tasks[${taskIndex}].delivery.integrationRequired is invalid`,
				);
			}
			const integrationRequired = delivery.integrationRequired.map((rawEntry, entryIndex) => {
				const entry = plainObject(
					rawEntry,
					`input.tasks[${taskIndex}].delivery.integrationRequired[${entryIndex}]`,
				);
				const dependencyId = text(
					entry.taskId,
					`input.tasks[${taskIndex}].delivery.integrationRequired[${entryIndex}].taskId`,
					5,
				);
				const dependencyAttemptId = text(
					entry.attemptId,
					`input.tasks[${taskIndex}].delivery.integrationRequired[${entryIndex}].attemptId`,
					LIMITS.attemptId,
				);
				if (!/^T-\d{3}$/.test(dependencyId)
					|| !new RegExp(`^${dependencyId}-A\\d{3}$`).test(dependencyAttemptId)) {
					fail("invalid_analysis_input", "Integration delivery identity is invalid");
				}
				return {
					taskId: dependencyId,
					attemptId: dependencyAttemptId,
					branch: normalizeNullable(
						entry.branch,
						`input.tasks[${taskIndex}].delivery.integrationRequired[${entryIndex}].branch`,
						LIMITS.branch,
					),
					commit: normalizeNullable(
						entry.commit,
						`input.tasks[${taskIndex}].delivery.integrationRequired[${entryIndex}].commit`,
						LIMITS.commit,
					),
					prUrl: normalizeNullable(
						entry.prUrl,
						`input.tasks[${taskIndex}].delivery.integrationRequired[${entryIndex}].prUrl`,
						LIMITS.prUrl,
					),
				};
			});
			const branch = normalizeNullable(
				delivery.branch,
				`input.tasks[${taskIndex}].delivery.branch`,
				LIMITS.branch,
			);
			const commit = normalizeNullable(
				delivery.commit,
				`input.tasks[${taskIndex}].delivery.commit`,
				LIMITS.commit,
			);
			const prUrl = normalizeNullable(
				delivery.prUrl,
				`input.tasks[${taskIndex}].delivery.prUrl`,
				LIMITS.prUrl,
			);
			if (prUrl !== null) {
				let parsed;
				try {
					parsed = new URL(prUrl);
				} catch {
					fail(
						"invalid_analysis_input",
						`input.tasks[${taskIndex}].delivery.prUrl must be a valid URL`,
					);
				}
				if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
					fail(
						"invalid_analysis_input",
						`input.tasks[${taskIndex}].delivery.prUrl must use http or https`,
					);
				}
			}
			const fullCommit = typeof commit === "string"
				&& /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit);
			if (branch === null
				|| (requirement !== DELIVERY_REQUIREMENT.BRANCH && !fullCommit)
				|| (requirement === DELIVERY_REQUIREMENT.PR && prUrl === null)) {
				fail(
					"invalid_analysis_input",
					`input.tasks[${taskIndex}].delivery does not satisfy ${requirement}`,
				);
			}
			return {
				id,
				attemptId,
				criteria,
				resultSummary: text(
					task.resultSummary,
					`input.tasks[${taskIndex}].resultSummary`,
					LIMITS.resultSummary,
				),
				evidence,
				delivery: {
					requirement,
					baseBranch: text(
						delivery.baseBranch,
						`input.tasks[${taskIndex}].delivery.baseBranch`,
						LIMITS.baseBranch,
					),
					branch,
					commit,
					prUrl,
					integrationRequired,
				},
			};
		}),
	};
	const report = plainObject(input.verificationReport, "input.verificationReport");
	const reportTaskId = text(
		report.taskId,
		"input.verificationReport.taskId",
		5,
	);
	const reportAttemptId = text(
		report.attemptId,
		"input.verificationReport.attemptId",
		LIMITS.attemptId,
	);
	if (!/^T-\d{3}$/.test(reportTaskId)
		|| !new RegExp(`^${reportTaskId}-A\\d{3}$`).test(reportAttemptId)
		|| normalized.tasks.some((task) => task.id === reportTaskId)) {
		fail("invalid_analysis_input", "input.verificationReport identity is invalid");
	}
	const sessionId = text(
		report.sessionId,
		"input.verificationReport.sessionId",
		LIMITS.sessionId,
	);
	const target = plainObject(report.target, "input.verificationReport.target");
	const targetTaskId = evaluationTarget ? null : text(target.taskId, "input.verificationReport.target.taskId", 5);
	const targetAttemptId = evaluationTarget ? null : text(
		target.attemptId,
		"input.verificationReport.target.attemptId",
		LIMITS.attemptId,
	);
	const targetTask = normalized.tasks.find((task) => task.id === targetTaskId);
	if (evaluationTarget ? target.taskId !== null || target.attemptId !== null || target.branch !== null || target.prUrl !== null
		|| target.commit !== evaluationTarget.commit || target.candidateId !== evaluationTarget.candidateId
		: !targetTask
		|| targetAttemptId !== targetTask.attemptId
		|| target.branch !== targetTask.delivery.branch
		|| target.commit !== targetTask.delivery.commit
		|| target.prUrl !== targetTask.delivery.prUrl) {
		fail("invalid_analysis_input", "input.verificationReport target is invalid");
	}
	const observedCommit = text(
		report.observedCommit,
		"input.verificationReport.observedCommit",
		LIMITS.commit,
	);
	if (factory?.context?.humanEvidence.some((entry) => entry.commit !== target.commit)) fail("analysis_input_mismatch", "Human evidence belongs to another delivery");
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(observedCommit)) {
		fail("invalid_analysis_input", "input.verificationReport.observedCommit is invalid");
	}
	const expectedChecks = [
		...(evaluationTarget ? evaluationTarget.criteria.map((_entry, index) => criterionId(reportTaskId, index))
			: normalized.tasks.flatMap((task) => task.criteria.map((criterion) => criterion.id))),
		"final-integration",
		"workspace-integrity",
	];
	if (!isList(report.evidence)
		|| report.evidence.length !== expectedChecks.length) {
		fail("invalid_analysis_input", "input.verificationReport evidence is incomplete");
	}
	const evidence = report.evidence.map(/** @returns {import("../types/plan.js").FoundryEvidence & {attemptId: string}} */(rawEvidence, evidenceIndex) => {
		const entry = plainObject(
			rawEvidence,
			`input.verificationReport.evidence[${evidenceIndex}]`,
		);
		const expectedId = `${reportAttemptId}-E${String(evidenceIndex + 1).padStart(3, "0")}`;
		const expectedCheckId = expectedChecks[evidenceIndex];
		if (entry.id !== expectedId
			|| entry.attemptId !== reportAttemptId
			|| entry.checkId !== expectedCheckId
			|| entry.producer !== sessionId
			|| entry.trust !== "independent-claim"
			|| !isOneOf(entry.type, Object.values(EVIDENCE_TYPE))
			|| !isOneOf(entry.outcome, Object.values(EVIDENCE_OUTCOME))) {
			fail("invalid_analysis_input", `Verifier evidence ${expectedId} is invalid`);
		}
		return {
			id: expectedId,
			attemptId: reportAttemptId,
			type: entry.type,
			summary: text(
				entry.summary,
				`input.verificationReport.evidence[${evidenceIndex}].summary`,
				LIMITS.evidenceItem,
			),
			source: entry.source === null
				? null
				: text(
					entry.source,
					`input.verificationReport.evidence[${evidenceIndex}].source`,
					LIMITS.evidenceSource,
				),
			outcome: entry.outcome,
			producer: sessionId,
			checkId: expectedCheckId,
			trust: "independent-claim",
		};
	});
	normalized.verificationReport = {
		taskId: reportTaskId,
		attemptId: reportAttemptId,
		sessionId,
		target: {
			...(evaluationTarget ? { candidateId: evaluationTarget.candidateId } : {}),
			taskId: targetTaskId,
			attemptId: targetAttemptId,
			branch: targetTask?.delivery.branch ?? null,
			commit: evaluationTarget?.commit ?? targetTask?.delivery.commit ?? null,
			prUrl: targetTask?.delivery.prUrl ?? null,
		},
		observedCommit,
		resultSummary: text(
			report.resultSummary,
			"input.verificationReport.resultSummary",
			LIMITS.resultSummary,
		),
		evidence,
	};
	const expectedDigest = analysisInputDigest(normalized);
	if (input.inputDigest !== expectedDigest) {
		fail("analysis_input_mismatch", "Verification input digest is invalid");
	}
	return { ...normalized, verificationReport: normalized.verificationReport, inputDigest: expectedDigest };
}
