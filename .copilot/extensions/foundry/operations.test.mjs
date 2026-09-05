import assert from "node:assert/strict";
import {
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    EVIDENCE_TYPE,
    LIMITS,
    PLAN_STATUS,
    TASK_STATUS,
} from "./domain.mjs";
import { createFoundryOperations } from "./operations.mjs";
import { createPlanStore } from "./storage.mjs";

async function withOperations(operation, options = {}) {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "foundry-operations-"));
    const notifications = [];
    const operations = createFoundryOperations({
        getWorkspacePath: () => workspacePath,
        notify: (event) => notifications.push(event),
        analysis: options.analysis ?? analysisStub(),
        ...options,
    });
    try {
        return await operation({ operations, notifications, workspacePath });
    } finally {
        await rm(workspacePath, { recursive: true, force: true });
    }
}

function planBlueprint() {
    return {
        title: "Operation plan",
        objective: "Exercise the complete Foundry coordinator lifecycle",
        constraints: ["Keep task scopes separate"],
        tasks: [
            {
                id: "T-001",
                title: "Foundation",
				kind: "implement",
                description: "Create the foundation",
                dependsOn: [],
                acceptanceCriteria: ["Foundation is present"],
                expectedFiles: ["src/foundation.mjs"],
				deliveryRequirement: "branch",
            },
            {
                id: "T-002",
                title: "Integration",
				kind: "implement",
                description: "Integrate the foundation",
                dependsOn: ["T-001"],
                acceptanceCriteria: ["Integration is complete"],
                expectedFiles: ["src/integration.mjs"],
				deliveryRequirement: "commit",
            },
			{
				id: "T-003",
				title: "Verify",
				kind: "verify",
				description: "Verify the final delivery",
				dependsOn: ["T-002"],
				acceptanceCriteria: [],
				expectedFiles: [],
				deliveryRequirement: "commit",
			},
        ],
    };
}

function createInput(workspacePath) {
    return {
        expectedRevision: 0,
        id: "operation-plan",
        runId: "planning-run-1",
        repository: {
            workingDirectory: workspacePath,
            baseBranch: "main",
        },
    };
}

function analysisStub(options = {}) {
    const blueprint = options.plan ?? planBlueprint();
    const verificationResult = options.verificationResult ?? {
        passed: true,
        summary: "All acceptance criteria covered",
		evidence: [
			"T-003-A001-E001",
			"T-003-A001-E002",
			"T-003-A001-E003",
			"T-003-A001-E004",
		],
        missingEvidence: [],
        correctionTaskIds: [],
    };
    return {
        preparePlanning: async () => ({
			factory: "plan",
            inputDigest: "a".repeat(64),
			launchSpec: { name: "plan", args: {} },
        }),
        importPlanning: async (runId) => ({
            runId,
            inputDigest: "a".repeat(64),
            plan: structuredClone(blueprint),
        }),
		prepareVerification: async (_plan, reservationId) => ({
			factory: "verify",
            inputDigest: "b".repeat(64),
			launchSpec: {
				name: "verify",
				args: { reservationId },
			},
        }),
		importVerification: async (runId) => ({
            run: {
                runId,
				status: "completed",
            },
			detail: { completedAt: Date.now() },
			result: verificationResult,
        }),
		discoverVerificationRun:
			options.discoverVerificationRun ?? (async () => ({ state: "absent" })),
		assessVerificationRun:
			options.assessVerificationRun ?? (async () => ({ state: "active" })),
		cancelVerificationRun:
			options.cancelVerificationRun ?? (async (runId) => ({
				runId,
				status: "cancelled",
				alreadyTerminal: false,
			})),
        verificationRunIsTerminal: options.verificationRunIsTerminal
            ?? (async () => true),
    };
}

function evidence(summary) {
    return [{
        type: EVIDENCE_TYPE.TEST,
        summary,
        source: "node --test",
        outcome: "passed",
    }];
}

function completeInventory(sessions = []) {
	return {
		complete: true,
		capturedAt: new Date(Date.now() + 1000).toISOString(),
		sessions,
	};
}

async function createApproved(operations, workspacePath) {
    let plan = await operations.createPlan(createInput(workspacePath));
    plan = await operations.submitPlan({
        planId: plan.id,
        expectedRevision: plan.revision,
    });
    return operations.approve({
        planId: plan.id,
        expectedRevision: plan.revision,
        approvedBy: "octocat",
        approvalType: "plan",
    });
}

test("activity stays bounded and records resulting revisions", () => (
    withOperations(async ({ operations, workspacePath }) => {
		let plan = await operations.createPlan(createInput(workspacePath));
		plan.activity = Array.from({ length: LIMITS.activity }, (_, index) => ({
			event: `event-${index}`,
			at: plan.updatedAt,
			revision: 1,
		}));
		const store = createPlanStore({ workspacePath });
		plan = await store.update(plan.id, plan.revision, plan);

		const submitted = await operations.submitPlan({
			planId: plan.id,
			expectedRevision: plan.revision,
		});
		assert.equal(submitted.activity.length, LIMITS.activity);
		assert.equal(submitted.activity.at(-1).event, "plan-submitted");
		assert.equal(submitted.activity.at(-1).revision, submitted.revision);
		assert.equal(submitted.activity[0].event, "event-1");
    })
));

