import assert from "node:assert/strict";
import test from "node:test";

import {
    ATTEMPT_STATUS,
    EVIDENCE_TYPE,
    PLAN_STATUS,
    SCHEMA_VERSION,
    TASK_STATUS,
    approvePlan,
    attachTaskAttempt,
    completeTaskAttempt,
    completeVerification,
    createDraftPlan,
    finalizePlanCancellation,
    getReadyTasks,
    latestSuccessfulAttempt,
    reconcileTaskReadiness,
    requestPlanCancellation,
    reserveTaskAttempt,
    reserveVerification,
    retryFailedPlan,
    retryTask,
    summarizePlan,
    taskLaunchGuidance,
    transitionPlan,
    validatePlan,
	verificationCheckIds,
} from "./domain.mjs";

const CREATED_AT = "2026-08-05T16:00:00.000Z";
const APPROVED_AT = "2026-08-05T16:01:00.000Z";
const RESERVED_AT = "2026-08-05T16:02:00.000Z";
const STARTED_AT = "2026-08-05T16:03:00.000Z";
const COMPLETED_AT = "2026-08-05T16:04:00.000Z";
const CANCELLED_AT = "2026-08-05T16:05:00.000Z";

function task(id, dependsOn = []) {
    return {
        id,
        title: `Task ${id}`,
		kind: "implement",
        description: `Implement ${id}`,
        dependsOn,
        acceptanceCriteria: [`${id} is observable`],
        expectedFiles: [`src/${id.toLowerCase()}.mjs`],
		deliveryRequirement: "commit",
    };
}

function withVerifier(tasks) {
	if (tasks.some((entry) => entry.kind === "verify")) return tasks;
	const dependedOn = new Set(tasks.flatMap((entry) => entry.dependsOn));
	const sinks = tasks.filter((entry) => !dependedOn.has(entry.id));
	let normalized = [...tasks];
	let target = sinks[0];
	if (sinks.length !== 1) {
		target = task("T-998", sinks.map((entry) => entry.id));
		normalized.push(target);
	}
	return [
		...normalized,
		{
			id: "T-997",
			title: "Verify",
			kind: "verify",
			description: "Verify the final delivery",
			dependsOn: [target.id],
			acceptanceCriteria: [],
			expectedFiles: [],
			deliveryRequirement: "commit",
		},
	];
}

function draft(options = {}) {
	const tasks = withVerifier(options.tasks ?? [
		task("T-001"),
		task("T-002", ["T-001"]),
	]);
    return createDraftPlan({
        id: options.id ?? "sample-plan",
        title: options.title ?? "Sample plan",
        objective: options.objective ?? "Deliver a dependency-aware change",
        constraints: options.constraints ?? ["Keep the change scoped"],
        repository: {
            workingDirectory: "/tmp/sample-repository",
            baseBranch: "main",
        },
        planning: options.planning ?? null,
		tasks,
    }, { now: CREATED_AT });
}

function approved(options = {}) {
    const submitted = transitionPlan(draft(options), PLAN_STATUS.AWAITING_APPROVAL, {
        at: CREATED_AT,
    });
    return approvePlan(submitted, "octocat", { at: APPROVED_AT });
}

function claimedEvidence(summary = "node --test passed") {
    return [{
        type: EVIDENCE_TYPE.TEST,
        summary,
        source: "node --test",
        outcome: "passed",
    }];
}

/**
 * Requires a value in test setup and narrows its type.
 *
 * @template T
 * @param {T | null | undefined} value
 * @param {string} [message]
 * @returns {T}
 */
function required(value, message = "Expected test fixture value") {
    assert.ok(value, message);
    return value;
}

