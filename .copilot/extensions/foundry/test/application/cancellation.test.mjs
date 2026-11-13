import assert from "node:assert/strict";
import test from "node:test";
import { errorCode } from "../../data.mjs";
import { PLAN_STATUS } from "../../plan/values.mjs";
import { createWorkflowAnalysis } from "../../workflow.mjs";
import { must } from "../assertions.mjs";
import { fakeApi } from "../native/api.mjs";
import { analysisStub, completeImplementation, completeInventory, createApproved, runTask, withOperations } from "./fixture.mjs";

/** @param {Parameters<typeof analysisStub>[0]} [options] */
function cancellationAnalysis(options = {}) {
	const analysis = analysisStub(options);
	analysis.inspectWorkflow = async runId => {
		const status = await analysis.verificationRunIsTerminal(runId) ? "cancelled" : "running";
		return createWorkflowAnalysis(() => fakeApi({
			[runId]: { workflowName: "verify", run: { runId, status } },
		})).inspectWorkflow(runId);
	};
	return analysis;
}

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
		found.createdAt = Date.parse(must(plan.verification.reservedAt)) + 1;
		plan = await operations.cancel({
			planId: plan.id,
			expectedRevision: plan.revision,
			requestId: "cancel-unbound-verification",
			reason: "Stop",
			requestedBy: "octocat",
		});
		assert.equal(plan.cancellation?.verificationRunId, null);

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
			/bound Workflow run|run-terminated/,
		);
		const latest = await operations.getPlan({ planId: plan.id });
		assert.equal(latest.cancellation?.verificationRunId, null);
		const finalized = await operations.finalizeCancellation({
			planId: plan.id,
			expectedRevision: plan.revision,
			dispositions: [],
			verificationDisposition: "run-terminated",
			finalizedBy: "octocat",
			sessionInventory: completeInventory(),
		});
		assert.equal(finalized.status, PLAN_STATUS.CANCELLED);
		assert.equal(finalized.cancellation?.verificationRunId, found.runId);
	}, {
		analysis: cancellationAnalysis({
			discoverVerificationRun: async () => launched
				? { state: "found", run: found, duplicates: [] }
				: { state: "absent" },
			verificationRunIsTerminal: async () => true,
		}),
	});
});

test("cancellation remains requestable when Workflow discovery is inconclusive", () => (
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
			reason: "Stop despite unavailable Workflow observation",
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
			(/** @type {unknown} */ error) =>
				errorCode(error) === "verification_launch_indeterminate",
		);
		const finalized = await operations.finalizeCancellation({
			planId: plan.id,
			expectedRevision: plan.revision,
			dispositions: [],
			verificationDisposition: "no-run-created",
			finalizationOverride: {
				reason: "Workflow observation remained unavailable.",
				attestedBy: "octocat",
			},
			finalizedBy: "octocat",
			sessionInventory: completeInventory(),
		});
		assert.equal(finalized.status, PLAN_STATUS.CANCELLED);
		assert.equal(
			finalized.cancellation?.finalizationOverride?.attestedBy,
			"octocat",
		);
	}, {
		analysis: cancellationAnalysis({
			discoverVerificationRun: async () => ({
				state: "inconclusive",
				reason: "Workflow API unavailable",
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
			(/** @type {unknown} */ error) =>
				errorCode(error) === "invalid_cancellation_dispositions",
		);
		await assert.rejects(
			operations.finalizeCancellation({
				planId: plan.id,
				expectedRevision: plan.revision,
				dispositions: [],
				finalizedBy: "octocat",
				sessionInventory: completeInventory(),
			}),
			(/** @type {unknown} */ error) => errorCode(error) === "cancellation_incomplete",
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
			(/** @type {unknown} */ error) =>
				errorCode(error) === "cancellation_session_not_terminated",
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
					capturedAt: must(plan.cancellation).requestedAt,
					sessions: [],
				},
			}),
			(/** @type {unknown} */ error) =>
				errorCode(error) === "cancellation_inventory_incomplete",
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

for (const status of ["running", "paused"]) test(`${status} Workflow runs require cancellation before finalization`, () => {
	let terminal = false;
	const analysis = analysisStub({
		discoverVerificationRun: async () => ({
			state: "found",
			run: {
				runId: "active-verification",
				status,
				createdAt: Date.now(),
			},
			duplicates: [],
		}),
		cancelVerificationRun: async (runId) => {
			terminal = true;
			return { runId, status: "cancelled", alreadyTerminal: false };
		},
		verificationRunIsTerminal: async () => assert.fail("Cancellation must inspect the run's identity and status"),
	});
	analysis.inspectWorkflow = createWorkflowAnalysis(() => fakeApi({
		"active-verification": {
			workflowName: "verify",
			run: { runId: "active-verification", status: terminal ? "cancelled" : status },
		},
	})).inspectWorkflow;
	/** @type {import("@github/copilot-sdk").WorkflowRunStatus[]} */
	const classifiedStatuses = [];
	const isTerminalWorkflowStatus = analysis.isTerminalWorkflowStatus;
	analysis.isTerminalWorkflowStatus = observedStatus => {
		classifiedStatuses.push(observedStatus);
		return isTerminalWorkflowStatus(observedStatus);
	};
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
			(/** @type {unknown} */ error) => errorCode(error) === "verification_not_terminated",
		);
		assert.deepEqual(classifiedStatuses, [status]);
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
		assert.deepEqual(classifiedStatuses, [status, "cancelled"]);
	}, { analysis });
});

