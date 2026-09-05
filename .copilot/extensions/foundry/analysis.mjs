/**
 * Canonical planning and verification inputs, digests, and result validation.
 *
 * @module foundry/analysis
 */
import { createHash } from "node:crypto";

import {
	DELIVERY_REQUIREMENT,
    EVIDENCE_OUTCOME,
    EVIDENCE_TYPE,
    LIMITS,
	PLAN_ID_PATTERN,
    TASK_STATUS,
	effectiveDeliveryRequirement,
    latestSuccessfulAttempt,
	validateDependencyGraph,
	validateTaskTopology,
    validatePlan,
} from "./domain.mjs";

const PLAN_ID_REGEX = new RegExp(PLAN_ID_PATTERN);

/**
 * @typedef {object} PlanningInput
 * @property {string} objective
 * @property {string[]} constraints
 * @property {string} repositoryContext
 * @property {number} maxTasks
 */

/** @typedef {PlanningInput & {inputDigest: string}} PlanningArgs */

/**
 * @typedef {object} PlanBlueprint
 * @property {string} title
 * @property {string} objective
 * @property {string[]} constraints
 * @property {any[]} tasks
 */

/**
 * @typedef {object} VerificationInput
 * @property {string} planId
 * @property {string} objective
 * @property {any[]} tasks
 * @property {any} verificationReport
 * @property {string} inputDigest
 */

/**
 * @typedef {object} VerificationOutcome
 * @property {boolean} passed
 * @property {string} summary
 * @property {string[]} evidence
 * @property {string[]} missingEvidence
 * @property {string[]} correctionTaskIds
 */

/** Typed failure raised when analysis input or output violates its contract. */
export class FoundryAnalysisError extends Error {
    /**
     * @param {string} code Stable machine-readable error code.
     * @param {string} message Human-readable failure summary.
     * @param {unknown} [details] Structured validation context.
     */
    constructor(code, message, details = null) {
        super(message);
        this.name = "FoundryAnalysisError";
        this.code = code;
        this.details = details;
    }
}

/**
 * Throws a typed analysis failure.
 *
 * @param {string} code
 * @param {string} message
 * @param {unknown} [details]
 * @returns {never}
 */
function fail(code, message, details) {
    throw new FoundryAnalysisError(code, message, details);
}

/**
 * Requires a plain JSON-like object.
 *
 * @param {unknown} value
 * @param {string} field
 * @returns {Record<string, any>}
 */
function plainObject(value, field) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail("invalid_analysis_input", `${field} must be an object`);
    }
    return value;
}

/**
 * Validates a bounded non-empty text field.
 *
 * @param {unknown} value
 * @param {string} field
 * @param {number} maximum
 * @returns {string}
 */
function text(value, field, maximum) {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
        fail(
            "invalid_analysis_input",
            `${field} must be a non-empty string of at most ${maximum} characters`,
        );
    }
    return value;
}

/**
 * Validates a bounded array of non-empty strings.
 *
 * @param {unknown} value
 * @param {string} field
 * @param {number} maximum
 * @param {number} itemMaximum
 * @param {number} [minimum]
 * @returns {string[]}
 */
function stringList(value, field, maximum, itemMaximum, minimum = 0) {
    if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
        fail(
            "invalid_analysis_input",
            `${field} must contain ${minimum}-${maximum} strings`,
        );
    }
    return value.map((item, index) => text(
        item,
        `${field}[${index}]`,
        itemMaximum,
    ));
}

/**
 * Recursively sorts object keys for deterministic JSON serialization.
 *
 * @param {unknown} value
 * @param {WeakSet<object>} [seen]
 * @returns {unknown}
 */
function sortKeysDeep(value, seen = new WeakSet()) {
    if (Array.isArray(value)) {
        return value.map((item) => sortKeysDeep(item, seen));
    }
    if (value && typeof value === "object") {
        if (seen.has(value)) {
            fail("invalid_analysis_input", "Cannot digest a circular value");
        }
        seen.add(value);
        /** @type {Record<string, any>} */
        const output = {};
        for (const key of Object.keys(value).sort()) {
            output[key] = sortKeysDeep(value[key], seen);
        }
        seen.delete(value);
        return output;
    }
    return value;
}