function completeTask(plan, taskId, options = {}) {
    const reservationId = options.reservationId ?? `reserve-${taskId}-${plan.revision}`;
    let candidate = reserveTaskAttempt(plan, taskId, {
        reservationId,
        scopeOverride: options.scopeOverride ?? null,
        at: RESERVED_AT,
    });
    const taskRecord = required(candidate.tasks.find((entry) => entry.id === taskId));
    const attempt = required(taskRecord.attempts.at(-1));
    candidate = attachTaskAttempt(candidate, taskId, attempt.id, {
        sessionId: options.sessionId ?? `session-${attempt.id}`,
        branch: options.branch ?? `work/${attempt.id.toLowerCase()}`,
        at: STARTED_AT,
    });
	const taskEvidence = taskRecord.kind === "verify"
		? [
				...candidate.tasks
					.filter((entry) => entry.kind === "implement")
					.sort((left, right) => left.id.localeCompare(right.id))
					.flatMap((entry) => entry.acceptanceCriteria.map(
						(_criterion, index) => ({
							checkId: `${entry.id}-C${String(index + 1).padStart(3, "0")}`,
							type: EVIDENCE_TYPE.TEST,
							summary: "Independent check passed",
							source: "node --test",
							outcome: "passed",
						}),
					)),
				{
					checkId: "final-integration",
					type: EVIDENCE_TYPE.INTEGRATION,
					summary: "Integration passed",
					source: "node --test",
					outcome: "passed",
				},
				{
					checkId: "workspace-integrity",
					type: EVIDENCE_TYPE.COMMAND,
					summary: "Workspace remained clean",
					source: "git status --porcelain",
					outcome: "passed",
				},
			]
		: claimedEvidence();
    candidate = completeTaskAttempt(candidate, taskId, attempt.id, ATTEMPT_STATUS.DONE, {
        resultSummary: options.resultSummary ?? `Implemented ${taskId}`,
		evidence: options.evidence ?? taskEvidence,
        branch: options.branch ?? `work/${attempt.id.toLowerCase()}`,
        commit: options.commit ?? "a".repeat(40),
        prUrl: options.prUrl ?? null,
        at: COMPLETED_AT,
    });
    return { plan: reconcileTaskReadiness(candidate, { at: COMPLETED_AT }), attemptId: attempt.id };
}

function throwsCode(operation, code) {
    assert.throws(operation, (/** @type {any} */ error) => {
        assert.equal(error.code, code);
        return true;
    });
}

test("createDraftPlan produces the strict initial schema", () => {
    const plan = draft();
	assert.equal(SCHEMA_VERSION, 1);
	assert.equal(plan.schemaVersion, 1);
    assert.equal(plan.status, PLAN_STATUS.DRAFT);
    assert.equal(plan.cancellation, null);
    assert.deepEqual(plan.tasks[0].attempts, []);
    assert.equal(validatePlan(plan), plan);
});

test("the verifier is the unique sink and canonicalizes checkId evidence", () => {
	const invalid = structuredClone(draft());
	invalid.tasks.push({ ...invalid.tasks[2], id: "T-996" });
	throwsCode(() => validatePlan(invalid), "invalid_task_topology");

	let plan = approved();
	({ plan } = completeTask(plan, "T-001"));
	({ plan } = completeTask(plan, "T-002"));
	const checks = verificationCheckIds(plan.tasks);
	const evidence = checks.map((checkId) => ({
		checkId,
		type: checkId === "final-integration"
			? EVIDENCE_TYPE.INTEGRATION
			: EVIDENCE_TYPE.TEST,
		summary: `${checkId} checked`,
		source: "node --test",
		outcome: "passed",
	})).reverse();
	({ plan } = completeTask(plan, "T-997", { evidence }));
	assert.deepEqual(
		plan.tasks[2].attempts[0].evidence.map((entry) => entry.checkId),
		checks,
	);

	let blocked = approved();
	({ plan: blocked } = completeTask(blocked, "T-001"));
	({ plan: blocked } = completeTask(blocked, "T-002"));
	blocked = reserveTaskAttempt(blocked, "T-997", {
		reservationId: "blocked-verifier",
		at: RESERVED_AT,
	});
	blocked = completeTaskAttempt(
		blocked,
		"T-997",
		"T-997-A001",
		ATTEMPT_STATUS.BLOCKED,
		{ error: "create_session failed", evidence: [], at: COMPLETED_AT },
	);
	assert.equal(blocked.tasks[2].status, TASK_STATUS.BLOCKED);
});

