/**
 * Canonical planning and verification inputs, digests, and result validation.
 *
 * @module mobius/analysis
 */
import path from "node:path";
import { createHash } from "node:crypto";

import {
    EVIDENCE_OUTCOME,
    EVIDENCE_TYPE,
    LIMITS,
    TASK_STATUS,
    createDraftPlan,
    latestSuccessfulAttempt,
    validatePlan,
} from "./domain.mjs";

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
export class MobiusAnalysisError extends Error {
    /**
     * @param {string} code Stable machine-readable error code.
     * @param {string} message Human-readable failure summary.
     * @param {unknown} [details] Structured validation context.
     */
    constructor(code, message, details = null) {
        super(message);
        this.name = "MobiusAnalysisError";
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
    throw new MobiusAnalysisError(code, message, details);
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
 * Validates a generated plan blueprint through the authoritative domain model.
 *
 * @param {unknown} value
 * @param {number} maxTasks
 * @returns {PlanBlueprint}
 */
export function validatePlanBlueprint(value, maxTasks) {
    const blueprint = plainObject(value, "plan");
    if (!Array.isArray(blueprint.tasks)
        || blueprint.tasks.length < 1
        || blueprint.tasks.length > maxTasks) {
        fail(
            "invalid_analysis_result",
            `plan.tasks must contain 1-${maxTasks} tasks`,
        );
    }
    let draft;
    try {
        draft = createDraftPlan({
            id: "analysis-plan",
            title: blueprint.title,
            objective: blueprint.objective,
            constraints: blueprint.constraints,
            repository: {
                workingDirectory: path.resolve(process.cwd()),
                baseBranch: "main",
            },
            tasks: blueprint.tasks,
        }, { now: "2026-01-01T00:00:00.000Z" });
    } catch (error) {
        fail(
            "invalid_analysis_result",
            `Plan blueprint failed validation: ${error.message}`,
            { causeCode: error.code ?? null },
        );
    }
    return {
        title: draft.title,
        objective: draft.objective,
        constraints: draft.constraints,
        tasks: draft.tasks.map((task) => ({
            id: task.id,
            title: task.title,
            kind: task.kind,
            description: task.description,
            dependsOn: task.dependsOn,
            acceptanceCriteria: task.acceptanceCriteria,
            expectedFiles: task.expectedFiles,
        })),
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
    if (result.kind !== "mobius-plan-result") {
        fail("invalid_analysis_result", "Planning result kind is not supported");
    }
    if (result.inputDigest !== expectedDigest) {
        fail("analysis_input_mismatch", "Planning result input digest does not match the persisted run");
    }
    if (result.status !== "ready") {
        fail("analysis_needs_review", "Mobius planning did not produce a ready plan", {
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
    const normalized = {
        planId: plan.id,
        objective: plan.objective,
        tasks: plan.tasks.map((task) => {
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
                    baseBranch: attempt.baseBranch,
                    branch: attempt.branch,
                    commit: attempt.commit,
                    prUrl: attempt.prUrl,
                    integrationRequired: attempt.integrationRequired,
                },
            };
        }),
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
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(planId)) {
        fail("invalid_analysis_input", "input.planId must be a lowercase Mobius plan slug");
    }
    if (!Array.isArray(input.tasks)
        || input.tasks.length < 1
        || input.tasks.length > LIMITS.tasks) {
        fail(
            "invalid_analysis_input",
            `input.tasks must contain 1-${LIMITS.tasks} tasks`,
        );
    }
    const normalized = {
        planId,
        objective: text(input.objective, "input.objective", LIMITS.objective),
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
                    baseBranch: text(
                        delivery.baseBranch,
                        `input.tasks[${taskIndex}].delivery.baseBranch`,
                        LIMITS.baseBranch,
                    ),
                    branch: normalizeNullable(
                        delivery.branch,
                        `input.tasks[${taskIndex}].delivery.branch`,
                        LIMITS.branch,
                    ),
                    commit: normalizeNullable(
                        delivery.commit,
                        `input.tasks[${taskIndex}].delivery.commit`,
                        LIMITS.commit,
                    ),
                    prUrl: normalizeNullable(
                        delivery.prUrl,
                        `input.tasks[${taskIndex}].delivery.prUrl`,
                        LIMITS.prUrl,
                    ),
                    integrationRequired,
                },
            };
        }),
    };
    const expectedDigest = analysisInputDigest(normalized);
    if (input.inputDigest !== expectedDigest) {
        fail("analysis_input_mismatch", "Verification input digest is invalid");
    }
    return { ...normalized, inputDigest: expectedDigest };
}

/**
 * Validates a persisted verification result against canonical criterion and
 * evidence identities.
 *
 * @param {unknown} value
 * @param {unknown} expectedInput
 * @param {string} expectedReservationId
 * @returns {VerificationOutcome}
 */