test("cancellation classifies missing inspections through the workflow port and propagates unrelated errors", () => {
	/** @type {unknown} */
	let inspectionError;
	/** @type {unknown[]} */
	const classifiedErrors = [];
	const analysis = analysisStub({
		discoverVerificationRun: async () => ({ state: "found", run: { runId: "missing-verification", status: "running" } }),
		verificationRunIsTerminal: async () => assert.fail("A missing observation is not terminal evidence"),
	});
	analysis.inspectWorkflow = async () => { throw inspectionError; };
	const isMissingWorkflowRun = analysis.isMissingWorkflowRun;
	analysis.isMissingWorkflowRun = error => {
		classifiedErrors.push(error);
		return isMissingWorkflowRun(error);
	};
	analysis.isTerminalWorkflowStatus = () => assert.fail("A missing observation has no status to classify");
	return withOperations(async ({ operations, workspacePath }) => {
		let plan = await completeImplementation(operations, workspacePath);
		plan = (await operations.prepareVerification({
			planId: plan.id, expectedRevision: plan.revision, reservationId: "missing-observation-reservation",
		})).plan;
		plan = await operations.cancel({
			planId: plan.id, expectedRevision: plan.revision, requestId: "missing-observation-cancel",
			reason: "Stop owned workflow", requestedBy: "octocat",
		});
		const finalization = {
			planId: plan.id, expectedRevision: plan.revision, dispositions: [], finalizedBy: "octocat",
			verificationDisposition: "run-terminated", sessionInventory: completeInventory(),
		};
		const missingErrors = [
			Object.assign(new Error("Inspection failed"), { code: "workflow_run_not_found" }),
			{ data: { code: "not_found" } },
			new Error("Inspection failed", { cause: { code: "not_found" } }),
			new Error("Inspection failed", { cause: { data: { code: "workflow_run_not_found" } } }),
			new Error("Workflow run missing-verification not found"),
		];
		for (inspectionError of missingErrors) {
			await assert.rejects(operations.finalizeCancellation(finalization), { code: "verification_not_terminated" });
		}
		const unrelatedErrors = [
			new Error("Workflow backend unavailable"),
			Object.assign(new Error("Unrelated object not found"), { code: "permission_denied" }),
		];
		for (inspectionError of unrelatedErrors) {
			await assert.rejects(operations.finalizeCancellation(finalization), error => error === inspectionError);
		}
		assert.deepEqual(classifiedErrors, [...missingErrors, ...unrelatedErrors]);
		assert.deepEqual(await operations.getPlan({ planId: plan.id }), plan);
	}, { analysis });
});