/**
 * Serializes JSON-like data with recursively sorted object keys.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
    return JSON.stringify(sortKeysDeep(value === undefined ? null : value));
}

/**
 * Computes the canonical SHA-256 digest for analysis input.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function analysisInputDigest(value) {
    return createHash("sha256")
        .update(stableStringify(value))
        .digest("hex");
}

/**
 * Validates and normalizes a planning request.
 *
 * @param {unknown} value
 * @returns {PlanningInput}
 */
export function normalizePlanningInput(value) {
    const input = plainObject(value, "input");
    const maxTasks = input.maxTasks ?? 6;
    if (!Number.isSafeInteger(maxTasks) || maxTasks < 1 || maxTasks > 12) {
        fail(
            "invalid_analysis_input",
            "input.maxTasks must be an integer from 1 through 12",
        );
    }
    return {
        objective: text(input.objective, "input.objective", LIMITS.objective),
        constraints: stringList(
            input.constraints ?? [],
            "input.constraints",
            LIMITS.constraints,
            LIMITS.constraint,
        ),
        repositoryContext: text(
            input.repositoryContext,
            "input.repositoryContext",
            16_000,
        ),
        maxTasks,
    };
}

/**
 * Adds the canonical digest to normalized planning arguments.
 *
 * @param {unknown} value
 * @returns {PlanningArgs}
 */
export function buildPlanningArgs(value) {
    const normalized = normalizePlanningInput(value);
    return {
        ...normalized,
        inputDigest: analysisInputDigest(normalized),
    };
}

/**
 * Validates a supplied planning digest against the shared canonical input.
 *
 * @param {unknown} value
 * @returns {PlanningArgs}
 */
export function validatePlanningArgs(value) {
	const input = plainObject(value, "args");
	const canonical = buildPlanningArgs(input);
	if (input.inputDigest !== canonical.inputDigest) {
		fail("analysis_input_mismatch", "Planning arguments do not match their canonical digest");
	}
	return canonical;
}

/**
 * Validates a generated plan blueprint through the authoritative domain model.
 *
 * @param {unknown} value
 * @param {number} maxTasks
 * @returns {PlanBlueprint}
 */
export function validatePlanBlueprint(value, maxTasks) {
	const blueprint = plainObject(value, "plan");
	if (!Array.isArray(blueprint.tasks)
		|| blueprint.tasks.length < 2
		|| blueprint.tasks.length > maxTasks + 1) {
		fail(
			"invalid_analysis_result",
			`plan.tasks must contain 1-${maxTasks} implementation tasks plus one verifier`,
		);
	}
	const ids = new Set();
	const tasks = blueprint.tasks.map((rawTask, index) => {
		const task = plainObject(rawTask, `plan.tasks[${index}]`);
		const id = text(task.id, `plan.tasks[${index}].id`, 5);
		if (!/^T-\d{3}$/.test(id) || ids.has(id)) {
			fail(
				"invalid_analysis_result",
				`plan.tasks[${index}].id must be a unique T-001 identifier`,
			);
		}
		ids.add(id);
		if (!["implement", "verify"].includes(task.kind)) {
			fail(
				"invalid_analysis_result",
				`plan.tasks[${index}].kind must be implement or verify`,
			);
		}
		if (!Object.values(DELIVERY_REQUIREMENT).includes(task.deliveryRequirement)) {
			fail(
				"invalid_analysis_result",
				`plan.tasks[${index}].deliveryRequirement must be branch, commit, or pr`,
			);
		}
		/** @type {"implement"|"verify"} */
		const kind = task.kind;
		/** @type {"branch"|"commit"|"pr"} */
		const deliveryRequirement = task.deliveryRequirement;
		return {
			id,
			title: text(task.title, `plan.tasks[${index}].title`, LIMITS.taskTitle),
			kind,
			description: text(
				task.description,
				`plan.tasks[${index}].description`,
				LIMITS.taskDescription,
			),
			dependsOn: stringList(
				task.dependsOn,
				`plan.tasks[${index}].dependsOn`,
				LIMITS.dependencies,
				5,
			),
			acceptanceCriteria: stringList(
				task.acceptanceCriteria,
				`plan.tasks[${index}].acceptanceCriteria`,
				LIMITS.acceptanceCriteria,
				LIMITS.acceptanceCriterion,
				kind === "verify" ? 0 : 1,
			),
			expectedFiles: stringList(
				task.expectedFiles,
				`plan.tasks[${index}].expectedFiles`,
				LIMITS.expectedFiles,
				LIMITS.expectedFile,
			),
			deliveryRequirement,
		};
	});
	try {
		validateDependencyGraph(tasks);
		const { verifyTask } = validateTaskTopology(tasks);
		if (verifyTask.deliveryRequirement !== DELIVERY_REQUIREMENT.COMMIT
			|| verifyTask.acceptanceCriteria.length !== 0
			|| verifyTask.expectedFiles.length !== 0) {
			fail(
				"invalid_analysis_result",
				"The verifier must use commit delivery with no authored criteria or files",
			);
		}
	} catch (error) {
		if (error instanceof FoundryAnalysisError) throw error;
		fail(
			"invalid_analysis_result",
			`Plan blueprint failed validation: ${error.message}`,
			{ causeCode: error.code ?? null },
		);
	}
	return {
		title: text(blueprint.title, "plan.title", LIMITS.planTitle),
		objective: text(blueprint.objective, "plan.objective", LIMITS.objective),
		constraints: stringList(
			blueprint.constraints,
			"plan.constraints",
			LIMITS.constraints,
			LIMITS.constraint,
		),
		tasks,
	};
}

