import path from "node:path";
import { createHash } from "node:crypto";

import {
    LIMITS,
    TASK_STATUS,
    assertCanonicalValue,
    createDraftPlan,
    validatePlan,
} from "./domain.mjs";

export class MobiusAnalysisError extends Error {
    constructor(code, message, details = null) {
        super(message);
        this.name = "MobiusAnalysisError";
        this.code = code;
        this.details = details;
    }
}

function fail(code, message, details) {
    throw new MobiusAnalysisError(code, message, details);
}

function plainObject(value, field) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail("invalid_analysis_input", `${field} must be an object`);
    }
    return value;
}

function text(value, field, maximum) {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
        fail(
            "invalid_analysis_input",
            `${field} must be a non-empty string of at most ${maximum} characters`,
        );
    }
    return value;
}

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

function sortKeysDeep(value, seen = new WeakSet()) {
    if (Array.isArray(value)) {
        return value.map((item) => sortKeysDeep(item, seen));
    }
    if (value && typeof value === "object") {
        if (seen.has(value)) {
            fail("invalid_analysis_input", "Cannot digest a circular value");
        }
        seen.add(value);
        const output = {};
        for (const key of Object.keys(value).sort()) {
            output[key] = sortKeysDeep(value[key], seen);
        }
        seen.delete(value);
        return output;
    }
    return value;
}

export function stableStringify(value) {
    return JSON.stringify(sortKeysDeep(value === undefined ? null : value));
}

export function validateCanonicalEvidenceValue(value, fieldPath = "evidence") {
    try {
        assertCanonicalValue(value, fieldPath);
    } catch (error) {
        if (error?.code === "invalid_evidence") {
            fail("invalid_evidence", error.message, {
                path: error.path ?? fieldPath,
                reason: error.details?.reason ?? null,
            });
        }
        throw error;
    }
    return value;
}

export function canonicalEvidenceStringify(value) {
    validateCanonicalEvidenceValue(value);
    return stableStringify(value);
}

export function canonicalEvidenceDigest(value) {
    return createHash("sha256")
        .update(canonicalEvidenceStringify(value), "utf8")
        .digest("hex");
}

export function analysisInputDigest(value) {
    return createHash("sha256")
        .update(stableStringify(value))
        .digest("hex");
}

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

export function buildPlanningArgs(value) {
    const normalized = normalizePlanningInput(value);
    return {
        ...normalized,
        inputDigest: analysisInputDigest(normalized),
    };
}

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

export function validatePlanningResult(value, expectedInput, maxTasks) {
    const normalizedInput = normalizePlanningInput(expectedInput);
    const expectedDigest = analysisInputDigest(normalizedInput);
    const result = plainObject(value, "result");
    if (result.kind !== "mobius-plan-result-v1") {
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

function criterionId(taskId, index) {
    return `${taskId}-C${String(index + 1).padStart(3, "0")}`;
}

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
        tasks: plan.tasks.map((task) => ({
            id: task.id,
            criteria: task.acceptanceCriteria.map((criterion, index) => ({
                id: criterionId(task.id, index),
                text: criterion,
            })),
            resultSummary: task.resultSummary,
            evidence: task.evidence,
            prUrl: task.prUrl,
        })),
    };
    return {
        ...normalized,
        inputDigest: analysisInputDigest(normalized),
    };
}

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
            return {
                id,
                criteria,
                resultSummary: text(
                    task.resultSummary,
                    `input.tasks[${taskIndex}].resultSummary`,
                    LIMITS.resultSummary,
                ),
                evidence: stringList(
                    task.evidence,
                    `input.tasks[${taskIndex}].evidence`,
                    LIMITS.evidence,
                    LIMITS.evidenceItem,
                    1,
                ),
                prUrl: task.prUrl === null
                    ? null
                    : text(
                        task.prUrl,
                        `input.tasks[${taskIndex}].prUrl`,
                        LIMITS.prUrl,
                    ),
            };
        }),
    };
    const expectedDigest = analysisInputDigest(normalized);
    if (input.inputDigest !== expectedDigest) {
        fail("analysis_input_mismatch", "Verification input digest is invalid");
    }
    return { ...normalized, inputDigest: expectedDigest };
}

export function validateVerificationResult(value, expectedInput) {
    const input = normalizeVerificationInput(expectedInput);
    const result = plainObject(value, "result");
    if (result.kind !== "mobius-verification-result-v1") {
        fail("invalid_analysis_result", "Verification result kind is not supported");
    }
    if (result.inputDigest !== input.inputDigest || result.planId !== input.planId) {
        fail("analysis_input_mismatch", "Verification result does not match the persisted input");
    }
    const expectedCriterionIds = new Set(
        input.tasks.flatMap((task) => task.criteria.map((criterion) => criterion.id)),
    );
    const covered = new Set();
    if (!Array.isArray(result.reviews) || result.reviews.length !== 2) {
        fail("invalid_analysis_result", "Verification result requires two reviewers");
    }
    for (const review of result.reviews) {
        if (!review || !Array.isArray(review.coverage)) {
            fail("invalid_analysis_result", "Verification reviewer is missing");
        }
        for (const mapping of review.coverage) {
            if (expectedCriterionIds.has(mapping?.criterionId)
                && typeof mapping?.evidence === "string"
                && mapping.evidence.trim()) {
                covered.add(mapping.criterionId);
            }
        }
    }
    const uncovered = [...expectedCriterionIds].filter((id) => !covered.has(id));
    const evidence = stringList(
        result.evidence,
        "result.evidence",
        LIMITS.evidence,
        LIMITS.evidenceItem,
        result.passed ? 1 : 0,
    );
    const missingEvidence = stringList(
        result.missingEvidence,
        "result.missingEvidence",
        LIMITS.missingEvidence,
        LIMITS.missingEvidenceItem,
        result.passed ? 0 : 1,
    );
    const passed = result.passed === true
        && uncovered.length === 0
        && missingEvidence.length === 0
        && evidence.length > 0;
    if (result.passed === true && !passed) {
        fail("invalid_analysis_result", "Passing verification result lacks complete criterion coverage");
    }
    return {
        passed,
        summary: text(result.summary, "result.summary", LIMITS.resultSummary),
        evidence,
        missingEvidence: [...new Set([
            ...uncovered.map((id) => `No evidence mapped for ${id}`),
            ...missingEvidence,
        ])].slice(0, LIMITS.missingEvidence),
    };
}