for (const status of ["completed", "error", "halted", "cancelled"]) test(`a matching ${status} observation finalizes cancellation`, () => {
	const analysis = analysisStub({
		discoverVerificationRun: async () => ({ state: "found", run: { runId: "terminal-verification", status } }),
		verificationRunIsTerminal: async () => assert.fail("Cancellation must inspect the run's identity and status"),
	});
	analysis.inspectWorkflow = createWorkflowAnalysis(() => fakeApi({
		"terminal-verification": { workflowName: "verify", run: { runId: "terminal-verification", status } },
	})).inspectWorkflow;
	return withOperations(async ({ operations, workspacePath }) => {
		let plan = await completeImplementation(operations, workspacePath);
		plan = (await operations.prepareVerification({
			planId: plan.id, expectedRevision: plan.revision, reservationId: "terminal-observation-reservation",
		})).plan;
		plan = await operations.cancel({
			planId: plan.id, expectedRevision: plan.revision, requestId: "terminal-observation-cancel",
			reason: "Stop owned workflow", requestedBy: "octocat",
		});
		const finalized = await operations.finalizeCancellation({
			planId: plan.id, expectedRevision: plan.revision, dispositions: [], finalizedBy: "octocat",
			verificationDisposition: "run-terminated", sessionInventory: completeInventory(),
		});
		assert.equal(finalized.status, PLAN_STATUS.CANCELLED);
		assert.equal(finalized.cancellation?.verificationRunId, "terminal-verification");
	}, { analysis });
});