test("done attempts report actionable missing delivery fields", () => (
	withOperations(async ({ operations, workspacePath }) => {
		let plan = await createApproved(operations, workspacePath);
		const first = await operations.reserveTask({
			planId: plan.id,
			taskId: "T-001",
			expectedRevision: plan.revision,
			reservationId: "missing-completion-fields",
		});
		plan = await operations.attachTask({
			planId: plan.id,
			taskId: "T-001",
			attemptId: first.attemptId,
			expectedRevision: first.plan.revision,
			sessionId: "missing-completion-session",
			branch: "work/missing-completion",
		});
		await assert.rejects(
			operations.completeTask({
				planId: plan.id,
				taskId: "T-001",
				attemptId: first.attemptId,
				expectedRevision: plan.revision,
				status: TASK_STATUS.DONE,
			}),
			(/** @type {any} */ error) =>
				error.code === "task_completion_incomplete"
				&& error.details.missing.includes("resultSummary")
				&& error.details.missing.includes("evidence")
				&& !error.details.missing.includes("branch"),
		);
		await assert.rejects(
			operations.completeTask({
				planId: plan.id,
				taskId: "T-001",
				attemptId: first.attemptId,
				expectedRevision: plan.revision,
				status: TASK_STATUS.DONE,
				resultSummary: "Foundation complete",
				evidence: evidence("Foundation passed"),
				branch: "work/wrong-branch",
			}),
			{ code: "branch_mismatch" },
		);
		plan = await operations.completeTask({
			planId: plan.id,
			taskId: "T-001",
			attemptId: first.attemptId,
			expectedRevision: plan.revision,
			status: TASK_STATUS.DONE,
			resultSummary: "Foundation complete",
			evidence: evidence("Foundation passed"),
		});
		assert.equal(plan.tasks[0].attempts[0].branch, "work/missing-completion");

		const second = await operations.reserveTask({
			planId: plan.id,
			taskId: "T-002",
			expectedRevision: plan.revision,
			reservationId: "short-commit",
		});
		plan = await operations.attachTask({
			planId: plan.id,
			taskId: "T-002",
			attemptId: second.attemptId,
			expectedRevision: second.plan.revision,
			sessionId: "short-commit-session",
			branch: "work/short-commit",
		});
		await assert.rejects(
			operations.completeTask({
				planId: plan.id,
				taskId: "T-002",
				attemptId: second.attemptId,
				expectedRevision: plan.revision,
				status: TASK_STATUS.DONE,
				resultSummary: "Integration complete",
				evidence: evidence("Integration passed"),
				branch: "work/short-commit",
				commit: "abcdef0",
			}),
			(/** @type {any} */ error) =>
				error.code === "task_completion_incomplete"
				&& error.details.missing.includes("full commit"),
		);
	})
));

test("completion only reuses a branch when one was attached", () => (
	withOperations(async ({ operations, workspacePath }) => {
		let plan = await createApproved(operations, workspacePath);
		const reserved = await operations.reserveTask({
			planId: plan.id,
			taskId: "T-001",
			expectedRevision: plan.revision,
			reservationId: "branch-not-attached",
		});
		plan = await operations.attachTask({
			planId: plan.id,
			taskId: "T-001",
			attemptId: reserved.attemptId,
			expectedRevision: reserved.plan.revision,
			sessionId: "branchless-session",
		});
		const result = {
			planId: plan.id,
			taskId: "T-001",
			attemptId: reserved.attemptId,
			expectedRevision: plan.revision,
			status: TASK_STATUS.DONE,
			resultSummary: "Delivered",
			evidence: evidence("Passed"),
		};
		await assert.rejects(operations.completeTask(result), (/** @type {any} */ error) => {
			assert.equal(error.code, "task_completion_incomplete");
			assert.deepEqual(error.details.missing, ["branch"]);
			return true;
		});
		plan = await operations.completeTask({ ...result, branch: "work/reported" });
		assert.equal(plan.tasks[0].attempts[0].branch, "work/reported");
	})
));