export function validateVerificationResult(value, expectedInput, expectedReservationId) {
    const input = normalizeVerificationInput(expectedInput);
    const result = plainObject(value, "result");
    if (result.kind !== "mobius-verification-result") {
        fail("invalid_analysis_result", "Verification result kind is not supported");
    }
    if (result.inputDigest !== input.inputDigest || result.planId !== input.planId) {
        fail("analysis_input_mismatch", "Verification result does not match the persisted input");
    }
    if (result.reservationId !== expectedReservationId) {
		fail("analysis_input_mismatch", "Verification result does not match the launch reservation");
    }
    const returnedInput = normalizeVerificationInput(result.input);
    if (stableStringify(returnedInput) !== stableStringify(input)) {
		fail("analysis_input_mismatch", "Verification result changed the canonical Factory input");
    }
    const taskIds = input.tasks.map((task) => task.id);
    const taskIdSet = new Set(taskIds);
    const criterionOwners = new Map(input.tasks.flatMap(
        (task) => task.criteria.map((criterion) => [criterion.id, task.id]),
    ));
    const expectedCriterionIds = new Set(criterionOwners.keys());
    const evidenceById = new Map(input.tasks.flatMap(
        (task) => task.evidence.map((entry) => [entry.id, {
            ...entry,
            taskId: task.id,
        }]),
    ));
    const evidenceIds = new Set(evidenceById.keys());
    const covered = new Set();
    const coverageEvidenceIds = new Set();
    const correctionTaskIds = new Set();
    /** @type {string[]} */
    const missingSummaries = [];
    let unattributed = false;
    /**
     * Collects task attribution and missing-evidence prose from one finding.
     *
     * @param {any} entry
     * @param {string} field
     * @returns {void}
     */
    const consumeAttribution = (entry, field) => {
        if (!entry || typeof entry.summary !== "string" || !entry.summary.trim()) {
            fail("invalid_analysis_result", `${field} is invalid`);
        }
        const ids = Array.isArray(entry.taskIds)
            ? entry.taskIds.filter((id) => taskIdSet.has(id))
            : [];
        if (!Array.isArray(entry.taskIds)
            || ids.length !== entry.taskIds.length
            || ids.length === 0) {
            unattributed = true;
        }
        ids.forEach((id) => correctionTaskIds.add(id));
        missingSummaries.push(entry.summary);
    };
    if (!Array.isArray(result.reviews) || result.reviews.length !== 2) {
        fail("invalid_analysis_result", "Verification result requires two reviewers");
    }
    for (let reviewIndex = 0; reviewIndex < result.reviews.length; reviewIndex += 1) {
        const review = result.reviews[reviewIndex];
        if (!review
            || !Array.isArray(review.coverage)
            || !Array.isArray(review.missingEvidence)
            || !Array.isArray(review.integrationFindings)) {
            fail("invalid_analysis_result", "Verification reviewer is missing");
        }
        for (const mapping of review.coverage) {
            const ownerTaskId = criterionOwners.get(mapping?.criterionId);
            if (expectedCriterionIds.has(mapping?.criterionId)
                && Array.isArray(mapping.evidenceIds)
                && mapping.evidenceIds.length > 0
                && mapping.evidenceIds.every((id) => {
                    const evidence = evidenceById.get(id);
                    return evidence?.taskId === ownerTaskId
                        && evidence.outcome === EVIDENCE_OUTCOME.PASSED;
                })) {
                covered.add(mapping.criterionId);
                mapping.evidenceIds.forEach((id) => coverageEvidenceIds.add(id));
            }
        }
        review.missingEvidence.forEach((entry, gapIndex) => {
            consumeAttribution(
                entry,
                `result.reviews[${reviewIndex}].missingEvidence[${gapIndex}]`,
            );
        });
        review.integrationFindings.forEach((entry, findingIndex) => {
            if (!entry
                || !Array.isArray(entry.evidenceIds)
                || entry.evidenceIds.some((id) => !evidenceIds.has(id))) {
                unattributed = true;
            }
            consumeAttribution(
                entry,
                `result.reviews[${reviewIndex}].integrationFindings[${findingIndex}]`,
            );
        });
    }
    const uncovered = [...expectedCriterionIds].filter((id) => !covered.has(id));
    uncovered.forEach((id) => correctionTaskIds.add(criterionOwners.get(id)));
    if (!Array.isArray(result.missingEvidence)
        || result.missingEvidence.length > LIMITS.missingEvidence) {
        fail("invalid_analysis_result", "Verification result missingEvidence is invalid");
    }
    result.missingEvidence.forEach((entry, index) => {
        consumeAttribution(entry, `result.missingEvidence[${index}]`);
    });
    if (!Array.isArray(result.correctionTaskIds)) {
        fail("invalid_analysis_result", "Verification result correctionTaskIds is invalid");
    }
    for (const id of result.correctionTaskIds) {
        if (taskIdSet.has(id)) correctionTaskIds.add(id);
        else unattributed = true;
    }
    if (!Array.isArray(result.evidenceIds)
        || result.evidenceIds.length > LIMITS.evidence
        || result.evidenceIds.some((id) => evidenceById.get(id)?.outcome
            !== EVIDENCE_OUTCOME.PASSED)) {
        fail("invalid_analysis_result", "Verification result references unknown evidence");
    }
    const evidence = [...new Set(result.evidenceIds)];
    if ([...coverageEvidenceIds].some((id) => !evidence.includes(id))) {
        fail("invalid_analysis_result", "Verification result omits evidence used for criterion coverage");
    }
    const missingEvidence = [...new Set([
        ...uncovered.map((id) => `No evidence mapped for ${id}`),
        ...missingSummaries,
    ])].slice(0, LIMITS.missingEvidence);
    const passed = result.passed === true
        && uncovered.length === 0
        && missingEvidence.length === 0
        && evidence.length > 0;
    if (result.passed === true && !passed) {
        fail("invalid_analysis_result", "Passing verification result lacks complete criterion coverage");
    }
    if (!passed && missingEvidence.length === 0) {
        unattributed = true;
    }
    if (!passed && (unattributed || correctionTaskIds.size === 0)) {
        taskIds.forEach((id) => correctionTaskIds.add(id));
    }
    if (!passed && missingEvidence.length === 0) {
        missingEvidence.push("Verification failed without an attributed evidence gap");
    }
    return {
        passed,
        summary: text(result.summary, "result.summary", LIMITS.resultSummary),
        evidence,
        missingEvidence,
        correctionTaskIds: passed ? [] : [...correctionTaskIds].sort(),
    };
}