test("late verification discovery is persisted before Workflow cancellation", () => {
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
		assert.equal(plan.cancellation?.verificationRunId, null);

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
				.cancellation?.verificationRunId,
			"late-verification-run",
		);

		discoveryState = "inconclusive";
		const finalization = {
			planId: plan.id,
			expectedRevision: cancelled.revision,
			dispositions: [],
			verificationDisposition: "run-terminated",
			finalizedBy: "octocat",
			sessionInventory: completeInventory(),
		};
		await assert.rejects(operations.finalizeCancellation(finalization), {
			code: "verification_launch_indeterminate",
		});
		const finalized = await operations.finalizeCancellation({
			...finalization,
			finalizationOverride: {
				reason: "Explicitly accept inconclusive Workflow discovery",
				attestedBy: "octocat",
			},
		});
		assert.equal(finalized.status, PLAN_STATUS.CANCELLED);
		assert.equal(
			finalized.cancellation?.verificationRunId,
			"late-verification-run",
		);
	}, {
		analysis: cancellationAnalysis({
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

test("cancellation resolves a verification launch reserved before the Workflow starts", () => (
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
			requestId: "cancel-before-workflow",
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
			(/** @type {unknown} */ error) =>
				errorCode(error) === "invalid_plan_transition",
		);
		await assert.rejects(
			operations.finalizeCancellation({
				planId: plan.id,
				expectedRevision: plan.revision,
				dispositions: [],
				finalizedBy: "octocat",
				sessionInventory: completeInventory(),
			}),
			(/** @type {unknown} */ error) => errorCode(error) === "cancellation_incomplete",
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
		assert.equal(plan.cancellation?.verificationDisposition, "no-run-created");
	})
));

test("parallel cancellation requests and exact finalization callbacks retain one result", () => (
	withOperations(async ({ operations, workspacePath }) => {
		const approved = await createApproved(operations, workspacePath);
		const reserved = await operations.reserveTask({
			planId: approved.id, taskId: "T-001", expectedRevision: approved.revision, reservationId: "parallel-cancel-reservation",
		});
		const request = {
			planId: reserved.plan.id, expectedRevision: reserved.plan.revision, requestId: "parallel-cancel",
			reason: "Stop owned work", requestedBy: "octocat",
		};
		const [left, right] = await Promise.all([operations.cancel(request), operations.cancel(request)]);
		assert.equal(left.revision, right.revision);
		const finalization = {
			planId: left.id, expectedRevision: left.revision,
			dispositions: [{ attemptId: reserved.attemptId, disposition: "no-session-created", sessionId: null }],
			finalizedBy: "octocat", sessionInventory: completeInventory(),
		};
		const [first, duplicate] = await Promise.all([
			operations.finalizeCancellation(finalization), operations.finalizeCancellation(finalization),
		]);
		assert.deepEqual(duplicate, first);
		assert.deepEqual(await operations.finalizeCancellation(finalization), first);
		await assert.rejects(operations.finalizeCancellation({ ...finalization, finalizedBy: "different-actor" }), { code: "revision_conflict" });
		await assert.rejects(operations.finalizeCancellation({
			...finalization, dispositions: [{ ...finalization.dispositions[0], unexpected: "not-an-exact-replay" }],
		}), { code: "revision_conflict" });
	})
));

test("complete session-list absence cannot finalize a known attached child", () => (
	withOperations(async ({ operations, workspacePath }) => {
		const approved = await createApproved(operations, workspacePath);
		const reserved = await operations.reserveTask({
			planId: approved.id, taskId: "T-001", expectedRevision: approved.revision, reservationId: "missing-child-reservation",
		});
		const attached = await operations.attachTask({
			planId: approved.id, taskId: "T-001", attemptId: reserved.attemptId,
			expectedRevision: reserved.plan.revision, sessionId: "missing-child", branch: "work/missing",
		});
		const cancelling = await operations.cancel({
			planId: approved.id, expectedRevision: attached.revision, requestId: "cancel-missing-child",
			reason: "Preserve unknown external work", requestedBy: "octocat",
		});
		for (const sessions of [[], [{ id: "missing-child", status: "idle" }]]) {
			await assert.rejects(operations.finalizeCancellation({
				planId: approved.id, expectedRevision: cancelling.revision,
				dispositions: [{ attemptId: reserved.attemptId, disposition: "session-terminated", sessionId: "missing-child" }],
				finalizedBy: "octocat", sessionInventory: completeInventory(sessions),
			}), { code: "cancellation_session_not_terminated" });
		}
		assert.equal((await operations.getPlan({ planId: approved.id })).status, PLAN_STATUS.CANCELLING);
	})
));

for (const mismatch of ["run", "workflow"]) test(`terminal ${mismatch} mismatch cannot finalize even with an explicit override`, () => {
	const analysis = cancellationAnalysis({
		discoverVerificationRun: async () => ({ state: "found", run: { runId: "owned-verification", status: "running" } }),
	});
	const inspect = analysis.inspectWorkflow;
	analysis.inspectWorkflow = async runId => ({
		...await inspect(runId),
		...(mismatch === "run" ? { runId: "foreign-run" } : { workflowName: "plan" }),
	});
	return withOperations(async ({ operations, workspacePath }) => {
		let plan = await completeImplementation(operations, workspacePath);
		plan = (await operations.prepareVerification({
			planId: plan.id, expectedRevision: plan.revision, reservationId: "identity-reservation",
		})).plan;
		plan = await operations.cancel({
			planId: plan.id, expectedRevision: plan.revision, requestId: "identity-cancel", reason: "Stop owned workflow", requestedBy: "octocat",
		});
		await assert.rejects(operations.finalizeCancellation({
			planId: plan.id, expectedRevision: plan.revision, dispositions: [], finalizedBy: "octocat",
			verificationDisposition: "run-terminated", sessionInventory: completeInventory(),
			finalizationOverride: { attestedBy: "octocat", reason: "Cannot authorize another run" },
		}), { code: "workflow_run_identity_mismatch" });
		assert.equal((await operations.getPlan({ planId: plan.id })).status, PLAN_STATUS.CANCELLING);
	}, { analysis });
});