test("plan validation rejects malformed timestamps and dependency graphs", async (context) => {
    const cases = [
        {
            name: "malformed plan id",
            code: "invalid_plan_id",
            build: () => draft({ id: "../escape" }),
        },
        {
            name: "duplicate task id",
            code: "duplicate_task_id",
            build: () => draft({ tasks: [task("T-001"), task("T-001")] }),
        },
        {
            name: "unknown dependency",
            code: "unknown_dependency",
			build: () => draft({ tasks: [task("T-001", ["T-996"])] }),
        },
        {
            name: "dependency cycle",
            code: "dependency_cycle",
            build: () => draft({
                tasks: [task("T-001", ["T-002"]), task("T-002", ["T-001"])],
            }),
        },
    ];
    for (const current of cases) {
        await context.test(current.name, () => throwsCode(current.build, current.code));
    }
    const invalidDate = draft();
    invalidDate.updatedAt = "2026-02-30T16:00:00.000Z";
    throwsCode(() => validatePlan(invalidDate), "invalid_timestamp");
});

test("approval resolves ready tasks deterministically", () => {
    const plan = approved({
        tasks: [task("T-002"), task("T-001"), task("T-003", ["T-001"])],
    });
    assert.deepEqual(getReadyTasks(plan).map((entry) => entry.id), ["T-001", "T-002"]);
    assert.equal(
        required(plan.tasks.find((entry) => entry.id === "T-003")).status,
        TASK_STATUS.PLANNED,
    );
});

test("reservation closes the create-session race and completion retains provenance", () => {
    let plan = approved({ tasks: [task("T-001")] });
    plan = reserveTaskAttempt(plan, "T-001", {
        reservationId: "reserve-t001-first",
        at: RESERVED_AT,
    });
    const taskRecord = plan.tasks[0];
    const attempt = taskRecord.attempts[0];
    assert.equal(plan.status, PLAN_STATUS.RUNNING);
    assert.equal(taskRecord.status, TASK_STATUS.RUNNING);
    assert.equal(attempt.id, "T-001-A001");
    assert.equal(attempt.status, ATTEMPT_STATUS.RESERVED);
    assert.equal(attempt.baseBranch, "main");
    assert.equal(attempt.sessionId, null);

    plan = attachTaskAttempt(plan, "T-001", attempt.id, {
        sessionId: "session-1",
        branch: "work/t-001",
        at: STARTED_AT,
    });
    const attached = plan.tasks[0].attempts[0];
    assert.equal(attached.status, ATTEMPT_STATUS.RUNNING);
    assert.equal(attached.sessionId, "session-1");

    const idempotent = attachTaskAttempt(plan, "T-001", attempt.id, {
        sessionId: "session-1",
        branch: "work/t-001",
        at: COMPLETED_AT,
    });
    assert.deepEqual(idempotent, plan);
    throwsCode(
        () => attachTaskAttempt(plan, "T-001", attempt.id, {
            sessionId: "session-1",
            at: COMPLETED_AT,
        }),
        "attempt_already_attached",
    );
    throwsCode(
        () => attachTaskAttempt(plan, "T-001", attempt.id, {
            sessionId: "replacement-session",
            at: COMPLETED_AT,
        }),
        "attempt_already_attached",
    );

    plan = completeTaskAttempt(plan, "T-001", attempt.id, ATTEMPT_STATUS.DONE, {
        resultSummary: "Implemented",
        evidence: claimedEvidence(),
        branch: "work/t-001",
        commit: "b".repeat(40),
        at: COMPLETED_AT,
    });
    const completed = plan.tasks[0].attempts[0];
    assert.equal(plan.tasks[0].status, TASK_STATUS.DONE);
    assert.equal(completed.evidence[0].id, "T-001-A001-E001");
    assert.equal(completed.evidence[0].producer, "session-1");
    assert.equal(completed.evidence[0].trust, "claimed");
    const forged = structuredClone(plan);
    forged.tasks[0].attempts[0].evidence[0].producer = "forged-session";
    throwsCode(() => validatePlan(forged), "invalid_evidence_producer");
});