/**
 * Validates the complete multi-critic planning workflow result.
 *
 * @param {unknown} value
 * @param {unknown} expectedInput
 * @param {number} maxTasks
 * @returns {PlanBlueprint}
 */
export function validatePlanningResult(value, expectedInput, maxTasks) {
    const normalizedInput = normalizePlanningInput(expectedInput);
    const expectedDigest = analysisInputDigest(normalizedInput);
    const result = plainObject(value, "result");
    if (result.kind !== "foundry-plan-result") {
        fail("invalid_analysis_result", "Planning result kind is not supported");
    }
    if (result.inputDigest !== expectedDigest) {
        fail("analysis_input_mismatch", "Planning result input digest does not match the persisted run");
    }
    if (result.status !== "ready") {
        fail("analysis_needs_review", "Foundry planning did not produce a ready plan", {
            issues: Array.isArray(result.issues) ? result.issues : [],
            missingPerspectives: Array.isArray(result.missingPerspectives)
                ? result.missingPerspectives
                : [],
        });
    }
    if ((Array.isArray(result.issues) && result.issues.length > 0)
        || (Array.isArray(result.missingPerspectives)
            && result.missingPerspectives.length > 0)
        || result.verification?.passed !== true) {
        fail("invalid_analysis_result", "Ready planning result contains unresolved review findings");
    }
    if (!Array.isArray(result.critiques)
        || result.critiques.length !== 2
        || result.critiques.some((critique) => (
            !critique
            || !["accept", "revise"].includes(critique.verdict)
            || !Array.isArray(critique.risks)
            || !Array.isArray(critique.requiredChanges)
        ))) {
        fail("invalid_analysis_result", "Ready planning result requires two complete critic perspectives");
    }
    const plan = validatePlanBlueprint(result.plan, maxTasks);
    if (plan.objective !== normalizedInput.objective
        || stableStringify(plan.constraints)
            !== stableStringify(normalizedInput.constraints)) {
        fail(
            "analysis_input_mismatch",
            "Planning result changed the canonical objective or constraints",
        );
    }
    return plan;
}

/**
 * Derives a stable acceptance-criterion ID.
 *
 * @param {string} taskId
 * @param {number} index
 * @returns {string}
 */
function criterionId(taskId, index) {
    return `${taskId}-C${String(index + 1).padStart(3, "0")}`;
}

