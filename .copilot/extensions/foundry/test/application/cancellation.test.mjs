import assert from "node:assert/strict";
import test from "node:test";
import { errorCode } from "../../data.mjs";
import { PLAN_STATUS } from "../../plan/values.mjs";
import { must } from "../assertions.mjs";
import { analysisStub, completeImplementation, completeInventory, createApproved, runTask, withOperations } from "./fixture.mjs";

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
		analysis: analysisStub({
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
		analysis: analysisStub({
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
					status,
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