test("reservation IDs are unique across the complete plan", () => {
    let plan = approved({
        tasks: [task("T-001"), task("T-002")],
    });
    plan = reserveTaskAttempt(plan, "T-001", {
        reservationId: "reserve-unique-one",
        at: RESERVED_AT,
    });
    plan = reserveTaskAttempt(plan, "T-002", {
        reservationId: "reserve-unique-two",
        at: RESERVED_AT,
    });
    const forged = structuredClone(plan);
    forged.tasks[1].attempts[0].reservationId = "reserve-unique-one";
    throwsCode(() => validatePlan(forged), "duplicate_request_id");

    let completed = approved({ tasks: [task("T-001")] });
    completed = reserveTaskAttempt(completed, "T-001", {
        reservationId: "shared-task-verification-reservation",
        at: RESERVED_AT,
    });
    completed = attachTaskAttempt(completed, "T-001", "T-001-A001", {
        sessionId: "shared-reservation-session",
        branch: "work/shared-reservation",
        at: STARTED_AT,
    });
    completed = completeTaskAttempt(
        completed,
        "T-001",
        "T-001-A001",
        ATTEMPT_STATUS.DONE,
        {
            resultSummary: "Done",
            evidence: claimedEvidence(),
            branch: "work/shared-reservation",
			commit: "d".repeat(40),
            at: COMPLETED_AT,
        },
    );
	completed = reconcileTaskReadiness(completed, { at: COMPLETED_AT });
	({ plan: completed } = completeTask(completed, "T-997", {
		commit: "d".repeat(40),
	}));
    throwsCode(
        () => reserveVerification(completed, {
            reservationId: "shared-task-verification-reservation",
            inputDigest: "d".repeat(64),
            at: CANCELLED_AT,
        }),
        "duplicate_request_id",
    );
});

test("retries retain attempts and dependency waits wake automatically", () => {
    let plan = approved();
    plan = reserveTaskAttempt(plan, "T-001", {
        reservationId: "reserve-first-failure",
        at: RESERVED_AT,
    });
    const firstAttempt = plan.tasks[0].attempts[0];
    plan = completeTaskAttempt(plan, "T-001", firstAttempt.id, ATTEMPT_STATUS.FAILED, {
        error: "create_session failed",
        at: COMPLETED_AT,
    });
    plan = reconcileTaskReadiness(plan, { at: COMPLETED_AT });
    assert.equal(plan.tasks[1].status, TASK_STATUS.PLANNED);
    assert.equal(plan.tasks[0].attempts.length, 1);

    plan = retryTask(plan, "T-001", { at: COMPLETED_AT });
    plan = reserveTaskAttempt(plan, "T-001", {
        reservationId: "reserve-second-success",
        at: RESERVED_AT,
    });
    const second = required(required(plan.tasks[0]).attempts.at(-1));
    assert.equal(second.id, "T-001-A002");
    plan = attachTaskAttempt(plan, "T-001", second.id, {
        sessionId: "session-2",
        branch: "work/t-001-retry",
        at: STARTED_AT,
    });
    plan = completeTaskAttempt(plan, "T-001", second.id, ATTEMPT_STATUS.DONE, {
        resultSummary: "Fixed",
        evidence: claimedEvidence(),
        branch: "work/t-001-retry",
        commit: "c".repeat(40),
        at: COMPLETED_AT,
    });
    plan = reconcileTaskReadiness(plan, { at: COMPLETED_AT });
    assert.equal(plan.tasks[1].status, TASK_STATUS.READY);
    assert.equal(plan.tasks[0].attempts[0].status, ATTEMPT_STATUS.FAILED);
    assert.equal(plan.tasks[0].attempts[1].status, ATTEMPT_STATUS.DONE);
});