async function runTask(operations, plan, taskId, options = {}) {
	const task = plan.tasks.find((entry) => entry.id === taskId);
	const taskEvidence = task?.kind === "verify"
		? [
				...plan.tasks
					.filter((entry) => entry.kind === "implement")
					.sort((left, right) => left.id.localeCompare(right.id))
					.flatMap((entry) => entry.acceptanceCriteria.map(
						(_criterion, index) => ({
							checkId: `${entry.id}-C${String(index + 1).padStart(3, "0")}`,
							type: EVIDENCE_TYPE.TEST,
							summary: `${entry.id} criterion passed`,
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
					summary: "HEAD and worktree are unchanged",
					source: "git status --porcelain",
					outcome: "passed",
				},
			]
		: evidence(`${taskId} tests passed`);
    const reserved = await operations.reserveTask({
        planId: plan.id,
        taskId,
        expectedRevision: plan.revision,
        reservationId: options.reservationId ?? `reserve-${taskId}-${plan.revision}`,
        scopeOverride: options.scopeOverride,
    });
    plan = reserved.plan;
    plan = await operations.attachTask({
        planId: plan.id,
        taskId,
        attemptId: reserved.attemptId,
        expectedRevision: plan.revision,
        sessionId: options.sessionId ?? `session-${taskId}`,
        branch: options.branch ?? `work/${taskId.toLowerCase()}`,
    });
    plan = await operations.completeTask({
        planId: plan.id,
        taskId,
        attemptId: reserved.attemptId,
        expectedRevision: plan.revision,
        status: TASK_STATUS.DONE,
        resultSummary: `${taskId} complete`,
		evidence: options.evidence ?? taskEvidence,
        branch: options.branch ?? `work/${taskId.toLowerCase()}`,
        commit: options.commit ?? "a".repeat(40),
        prUrl: options.prUrl,
    });
    return { plan, reserved };
}

async function completeImplementation(operations, workspacePath) {
	let plan = await createApproved(operations, workspacePath);
	({ plan } = await runTask(operations, plan, "T-001", {
		reservationId: "complete-foundation",
		sessionId: "complete-foundation-session",
	}));
	({ plan } = await runTask(operations, plan, "T-002", {
		reservationId: "complete-integration",
		sessionId: "complete-integration-session",
	}));
	({ plan } = await runTask(operations, plan, "T-003", {
		reservationId: "complete-verifier",
		sessionId: "complete-verifier-session",
		branch: "work/complete-verifier",
		commit: "a".repeat(40),
	}));
	return plan;
}

test("operations drive reservation, App attachment, verification, and approval", () => (
    withOperations(async ({ operations, notifications, workspacePath }) => {
        let plan = await createApproved(operations, workspacePath);
        let next = await operations.nextTasks({ planId: plan.id });
        assert.deepEqual(next.dispatchableTaskIds, ["T-001"]);
        assert.equal(next.tasks[0].launch.baseBranch, "main");
        assert.equal(next.tasks[0].delegationPrompt, undefined);

        const first = await operations.reserveTask({
            planId: plan.id,
            taskId: "T-001",
            expectedRevision: plan.revision,
            reservationId: "reserve-foundation",
        });
        plan = first.plan;
        assert.equal(first.attemptId, "T-001-A001");
        assert.match(first.delegationPrompt, /attempt T-001-A001/);
		assert.equal(plan.activity.at(-1).revision, plan.revision);
		assert.equal(
			plan.activity.at(-1).event,
			"task-reserved:T-001:T-001-A001",
		);
        const replay = await operations.reserveTask({
            planId: plan.id,
            taskId: "T-001",
            expectedRevision: plan.revision - 1,
            reservationId: "reserve-foundation",
        });
        assert.equal(replay.plan.revision, plan.revision);
        assert.equal(replay.attemptId, first.attemptId);

        plan = await operations.attachTask({
            planId: plan.id,
            taskId: "T-001",
            attemptId: first.attemptId,
            expectedRevision: plan.revision,
            sessionId: "session-foundation",
            branch: "work/foundation",
        });
        const attachedRevision = plan.revision;
        const attachedReplay = await operations.attachTask({
            planId: plan.id,
            taskId: "T-001",
            attemptId: first.attemptId,
            expectedRevision: plan.revision - 1,
            sessionId: "session-foundation",
            branch: "work/foundation",
        });
        assert.equal(attachedReplay.revision, attachedRevision);

        plan = await operations.completeTask({
            planId: plan.id,
            taskId: "T-001",
            attemptId: first.attemptId,
            expectedRevision: plan.revision,
            status: TASK_STATUS.DONE,
            resultSummary: "Foundation complete",
            evidence: evidence("foundation tests passed"),
            branch: "work/foundation",
            commit: "b".repeat(40),
            prUrl: "https://github.com/example/repo/pull/1",
        });
        assert.equal(plan.tasks[1].status, TASK_STATUS.READY);

        next = await operations.nextTasks({ planId: plan.id });
        assert.equal(next.tasks[0].launch.baseBranch, "work/foundation");
        const second = await runTask(operations, plan, "T-002", {
            reservationId: "reserve-integration",
            sessionId: "session-integration",
            branch: "work/integration",
            commit: "c".repeat(40),
        });
        plan = second.plan;
		({ plan } = await runTask(operations, plan, "T-003", {
			reservationId: "reserve-verifier",
			sessionId: "session-verifier",
			branch: "work/verifier",
			commit: "c".repeat(40),
		}));

        const verificationLaunch = await operations.prepareVerification({
            planId: plan.id,
            expectedRevision: plan.revision,
            reservationId: "reserve-verification-success",
        });
		assert.equal(verificationLaunch.factory, "verify");
        plan = verificationLaunch.plan;
        plan = await operations.finishVerification({
            planId: plan.id,
            expectedRevision: plan.revision,
			runId: "factory-run-1",
        });
        assert.equal(plan.status, PLAN_STATUS.AWAITING_COMPLETION_APPROVAL);
        plan = await operations.approve({
            planId: plan.id,
            expectedRevision: plan.revision,
            approvedBy: "octocat",
            approvalType: "completion",
        });
        assert.equal(plan.status, PLAN_STATUS.COMPLETED);
		assert.equal(plan.activity.at(-1).revision, plan.revision);
        assert.equal(notifications.at(-1).revision, plan.revision);
    }, {
		analysis: analysisStub({
			discoverVerificationRun: async () => ({
				state: "found",
				run: { runId: "factory-run-1", status: "completed" },
				duplicates: [],
			}),
		}),
	})
));

test("attached task failures require terminal session inventory", () => (
	withOperations(async ({ operations, workspacePath }) => {
		let plan = await createApproved(operations, workspacePath);
		const reserved = await operations.reserveTask({
			planId: plan.id,
			taskId: "T-001",
			expectedRevision: plan.revision,
			reservationId: "failed-session-proof",
		});
		plan = await operations.attachTask({
			planId: plan.id,
			taskId: "T-001",
			attemptId: reserved.attemptId,
			expectedRevision: reserved.plan.revision,
			sessionId: "failed-session",
			branch: "work/failed-session",
		});
		await assert.rejects(
			operations.completeTask({
				planId: plan.id,
				taskId: "T-001",
				attemptId: reserved.attemptId,
				expectedRevision: plan.revision,
				status: TASK_STATUS.FAILED,
				error: "Worker failed",
			}),
			(/** @type {any} */ error) =>
				error.code === "task_session_not_terminated",
		);
		plan = await operations.completeTask({
			planId: plan.id,
			taskId: "T-001",
			attemptId: reserved.attemptId,
			expectedRevision: plan.revision,
			status: TASK_STATUS.FAILED,
			error: "Worker failed",
			sessionInventory: completeInventory([{
				id: "failed-session",
				status: "archived",
			}]),
		});
		assert.equal(
			plan.tasks[0].attempts[0].sessionTerminatedAt,
			plan.tasks[0].attempts[0].completedAt,
		);
	})
));

test("scope overlap needs an auditable override and running scopes stay occupied", () => (
    withOperations(async ({ operations, workspacePath }) => {
        let plan = await createApproved(operations, workspacePath);
        const first = await operations.reserveTask({
            planId: plan.id,
            taskId: "T-001",
            expectedRevision: plan.revision,
            reservationId: "reserve-overlap-one",
        });
        plan = first.plan;
        const next = await operations.nextTasks({ planId: plan.id });
        assert.deepEqual(next.dispatchableTaskIds, []);
        assert.deepEqual(next.heldTaskIds, ["T-002"]);
        await assert.rejects(
            operations.reserveTask({
                planId: plan.id,
                taskId: "T-002",
                expectedRevision: plan.revision,
                reservationId: "reserve-overlap-two",
            }),
            (/** @type {any} */ error) => error.code === "scope_overlap_requires_approval",
        );
        const override = await operations.reserveTask({
            planId: plan.id,
            taskId: "T-002",
            expectedRevision: plan.revision,
            reservationId: "reserve-overlap-two",
            scopeOverride: {
                approvedBy: "octocat",
                reason: "Tasks use disjoint generated sections",
            },
        });
        assert.equal(
            override.plan.tasks[1].attempts[0].scopeOverride.approvedBy,
            "octocat",
        );
    }, {
        analysis: analysisStub({
            plan: {
                ...planBlueprint(),
				tasks: [
					...planBlueprint().tasks.slice(0, 2).map((task) => ({
						...task,
						dependsOn: [],
						expectedFiles: ["src/**"],
					})),
					{
						id: "T-003",
						title: "Integrate",
						kind: "implement",
						description: "Integrate both tasks",
						dependsOn: ["T-001", "T-002"],
						acceptanceCriteria: ["Integration is complete"],
						expectedFiles: ["src/integration.mjs"],
						deliveryRequirement: "commit",
					},
					{
						...planBlueprint().tasks[2],
						id: "T-004",
						dependsOn: ["T-003"],
					},
				],
            },
        }),
    })
));

test("verification completion rejects duplicate reservation runs", () => (
	withOperations(async ({ operations, workspacePath }) => {
		let plan = await completeImplementation(operations, workspacePath);
		const prepared = await operations.prepareVerification({
			planId: plan.id,
			expectedRevision: plan.revision,
			reservationId: "duplicate-completion",
		});
		plan = prepared.plan;
		await assert.rejects(
			operations.finishVerification({
				planId: plan.id,
				expectedRevision: plan.revision,
				runId: "first-run",
			}),
			(/** @type {any} */ error) =>
				error.code === "verification_launch_indeterminate",
		);
		await assert.rejects(
			operations.prepareVerification({
				planId: plan.id,
				expectedRevision: plan.revision,
				reservationId: "duplicate-replacement",
				replacementReason: "Attempt to override duplicate runs.",
				requestedBy: "octocat",
			}),
			(/** @type {any} */ error) =>
				error.code === "verification_duplicate_runs",
		);
	}, {
		analysis: analysisStub({
			discoverVerificationRun: async () => ({
				state: "inconclusive",
				reason: "multiple Factory runs carry the verification reservation",
				candidates: [
					{ runId: "first-run" },
					{ runId: "second-run" },
				],
			}),
		}),
	})
));

test("repeated verification preparation reports an already launched run", () => {
	const found = {
		runId: "discovered-verification",
		status: "running",
		createdAt: Date.parse("2026-08-07T00:10:00.000Z"),
	};
	return withOperations(async ({ operations, workspacePath }) => {
		let plan = await completeImplementation(operations, workspacePath);
		const first = await operations.prepareVerification({
			planId: plan.id,
			expectedRevision: plan.revision,
			reservationId: "discover-existing-run",
		});
		plan = first.plan;
		const replay = await operations.prepareVerification({
			planId: plan.id,
			expectedRevision: plan.revision - 1,
			reservationId: "discover-existing-run",
		});
		assert.equal(replay.runId, found.runId);
		assert.equal(replay.launchSpec, null);
		assert.equal(replay.plan.revision, plan.revision);
		await assert.rejects(
			operations.prepareVerification({
				planId: plan.id,
				expectedRevision: plan.revision,
				reservationId: "replacement-reservation",
			}),
			(/** @type {any} */ error) =>
				error.code === "verification_replacement_requires_approval",
		);
		await assert.rejects(
			operations.prepareVerification({
				planId: plan.id,
				expectedRevision: plan.revision,
				reservationId: "replacement-reservation",
				replacementReason: "Attempted replacement while active.",
				requestedBy: "octocat",
			}),
			(/** @type {any} */ error) =>
				error.code === "verification_already_reserved",
		);
	}, {
		analysis: analysisStub({
			discoverVerificationRun: async () => ({
				state: "found",
				run: found,
				duplicates: [],
			}),
		}),
	});
});

test("terminal non-importable verification can move to a new reservation explicitly", () => (
	withOperations(async ({ operations, workspacePath }) => {
		let plan = await completeImplementation(operations, workspacePath);
		const first = await operations.prepareVerification({
			planId: plan.id,
			expectedRevision: plan.revision,
			reservationId: "failed-reservation",
		});
		plan = first.plan;
		await assert.rejects(
			operations.prepareVerification({
				planId: plan.id,
				expectedRevision: plan.revision,
				reservationId: "replacement-reservation",
			}),
			(/** @type {any} */ error) =>
				error.code === "verification_replacement_requires_approval",
		);
		const replacement = await operations.prepareVerification({
			planId: plan.id,
			expectedRevision: plan.revision,
			reservationId: "replacement-reservation",
			replacementReason: "The previous Factory run was cancelled.",
			requestedBy: "octocat",
		});
		assert.equal(
			replacement.plan.verification.reservationId,
			"replacement-reservation",
		);
		assert.deepEqual(replacement.plan.verification.replacement, {
			supersededReservationId: "failed-reservation",
			supersededRunId: "failed-run",
			reason: "The previous Factory run was cancelled.",
			requestedBy: "octocat",
			at: replacement.plan.verification.reservedAt,
		});
		assert.equal(replacement.plan.activity.at(-1).event, "verification-replaced");
	}, {
		analysis: analysisStub({
			discoverVerificationRun: async () => ({
				state: "found",
				run: { runId: "failed-run", status: "cancelled" },
				duplicates: [],
			}),
			assessVerificationRun: async () => ({
				state: "terminal-nonimportable",
			}),
		}),
	})
));

test("verification preparation never relaunches on inconclusive discovery", () => (
	withOperations(async ({ operations, workspacePath }) => {
		let plan = await completeImplementation(operations, workspacePath);
		const first = await operations.prepareVerification({
			planId: plan.id,
			expectedRevision: plan.revision,
			reservationId: "inconclusive-prepare",
		});
		plan = first.plan;
		await assert.rejects(
			operations.prepareVerification({
				planId: plan.id,
				expectedRevision: plan.revision,
				reservationId: "inconclusive-prepare",
			}),
			(/** @type {any} */ error) =>
				error.code === "verification_launch_indeterminate"
				&& /new reservation/.test(error.message),
		);
		const replacement = await operations.prepareVerification({
			planId: plan.id,
			expectedRevision: plan.revision,
			reservationId: "inconclusive-replacement",
			replacementReason: "Factory progress remained unreadable.",
			requestedBy: "octocat",
		});
		assert.equal(
			replacement.plan.verification.replacement.supersededRunId,
			null,
		);
	}, {
		analysis: analysisStub({
			discoverVerificationRun: async () => ({
				state: "inconclusive",
				reason: "terminal run progress is unreadable",
				candidates: [{ runId: "failed-run", status: "error" }],
			}),
		}),
	})
));

test("verification replacement cannot orphan one active inconclusive run", () => (
	withOperations(async ({ operations, workspacePath }) => {
		let plan = await completeImplementation(operations, workspacePath);
		const first = await operations.prepareVerification({
			planId: plan.id,
			expectedRevision: plan.revision,
			reservationId: "active-inconclusive",
		});
		plan = first.plan;
		await assert.rejects(
			operations.prepareVerification({
				planId: plan.id,
				expectedRevision: plan.revision,
				reservationId: "active-replacement",
				replacementReason: "Progress is temporarily unreadable.",
				requestedBy: "octocat",
			}),
			(/** @type {any} */ error) =>
				error.code === "verification_already_reserved"
				&& /active-run/.test(error.message),
		);
	}, {
		analysis: analysisStub({
			discoverVerificationRun: async () => ({
				state: "inconclusive",
				reason: "active run has no readable marker yet",
				candidates: [{ runId: "active-run", status: "running" }],
			}),
		}),
	})
));

test("cancellation reconciliation prevents a launched run from being declared absent", () => {
	let launched = false;
	const found = {
		runId: "unbound-verification",
		status: "completed",
		createdAt: 0,
	};
	return withOperations(async ({ operations, workspacePath }) => {
		let plan = await completeImplementation(operations, workspacePath);
		const prepared = await operations.prepareVerification({
			planId: plan.id,
			expectedRevision: plan.revision,
			reservationId: "unbound-cancellation",
		});
		plan = prepared.plan;
		found.createdAt = Date.parse(plan.verification.reservedAt) + 1;
		plan = await operations.cancel({
			planId: plan.id,
			expectedRevision: plan.revision,
			requestId: "cancel-unbound-verification",
			reason: "Stop",
			requestedBy: "octocat",
		});
		assert.equal(plan.cancellation.verificationRunId, null);

		launched = true;
		await assert.rejects(
			operations.finalizeCancellation({
				planId: plan.id,
				expectedRevision: plan.revision,
				dispositions: [],
				verificationDisposition: "no-run-created",
				finalizedBy: "octocat",
				sessionInventory: completeInventory(),
			}),
			/bound Factory run|run-terminated/,
		);
		const latest = await operations.getPlan({ planId: plan.id });
		assert.equal(latest.cancellation.verificationRunId, null);
		const finalized = await operations.finalizeCancellation({
			planId: plan.id,
			expectedRevision: plan.revision,
			dispositions: [],
			verificationDisposition: "run-terminated",
			finalizedBy: "octocat",
			sessionInventory: completeInventory(),
		});
		assert.equal(finalized.status, PLAN_STATUS.CANCELLED);
		assert.equal(finalized.cancellation.verificationRunId, found.runId);
	}, {
		analysis: analysisStub({
			discoverVerificationRun: async () => launched
				? { state: "found", run: found, duplicates: [] }
				: { state: "absent" },
			verificationRunIsTerminal: async () => true,
		}),
	});
});

test("cancellation remains requestable when Factory discovery is inconclusive", () => (
	withOperations(async ({ operations, workspacePath }) => {
		let plan = await completeImplementation(operations, workspacePath);
		const prepared = await operations.prepareVerification({
			planId: plan.id,
			expectedRevision: plan.revision,
			reservationId: "inconclusive-cancellation",
		});
		plan = await operations.cancel({
			planId: plan.id,
			expectedRevision: prepared.plan.revision,
			requestId: "cancel-inconclusive-verification",
			reason: "Stop despite unavailable Factory observation",
			requestedBy: "octocat",
		});
		assert.equal(plan.status, PLAN_STATUS.CANCELLING);
		await assert.rejects(
			operations.finalizeCancellation({
				planId: plan.id,
				expectedRevision: plan.revision,
				dispositions: [],
				verificationDisposition: "no-run-created",
				finalizedBy: "octocat",
				sessionInventory: completeInventory(),
			}),
			(/** @type {any} */ error) =>
				error.code === "verification_launch_indeterminate",
		);
		const finalized = await operations.finalizeCancellation({
			planId: plan.id,
			expectedRevision: plan.revision,
			dispositions: [],
			verificationDisposition: "no-run-created",
			finalizationOverride: {
				reason: "Factory observation remained unavailable.",
				attestedBy: "octocat",
			},
			finalizedBy: "octocat",
			sessionInventory: completeInventory(),
		});
		assert.equal(finalized.status, PLAN_STATUS.CANCELLED);
		assert.equal(
			finalized.cancellation.finalizationOverride.attestedBy,
			"octocat",
		);
	}, {
		analysis: analysisStub({
			discoverVerificationRun: async () => ({
				state: "inconclusive",
				reason: "Factory API unavailable",
				candidates: [],
			}),
		}),
	})
));

test("cancellation request is idempotent and finalization needs exact dispositions", () => (
    withOperations(async ({ operations, workspacePath }) => {
        let plan = await createApproved(operations, workspacePath);
        const reserved = await operations.reserveTask({
            planId: plan.id,
            taskId: "T-001",
            expectedRevision: plan.revision,
            reservationId: "reserve-cancelled-task",
        });
        plan = reserved.plan;
        plan = await operations.attachTask({
            planId: plan.id,
            taskId: "T-001",
            attemptId: reserved.attemptId,
            expectedRevision: plan.revision,
            sessionId: "session-to-stop",
            branch: "work/cancelled",
        });
        const beforeCancelRevision = plan.revision;
        plan = await operations.cancel({
            planId: plan.id,
            expectedRevision: plan.revision,
            requestId: "cancel-request-id",
            reason: "User stopped the plan",
            requestedBy: "octocat",
        });
        const replay = await operations.cancel({
            planId: plan.id,
            expectedRevision: beforeCancelRevision,
            requestId: "cancel-request-id",
            reason: "User stopped the plan",
            requestedBy: "octocat",
        });
        assert.equal(replay.revision, plan.revision);
		await assert.rejects(
			operations.finalizeCancellation({
				planId: plan.id,
				expectedRevision: plan.revision,
				dispositions: null,
				finalizedBy: "octocat",
				sessionInventory: completeInventory(),
			}),
			(/** @type {any} */ error) =>
				error.code === "invalid_cancellation_dispositions",
		);
        await assert.rejects(
            operations.finalizeCancellation({
                planId: plan.id,
                expectedRevision: plan.revision,
                dispositions: [],
                finalizedBy: "octocat",
				sessionInventory: completeInventory(),
            }),
            (/** @type {any} */ error) => error.code === "cancellation_incomplete",
        );
		await assert.rejects(
			operations.finalizeCancellation({
				planId: plan.id,
				expectedRevision: plan.revision,
				dispositions: [{
					attemptId: reserved.attemptId,
					disposition: "session-terminated",
					sessionId: "session-to-stop",
				}],
				finalizedBy: "octocat",
				sessionInventory: completeInventory([{
					id: "session-to-stop",
					status: "running",
				}]),
			}),
			(/** @type {any} */ error) =>
				error.code === "cancellation_session_not_terminated",
		);
		await assert.rejects(
			operations.finalizeCancellation({
				planId: plan.id,
				expectedRevision: plan.revision,
				dispositions: [{
					attemptId: reserved.attemptId,
					disposition: "session-terminated",
					sessionId: "session-to-stop",
				}],
				finalizedBy: "octocat",
				sessionInventory: {
					complete: true,
					capturedAt: plan.cancellation.requestedAt,
					sessions: [],
				},
			}),
			(/** @type {any} */ error) =>
				error.code === "cancellation_inventory_incomplete",
		);
        plan = await operations.finalizeCancellation({
            planId: plan.id,
            expectedRevision: plan.revision,
            dispositions: [{
                attemptId: reserved.attemptId,
                disposition: "session-terminated",
                sessionId: "session-to-stop",
            }],
            finalizedBy: "octocat",
			sessionInventory: completeInventory([{
				id: "session-to-stop",
				status: "archived",
			}]),
        });
        assert.equal(plan.status, PLAN_STATUS.CANCELLED);
    })
));

test("Factory cancellation must be observed terminal before finalization", () => {
    let terminal = false;
    return withOperations(async ({ operations, workspacePath }) => {
        let plan = await createApproved(operations, workspacePath);
        ({ plan } = await runTask(operations, plan, "T-001"));
        ({ plan } = await runTask(operations, plan, "T-002"));
		({ plan } = await runTask(operations, plan, "T-003"));
        const verification = await operations.prepareVerification({
            planId: plan.id,
            expectedRevision: plan.revision,
            reservationId: "reserve-active-verification",
        });
        plan = verification.plan;
        plan = await operations.cancel({
            planId: plan.id,
            expectedRevision: plan.revision,
            requestId: "cancel-verification",
            reason: "Stop",
            requestedBy: "octocat",
        });
        await assert.rejects(
            operations.finalizeCancellation({
                planId: plan.id,
                expectedRevision: plan.revision,
                dispositions: [],
                verificationDisposition: "run-terminated",
                finalizedBy: "octocat",
				sessionInventory: completeInventory(),
            }),
            (/** @type {any} */ error) => error.code === "verification_not_terminated",
        );
		const cancelled = await operations.cancelVerificationRun({
			planId: plan.id,
			expectedRevision: plan.revision,
			requestId: "cancel-verification",
		});
		assert.equal(cancelled.runId, "active-verification");
		assert.equal(cancelled.verificationDisposition, "run-terminated");
        plan = await operations.finalizeCancellation({
            planId: plan.id,
            expectedRevision: plan.revision,
            dispositions: [],
            verificationDisposition: "run-terminated",
            finalizedBy: "octocat",
			sessionInventory: completeInventory(),
        });
        assert.equal(plan.status, PLAN_STATUS.CANCELLED);
    }, {
        analysis: analysisStub({
			discoverVerificationRun: async () => ({
				state: "found",
				run: {
					runId: "active-verification",
					status: "running",
					createdAt: Date.now(),
				},
				duplicates: [],
			}),
			cancelVerificationRun: async (runId) => {
				terminal = true;
				return { runId, status: "cancelled", alreadyTerminal: false };
			},
			verificationRunIsTerminal: async () => terminal,
        }),
    });
});

test("late verification discovery is persisted before Factory cancellation", () => {
	let discoveryState = "absent";
	return withOperations(async ({ operations, workspacePath }) => {
		let plan = await completeImplementation(operations, workspacePath);
		plan = (await operations.prepareVerification({
			planId: plan.id,
			expectedRevision: plan.revision,
			reservationId: "late-discovery-reservation",
		})).plan;
		plan = await operations.cancel({
			planId: plan.id,
			expectedRevision: plan.revision,
			requestId: "late-discovery-cancellation",
			reason: "Stop after launch",
			requestedBy: "octocat",
		});
		assert.equal(plan.cancellation.verificationRunId, null);

		discoveryState = "found";
		const cancelled = await operations.cancelVerificationRun({
			planId: plan.id,
			expectedRevision: plan.revision,
			requestId: "late-discovery-cancellation",
		});
		assert.equal(cancelled.runId, "late-verification-run");
		assert.equal(cancelled.revision, plan.revision + 1);
		assert.equal(
			(await operations.getPlan({ planId: plan.id }))
				.cancellation.verificationRunId,
			"late-verification-run",
		);

		discoveryState = "inconclusive";
		const finalized = await operations.finalizeCancellation({
			planId: plan.id,
			expectedRevision: cancelled.revision,
			dispositions: [],
			verificationDisposition: "run-terminated",
			finalizedBy: "octocat",
			sessionInventory: completeInventory(),
		});
		assert.equal(finalized.status, PLAN_STATUS.CANCELLED);
		assert.equal(
			finalized.cancellation.verificationRunId,
			"late-verification-run",
		);
	}, {
		analysis: analysisStub({
			discoverVerificationRun: async () => {
				if (discoveryState === "found") {
					return {
						state: "found",
						run: {
							runId: "late-verification-run",
							status: "running",
							createdAt: Date.now(),
						},
						duplicates: [],
					};
				}
				if (discoveryState === "inconclusive") {
					return {
						state: "inconclusive",
						reason: "progress unavailable",
						candidates: [],
					};
				}
				return { state: "absent" };
			},
		}),
	});
});

test("cancellation resolves a verification launch reserved before the Factory starts", () => (
    withOperations(async ({ operations, workspacePath }) => {
        let plan = await createApproved(operations, workspacePath);
        ({ plan } = await runTask(operations, plan, "T-001"));
        ({ plan } = await runTask(operations, plan, "T-002"));
		({ plan } = await runTask(operations, plan, "T-003"));
        const verification = await operations.prepareVerification({
            planId: plan.id,
            expectedRevision: plan.revision,
            reservationId: "reserve-cancelled-launch",
        });
        plan = verification.plan;
        plan = await operations.cancel({
            planId: plan.id,
            expectedRevision: plan.revision,
			requestId: "cancel-before-factory",
            reason: "Do not launch verification",
            requestedBy: "octocat",
        });
        assert.equal(
            (await operations.getStatus({ planId: plan.id })).projection.nextAction.kind,
            "resolve-verification-launch",
        );
		await assert.rejects(
			operations.prepareVerification({
				planId: plan.id,
				expectedRevision: plan.revision,
				reservationId: "reserve-cancelled-launch",
			}),
			(/** @type {any} */ error) =>
				error.code === "invalid_plan_transition",
		);
        await assert.rejects(
            operations.finalizeCancellation({
                planId: plan.id,
                expectedRevision: plan.revision,
                dispositions: [],
                finalizedBy: "octocat",
				sessionInventory: completeInventory(),
            }),
            (/** @type {any} */ error) => error.code === "cancellation_incomplete",
        );
        plan = await operations.finalizeCancellation({
            planId: plan.id,
            expectedRevision: plan.revision,
            dispositions: [],
            verificationDisposition: "no-run-created",
            finalizedBy: "octocat",
			sessionInventory: completeInventory(),
        });
        assert.equal(plan.status, PLAN_STATUS.CANCELLED);
        assert.equal(plan.cancellation.verificationDisposition, "no-run-created");
    })
));

test("failed verification retry opens a fresh correction wave", () => (
    withOperations(async ({ operations, workspacePath }) => {
        let plan = await createApproved(operations, workspacePath);
        ({ plan } = await runTask(operations, plan, "T-001"));
        ({ plan } = await runTask(operations, plan, "T-002"));
		({ plan } = await runTask(operations, plan, "T-003"));
        const verification = await operations.prepareVerification({
            planId: plan.id,
            expectedRevision: plan.revision,
            reservationId: "reserve-failed-verification",
        });
        plan = verification.plan;
        plan = await operations.finishVerification({
            planId: plan.id,
            expectedRevision: plan.revision,
            runId: "failed-verification",
        });
        assert.equal(plan.status, PLAN_STATUS.FAILED);
        plan = await operations.approve({
            planId: plan.id,
            expectedRevision: plan.revision,
            approvedBy: "octocat",
            approvalType: "retry",
            retryStatus: PLAN_STATUS.RUNNING,
        });
        assert.equal(plan.tasks[0].status, TASK_STATUS.READY);
        assert.equal(plan.tasks[1].status, TASK_STATUS.PLANNED);
        assert.equal(plan.tasks[0].attempts.length, 1);
    }, {
        analysis: analysisStub({
			discoverVerificationRun: async () => ({
				state: "found",
				run: { runId: "failed-verification", status: "completed" },
				duplicates: [],
			}),
            verificationResult: {
                passed: false,
                summary: "Foundation evidence missing",
                evidence: ["T-001-A001-E001"],
                missingEvidence: ["No evidence mapped for T-001-C001"],
                correctionTaskIds: ["T-001"],
            },
        }),
    })
));

test("status projection distinguishes unknown from complete-inventory absence", () => (
    withOperations(async ({ operations, workspacePath }) => {
        let plan = await createApproved(operations, workspacePath);
        const reserved = await operations.reserveTask({
            planId: plan.id,
            taskId: "T-001",
            expectedRevision: plan.revision,
            reservationId: "reserve-projection",
        });
        plan = await operations.attachTask({
            planId: plan.id,
            taskId: "T-001",
            attemptId: reserved.attemptId,
            expectedRevision: reserved.plan.revision,
            sessionId: "session-projection",
        });
        const unknown = await operations.getStatus({ planId: plan.id });
        assert.equal(unknown.projection.activeAttempts[0].sessionState, "unknown");
        const absent = await operations.getStatus({
            planId: plan.id,
            sessionInventory: {
                complete: true,
                capturedAt: "2099-01-01T00:00:00.000Z",
                sessions: [],
            },
        });
        assert.equal(absent.projection.activeAttempts[0].sessionState, "absent");
        assert.equal(absent.projection.nextAction.kind, "inspect-missing-session");
    })
));

test("plan guardrails require explicit session-local activation", () => (
    withOperations(async ({ operations, workspacePath }) => {
        const plan = await operations.createPlan(createInput(workspacePath));
        assert.equal(await operations.getActive(), null);
        const marker = await operations.activate({
            planId: plan.id,
            expectedRevision: plan.revision,
        });
        assert.equal(marker.planId, plan.id);
		const persistedMarker = JSON.parse(await readFile(
			path.join(workspacePath, "files", "foundry", ".active-plan.json"),
			"utf8",
		));
		assert.deepEqual(Object.keys(persistedMarker).sort(), ["activatedAt", "planId"]);
        assert.equal((await operations.getActive()).plan.id, plan.id);
		assert.deepEqual(await operations.deactivate(), {
			deactivated: true,
			planId: plan.id,
			repaired: false,
		});
        assert.equal(await operations.getActive(), null);

		const markerPath = path.join(
			workspacePath,
			"files",
			"foundry",
			".active-plan.json",
		);
		await writeFile(markerPath, JSON.stringify({
			...persistedMarker,
			unsupported: true,
		}), "utf8");
		await assert.rejects(
			operations.getActive(),
			(/** @type {any} */ error) => error.code === "activation_invalid",
		);
		assert.deepEqual(await operations.deactivate(), {
			deactivated: true,
			planId: null,
			repaired: true,
		});
		assert.equal(await operations.getActive(), null);

		await writeFile(markerPath, JSON.stringify({
			planId: "../invalid",
			activatedAt: persistedMarker.activatedAt,
		}), "utf8");
		await assert.rejects(
			operations.getActive(),
			(/** @type {any} */ error) => error.code === "invalid_plan_id",
		);
		assert.equal((await operations.deactivate()).repaired, true);

		const markerTarget = path.join(workspacePath, "marker-target.json");
		await writeFile(markerTarget, JSON.stringify(persistedMarker), "utf8");
		await symlink(markerTarget, markerPath);
		await assert.rejects(
			operations.getActive(),
			(/** @type {any} */ error) => error.code === "artifact_unsafe",
		);
		assert.equal((await operations.deactivate()).repaired, true);
		assert.equal(JSON.parse(await readFile(markerTarget, "utf8")).planId, plan.id);
    })
));