/**
 * Builds canonical verification input from each task's latest successful attempt.
 *
 * @param {any} plan
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
	/** @type {import("./domain.mjs").FoundryTask[]} */
	const tasks = plan.tasks;
	const { verifyTask, targetTask } = validateTaskTopology(tasks);
	const verifier = latestSuccessfulAttempt(verifyTask);
	const target = latestSuccessfulAttempt(targetTask);
	if (!verifier || !target || verifier.sessionId === null) {
		fail("implementation_incomplete", "Verification input requires a completed verifier report");
	}
	/** @type {Omit<VerificationInput, "inputDigest">} */
    const normalized = {
        planId: plan.id,
        objective: plan.objective,
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
			target: {
				taskId: targetTask.id,
				attemptId: target.id,
				branch: target.branch,
				commit: target.commit,
				prUrl: target.prUrl,
			},
			observedCommit: verifier.commit,
			resultSummary: verifier.resultSummary,
			evidence: verifier.evidence.map((entry) => ({
				...entry,
				attemptId: verifier.id,
			})),
		},
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
    const planId = text(input.planId, "input.planId", LIMITS.planId);
    if (!PLAN_ID_REGEX.test(planId)) {
        fail("invalid_analysis_input", "input.planId must be a lowercase Foundry plan slug");
    }
    if (!Array.isArray(input.tasks)
        || input.tasks.length < 1
        || input.tasks.length > LIMITS.tasks) {
        fail(
            "invalid_analysis_input",
            `input.tasks must contain 1-${LIMITS.tasks} tasks`,
        );
    }
	/** @type {Omit<VerificationInput, "inputDigest">} */
    const normalized = {
        planId,
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
            if (!Array.isArray(task.criteria)
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
            if (!Array.isArray(task.evidence)
                || task.evidence.length < 1
                || task.evidence.length > LIMITS.evidence) {
                fail(
                    "invalid_analysis_input",
                    `input.tasks[${taskIndex}].evidence must contain 1-${LIMITS.evidence} entries`,
                );
            }
            const evidence = task.evidence.map((rawEvidence, evidenceIndex) => {
                const evidenceEntry = plainObject(
                    rawEvidence,
                    `input.tasks[${taskIndex}].evidence[${evidenceIndex}]`,
                );
                const expectedId = `${attemptId}-E${String(evidenceIndex + 1).padStart(3, "0")}`;
                if (evidenceEntry.id !== expectedId || evidenceEntry.attemptId !== attemptId) {
                    fail("invalid_analysis_input", `Evidence ${evidenceIndex + 1} must belong to ${attemptId}`);
                }
                if (!Object.values(EVIDENCE_TYPE).includes(evidenceEntry.type)) {
                    fail("invalid_analysis_input", `Evidence ${expectedId} has an invalid type`);
                }
                if (!Object.values(EVIDENCE_OUTCOME).includes(evidenceEntry.outcome)) {
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
			if (!Object.values(DELIVERY_REQUIREMENT).includes(requirement)) {
				fail(
					"invalid_analysis_input",
					`input.tasks[${taskIndex}].delivery.requirement is invalid`,
				);
			}
            if (!Array.isArray(delivery.integrationRequired)
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
	const targetTaskId = text(target.taskId, "input.verificationReport.target.taskId", 5);
	const targetAttemptId = text(
		target.attemptId,
		"input.verificationReport.target.attemptId",
		LIMITS.attemptId,
	);
	const targetTask = normalized.tasks.find((task) => task.id === targetTaskId);
	if (!targetTask
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
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(observedCommit)) {
		fail("invalid_analysis_input", "input.verificationReport.observedCommit is invalid");
	}
	const expectedChecks = [
		...normalized.tasks.flatMap((task) => task.criteria.map((criterion) => criterion.id)),
		"final-integration",
		"workspace-integrity",
	];
	if (!Array.isArray(report.evidence)
		|| report.evidence.length !== expectedChecks.length) {
		fail("invalid_analysis_input", "input.verificationReport evidence is incomplete");
	}
	const evidence = report.evidence.map((rawEvidence, evidenceIndex) => {
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
			|| !Object.values(EVIDENCE_TYPE).includes(entry.type)
			|| !Object.values(EVIDENCE_OUTCOME).includes(entry.outcome)) {
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
			taskId: targetTaskId,
			attemptId: targetAttemptId,
			branch: target.branch,
			commit: target.commit,
			prUrl: target.prUrl,
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
    return { ...normalized, inputDigest: expectedDigest };
}

/**
 * Computes the deterministic verification gaps shared by the Factory and importer.
 *
 * @param {any} input Canonical normalized verification input.
 * @returns {{
 *   hardPassed: boolean,
 *   hardGaps: Array<{summary: string, taskIds: string[]}>,
 *   correctionTaskIds: string[],
 *   requiredEvidenceIds: string[]
 * }}
 */
export function assessDeterministicVerification(input) {
	const criterionOwners = new Map(input.tasks.flatMap(
		(task) => task.criteria.map((criterion) => [criterion.id, task.id]),
	));
	const reportByCheck = new Map(
		input.verificationReport.evidence.map((entry) => [entry.checkId, entry]),
	);
	const correctionTaskIds = new Set();
	const hardGaps = [];
	for (const [criterionId, ownerTaskId] of criterionOwners) {
		if (reportByCheck.get(criterionId)?.outcome !== EVIDENCE_OUTCOME.PASSED) {
			correctionTaskIds.add(ownerTaskId);
			hardGaps.push({
				summary: `Independent check failed for ${criterionId}`,
				taskIds: [ownerTaskId],
			});
		}
	}
	const targetTaskId = input.verificationReport.target.taskId;
	if (input.verificationReport.observedCommit
		!== input.verificationReport.target.commit) {
		correctionTaskIds.add(targetTaskId);
		hardGaps.push({
			summary: "Verifier observed a different target commit",
			taskIds: [targetTaskId],
		});
	}
	for (const checkId of ["final-integration", "workspace-integrity"]) {
		if (reportByCheck.get(checkId)?.outcome !== EVIDENCE_OUTCOME.PASSED) {
			correctionTaskIds.add(targetTaskId);
			hardGaps.push({
				summary: `Independent check failed for ${checkId}`,
				taskIds: [targetTaskId],
			});
		}
	}
	return {
		hardPassed: hardGaps.length === 0,
		hardGaps,
		correctionTaskIds: [...correctionTaskIds],
		requiredEvidenceIds: input.verificationReport.evidence
			.filter((entry) => entry.outcome === EVIDENCE_OUTCOME.PASSED)
			.map((entry) => entry.id),
	};
}

/**
 * Validates a persisted verification result against canonical checks.
 *
 * @param {unknown} value
 * @param {unknown} expectedInput
 * @param {string} expectedReservationId
 * @returns {VerificationOutcome}
 */
export function validateVerificationResult(value, expectedInput, expectedReservationId) {
	const input = normalizeVerificationInput(expectedInput);
	const result = plainObject(value, "result");
	if (result.kind !== "foundry-verification-result") {
		fail("invalid_analysis_result", "Verification result kind is not supported");
	}
	if (result.inputDigest !== input.inputDigest
		|| result.planId !== input.planId
		|| result.reservationId !== expectedReservationId) {
		fail("analysis_input_mismatch", "Verification result does not match its run");
	}
	const returnedInput = normalizeVerificationInput(result.input);
	if (stableStringify(returnedInput) !== stableStringify(input)) {
		fail("analysis_input_mismatch", "Verification result changed the canonical Factory input");
	}
	const evaluated = evaluateVerification(input, result);
	const missingReviewer = result.reviews.findIndex((review) => review === null);
	if (missingReviewer !== -1) {
		fail("invalid_analysis_result", `Verification reviewer ${missingReviewer + 1} is invalid`);
	}
	if (evaluated.invalidEvidence) {
		fail("invalid_analysis_result", "Verification result references unknown evidence");
	}
	if (result.passed === true && evaluated.missingRequiredEvidence) {
		fail("invalid_analysis_result", "Passing verification omits verifier evidence");
	}
	if (result.passed === true && !evaluated.outcome.passed) {
		fail("invalid_analysis_result", "Passing verification contradicts canonical checks");
	}
	return evaluated.outcome;
}

/**
 * Evaluates review and verdict claims without trusting a proposed passing flag.
 * The Factory selects valid proposed evidence; import rejects invalid persisted
 * references, missing reviewers, and contradicted passes instead of repairing them.
 *
 * @param {VerificationInput} input Canonical normalized input.
 * @param {unknown} value Review results and proposed verdict fields.
 * @returns {{
 *   outcome: VerificationOutcome,
 *   gaps: Array<{summary: string, taskIds: string[]}>,
 *   missingRequiredEvidence: boolean,
 *   invalidEvidence: boolean
 * }}
 */
export function evaluateVerification(input, value) {
	const result = plainObject(value, "result");
	const taskIds = input.tasks.map((task) => task.id);
	const taskIdSet = new Set(taskIds);
	const deterministic = assessDeterministicVerification(input);
	const correctionTaskIds = new Set(deterministic.correctionTaskIds);
	/** @type {Map<string, Set<string>>} */
	const gapsBySummary = new Map();

	const allEvidence = new Map([
		...input.tasks.flatMap(
			(task) => task.evidence.map((entry) => [entry.id, entry]),
		),
		...input.verificationReport.evidence.map((entry) => [entry.id, entry]),
	]);
	let unattributed = false;
	/** Merge repeated findings without losing attribution from either source. */
	const consumeAttribution = (entry, field) => {
		if (!entry || typeof entry.summary !== "string" || !entry.summary.trim()) {
			fail("invalid_analysis_result", `${field} is invalid`);
		}
		let owners = gapsBySummary.get(entry.summary);
		if (!owners) {
			owners = new Set();
			gapsBySummary.set(entry.summary, owners);
		}
		if (!Array.isArray(entry.taskIds)
			|| entry.taskIds.length === 0
			|| entry.taskIds.some((id) => !taskIdSet.has(id))) {
			unattributed = true;
		} else {
			for (const id of entry.taskIds) {
				correctionTaskIds.add(id);
				owners.add(id);
			}
		}
	};
	deterministic.hardGaps.forEach((entry) => consumeAttribution(entry, "deterministic gap"));
	if (!Array.isArray(result.reviews) || result.reviews.length !== 2) {
		fail("invalid_analysis_result", "Verification result requires two reviewers");
	}
	result.reviews.forEach((review, reviewIndex) => {
		if (review === null) {
			consumeAttribution({
				summary: reviewIndex === 0
					? "Coverage reviewer returned no result"
					: "Integration skeptic returned no result",
				taskIds: [],
			}, `result.reviews[${reviewIndex}]`);
			return;
		}
		if (!review
			|| !Array.isArray(review.coverage)
			|| !Array.isArray(review.missingEvidence)
			|| !Array.isArray(review.integrationFindings)) {
			fail("invalid_analysis_result", `Verification reviewer ${reviewIndex + 1} is invalid`);
		}
		review.missingEvidence.forEach((entry, index) => (
			consumeAttribution(
				entry,
				`result.reviews[${reviewIndex}].missingEvidence[${index}]`,
			)
		));
		review.integrationFindings.forEach((entry, index) => {
			if (!Array.isArray(entry?.evidenceIds)
				|| entry.evidenceIds.some((id) => !allEvidence.has(id))) {
				unattributed = true;
			}
			consumeAttribution(
				entry,
				`result.reviews[${reviewIndex}].integrationFindings[${index}]`,
			);
		});
	});
	if (!Array.isArray(result.missingEvidence)
		|| result.missingEvidence.length > LIMITS.missingEvidence) {
		fail("invalid_analysis_result", "Verification result missingEvidence is invalid");
	}
	result.missingEvidence.forEach((entry, index) => (
		consumeAttribution(entry, `result.missingEvidence[${index}]`)
	));
	if (!Array.isArray(result.correctionTaskIds)) {
		fail("invalid_analysis_result", "Verification result correctionTaskIds is invalid");
	}
	for (const taskId of result.correctionTaskIds) {
		if (taskIdSet.has(taskId)) correctionTaskIds.add(taskId);
		else unattributed = true;
	}

	if (!Array.isArray(result.evidenceIds)) {
		fail("invalid_analysis_result", "Verification result references unknown evidence");
	}
	const passingIds = result.evidenceIds.filter(
		(id) => allEvidence.get(id)?.outcome === EVIDENCE_OUTCOME.PASSED,
	);
	const invalidEvidence = result.evidenceIds.length > LIMITS.verificationEvidence
		|| passingIds.length !== result.evidenceIds.length;
	const evidence = [...new Set(passingIds.slice(0, LIMITS.verificationEvidence))];
	const missingRequiredEvidence =
		deterministic.requiredEvidenceIds.some((id) => !evidence.includes(id));
	const passed = result.passed === true
		&& deterministic.hardPassed
		&& !missingRequiredEvidence
		&& gapsBySummary.size === 0
		&& evidence.length > 0;
	if (!passed && (unattributed || correctionTaskIds.size === 0)) {
		taskIds.forEach((taskId) => correctionTaskIds.add(taskId));
	}
	if (!passed && gapsBySummary.size === 0) {
		gapsBySummary.set(
			"Verification failed without an attributed evidence gap",
			new Set(correctionTaskIds),
		);
	}
	const gaps = [...gapsBySummary]
		.slice(0, LIMITS.missingEvidence)
		.map(([summary, owners]) => ({ summary, taskIds: [...owners].sort() }));
	return {
		outcome: {
			passed,
			summary: text(result.summary, "result.summary", LIMITS.resultSummary),
			evidence,
			missingEvidence: gaps.map((entry) => entry.summary),
			correctionTaskIds: passed ? [] : [...correctionTaskIds].sort(),
		},
		gaps,
		missingRequiredEvidence,
		invalidEvidence,
	};
}