test("dependency delivery chooses a deterministic base and requires integration evidence", () => {
    let plan = approved({
        tasks: [
            task("T-001"),
            task("T-002"),
            task("T-003", ["T-001", "T-002"]),
        ],
    });
    ({ plan } = completeTask(plan, "T-001", { branch: "work/one" }));
    ({ plan } = completeTask(plan, "T-002", { branch: "work/two" }));
    const guidance = taskLaunchGuidance(plan, "T-003");
    assert.equal(guidance.baseBranch, "work/one");
    assert.deepEqual(guidance.integrationRequired.map((entry) => entry.taskId), ["T-002"]);

    plan = reserveTaskAttempt(plan, "T-003", {
        reservationId: "reserve-integration",
        at: RESERVED_AT,
    });
    const attempt = plan.tasks[2].attempts[0];
    plan = attachTaskAttempt(plan, "T-003", attempt.id, {
        sessionId: "session-integration",
        branch: "work/integration",
        at: STARTED_AT,
    });
    throwsCode(
        () => completeTaskAttempt(plan, "T-003", attempt.id, ATTEMPT_STATUS.DONE, {
            resultSummary: "Integrated",
            evidence: claimedEvidence(),
            branch: "work/integration",
			commit: "f".repeat(40),
            at: COMPLETED_AT,
        }),
        "invalid_attempt_state",
    );
    plan = completeTaskAttempt(plan, "T-003", attempt.id, ATTEMPT_STATUS.DONE, {
        resultSummary: "Integrated",
        evidence: [
            ...claimedEvidence(),
            {
                type: EVIDENCE_TYPE.INTEGRATION,
                summary: "Merged dependency branch and ran integration tests",
                source: "git merge work/two && node --test",
                outcome: "passed",
            },
        ],
        branch: "work/integration",
		commit: "f".repeat(40),
        at: COMPLETED_AT,
    });
    assert.equal(plan.tasks[2].status, TASK_STATUS.DONE);
});

test("cancellation snapshots attempts and cannot finalize an in-flight create as absent", () => {
    let plan = approved({ tasks: [task("T-001")] });
    plan = reserveTaskAttempt(plan, "T-001", {
        reservationId: "reserve-before-cancel",
        at: RESERVED_AT,
    });
    const attemptId = plan.tasks[0].attempts[0].id;
    plan = requestPlanCancellation(plan, {
        requestId: "cancel-request-1",
        reason: "User stopped work",
        requestedBy: "octocat",
        at: COMPLETED_AT,
    });
    assert.equal(plan.status, PLAN_STATUS.CANCELLING);
    assert.deepEqual(plan.cancellation.requiredAttemptIds, [attemptId]);
    assert.equal(plan.tasks[0].attempts[0].status, ATTEMPT_STATUS.CANCEL_REQUESTED);

    plan = attachTaskAttempt(plan, "T-001", attemptId, {
        sessionId: "late-session",
        branch: "work/late",
        at: CANCELLED_AT,
    });
    throwsCode(
        () => finalizePlanCancellation(plan, [{
            attemptId,
            disposition: "no-session-created",
        }], {
            finalizedBy: "octocat",
            verificationTerminated: true,
            at: CANCELLED_AT,
        }),
        "invalid_cancellation_disposition",
    );
    plan = finalizePlanCancellation(plan, [{
        attemptId,
        disposition: "session-terminated",
        sessionId: "late-session",
    }], {
        finalizedBy: "octocat",
        verificationTerminated: true,
        at: CANCELLED_AT,
    });
    assert.equal(plan.status, PLAN_STATUS.CANCELLED);
    assert.equal(plan.tasks[0].attempts[0].status, ATTEMPT_STATUS.CANCELLED);
    assert.equal(plan.cancellation.acknowledgements[0].sessionId, "late-session");
});

test("verification cancellation requires observed Factory termination", () => {
    let plan = approved({ tasks: [task("T-001")] });
    ({ plan } = completeTask(plan, "T-001"));
	({ plan } = completeTask(plan, "T-997"));
    plan = reserveVerification(plan, {
        reservationId: "reserve-verification-cancel",
        inputDigest: "a".repeat(64),
        at: COMPLETED_AT,
    });
    plan = requestPlanCancellation(plan, {
        requestId: "cancel-verification",
        reason: "Stop verification",
        requestedBy: "octocat",
		verificationRunId: "verification-run",
        at: CANCELLED_AT,
    });
    throwsCode(
        () => finalizePlanCancellation(plan, [], {
            finalizedBy: "octocat",
            verificationTerminated: false,
            verificationDisposition: "run-terminated",
            at: CANCELLED_AT,
        }),
        "cancellation_incomplete",
    );
    plan = finalizePlanCancellation(plan, [], {
        finalizedBy: "octocat",
        verificationTerminated: true,
        verificationDisposition: "run-terminated",
        at: CANCELLED_AT,
    });
    assert.equal(plan.verification.status, "failed");
    assert.equal(plan.cancellation.verificationTerminatedAt, CANCELLED_AT);
});

test("failed verification reopens attributed tasks and all descendants", () => {
    let plan = approved();
    ({ plan } = completeTask(plan, "T-001"));
    ({ plan } = completeTask(plan, "T-002"));
	({ plan } = completeTask(plan, "T-997"));
    const firstAttempts = plan.tasks.map((entry) => entry.attempts[0].id);
    plan = reserveVerification(plan, {
        reservationId: "reserve-verification-failed",
        inputDigest: "b".repeat(64),
        at: COMPLETED_AT,
    });
    plan = completeVerification(plan, {
        passed: false,
        summary: "Foundation evidence is insufficient",
        evidence: ["T-001-A001-E001"],
        missingEvidence: ["No evidence mapped for T-001-C001"],
        correctionTaskIds: ["T-001"],
    }, {
        runId: "verification-failed",
        at: CANCELLED_AT,
    });
    assert.equal(plan.status, PLAN_STATUS.FAILED);
    plan = retryFailedPlan(plan, "octocat", { at: CANCELLED_AT });
    assert.equal(plan.status, PLAN_STATUS.RUNNING);
    assert.equal(plan.tasks[0].status, TASK_STATUS.READY);
    assert.equal(plan.tasks[1].status, TASK_STATUS.PLANNED);
    assert.deepEqual(plan.tasks.map((entry) => entry.attempts[0].id), firstAttempts);
    assert.equal(plan.verification.status, "not-started");
});

test("passed verification still requires explicit completion approval", () => {
    let plan = approved({ tasks: [task("T-001")] });
    ({ plan } = completeTask(plan, "T-001"));
	({ plan } = completeTask(plan, "T-997"));
    plan = reserveVerification(plan, {
        reservationId: "reserve-verification-passed",
        inputDigest: "c".repeat(64),
        at: COMPLETED_AT,
    });
    plan = completeVerification(plan, {
        passed: true,
        summary: "Verified",
        evidence: ["T-001-A001-E001"],
        missingEvidence: [],
        correctionTaskIds: [],
    }, {
        runId: "verification-passed",
        at: CANCELLED_AT,
    });
    assert.equal(plan.status, PLAN_STATUS.AWAITING_COMPLETION_APPROVAL);
    plan = transitionPlan(plan, PLAN_STATUS.COMPLETED, {
        actor: "octocat",
        at: CANCELLED_AT,
    });
    assert.equal(plan.status, PLAN_STATUS.COMPLETED);
});

test("summaries include attempt counts without duplicating attempt state", () => {
    let plan = approved({ tasks: [task("T-001")] });
    ({ plan } = completeTask(plan, "T-001"));
    const summary = summarizePlan(plan);
    assert.equal(summary.tasksDone, 1);
    assert.equal(summary.attemptsTotal, 1);
    assert.equal(latestSuccessfulAttempt(required(plan.tasks[0]))?.id, "T-001-A001");
});
