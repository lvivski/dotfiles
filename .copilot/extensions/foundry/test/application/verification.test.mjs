import assert from "node:assert/strict";
import test from "node:test";
import { errorCode, errorMessage, isRecord } from "../../data.mjs";
import { buildVerificationInput } from "../../analysis/verification.mjs";
import { PLAN_STATUS, TASK_STATUS } from "../../plan/values.mjs";
import { completed } from "../assertions.mjs";
import { analysisStub, completeImplementation, createApproved, runTask, withOperations } from "./fixture.mjs";

/** @typedef {import("../../types/workflow.js").WorkflowAnalysisPort} AnalysisPort */

test("pending verification retains its unique binding and resumes without another launch", async () => {
	let active = true;
	const base = analysisStub({
		discoverVerificationRun: async () => ({ state: "found", run: { runId: "pending-verification", status: active ? "running" : "completed" } }),
	});
	await withOperations(async ({ operations, workspacePath }) => {
		const original = await completeImplementation(operations, workspacePath);
		const prepared = await operations.prepareVerification({
			planId: original.id, expectedRevision: original.revision, reservationId: "pending-import-reservation",
		});
		const pending = await operations.finishVerification({
			planId: original.id, expectedRevision: prepared.plan.revision, runId: "pending-verification",
		});
		assert.ok("state" in pending);
		assert.equal(pending.state, "pending");
		const retained = await operations.getPlan({ planId: original.id });
		assert.equal(retained.verification.status, "reserved");
		assert.equal(retained.verification.runId, "pending-verification");
		assert.equal(pending.revision, retained.revision);
		const replay = await operations.prepareVerification({
			planId: original.id, expectedRevision: retained.revision, reservationId: "pending-import-reservation",
		});
		assert.equal(replay.launchSpec, null);
		active = false;
		const finished = completed(await operations.finishVerification({
			planId: original.id, expectedRevision: retained.revision, runId: "pending-verification",
		}));
		assert.equal(finished.status, PLAN_STATUS.AWAITING_COMPLETION_APPROVAL);
	}, { analysis: { ...base, importVerification: (runId, plan) => active
		? Promise.resolve({ state: "pending", runId, status: "running", workflowName: "verify", resumeOn: "completion-notification" })
		: base.importVerification(runId, plan) } });
});

test("verification preparation isolates the frozen context and combined delivery from analysis mutation", async () => {
	/** @type {AnalysisPort} */
	const analysis = {
		...analysisStub(),
		async prepareVerification(plan, reservationId) {
			const input = buildVerificationInput(plan);
			assert.deepEqual(input.tasks.map((task) => task.id), ["T-001", "T-002"]);
			assert.equal(input.verificationReport.target.taskId, "T-002");
			assert.equal(new Set(input.tasks.map((task) => task.evidence[0].producer)).size, 2);
			assert.ok(plan.factoryVerification);
			assert.ok(isRecord(plan.factoryVerification.definitions));
			assert.ok(isRecord(plan.factoryVerification.definitions.unit));
			plan.factoryVerification.definitions.unit.purpose = "Analysis must not replace the reserved governing snapshot";
			plan.tasks[1].attempts[0].commit = "0".repeat(40);
			return { workflow: "verify", inputDigest: input.inputDigest, launchSpec: { name: "verify", args: { ...input, reservationId } } };
		},
	};
	await withOperations(async ({ operations, workspacePath }) => {
		const plan = await completeImplementation(operations, workspacePath);
		const prepared = await operations.prepareVerification({
			planId: plan.id, expectedRevision: plan.revision, reservationId: "isolated-canonical-input",
		});
		const canonical = buildVerificationInput(prepared.plan);
		assert.equal(prepared.inputDigest, canonical.inputDigest);
		assert.deepEqual(prepared.launchSpec?.args, { ...canonical, reservationId: "isolated-canonical-input" });
		const replay = await operations.prepareVerification({
			planId: plan.id, expectedRevision: plan.revision, reservationId: "isolated-canonical-input",
		});
		assert.equal(replay.inputDigest, prepared.inputDigest);
		assert.deepEqual(replay.launchSpec, prepared.launchSpec);
		assert.deepEqual(buildVerificationInput(replay.plan), canonical);
		assert.deepEqual(buildVerificationInput(await operations.getPlan({ planId: plan.id })), canonical);
	}, { analysis });
});

test("verification revalidates ownership, revision, and interruption after waiting", async (t) => {
	for (const change of ["ownership", "revision", "interrupted"]) {
		await t.test(change, async () => {
			const controller = new AbortController();
			const interrupted = new Error("Import interrupted");
			let unique = true;
			/** @type {(plan: import("../../types/plan.js").FoundryPlan) => Promise<void>} */
			let duringImport = async (_plan) => { };
			const base = analysisStub({
				discoverVerificationRun: async () => unique
					? { state: "found", run: { runId: "verify-run", status: "running" }, duplicates: [] }
					: { state: "inconclusive", reason: "A duplicate run appeared" },
			});
			/** @type {AnalysisPort} */
			const analysis = {
				...base,
				async importVerification(runId, plan, { signal } = {}) {
					assert.equal(signal, controller.signal);
					await duringImport(plan);
					return base.importVerification(runId, plan);
				},
			};
			await withOperations(async ({ operations, workspacePath }) => {
				let plan = await completeImplementation(operations, workspacePath);
				({ plan } = await operations.prepareVerification({
					planId: plan.id, expectedRevision: plan.revision, reservationId: "wait-reservation",
				}));
				duringImport = async (snapshot) => {
					if (change === "ownership") unique = false;
					if (change === "interrupted") controller.abort(interrupted);
					if (change === "revision") {
						await operations.storeFor().update(snapshot.id, snapshot.revision, {
							...snapshot, title: "Concurrent update",
						});
					}
				};
				const importing = operations.finishVerification({
					planId: plan.id, expectedRevision: plan.revision, runId: "verify-run",
				}, { signal: controller.signal });
				await assert.rejects(importing, change === "interrupted"
					? (error) => error === interrupted
					: { code: change === "revision" ? "revision_conflict" : "verification_launch_indeterminate" });
				const persisted = await operations.getPlan({ planId: plan.id });
				assert.equal(persisted.status, plan.status);
				assert.equal(persisted.revision, plan.revision + (change === "revision" ? 2 : 1));
				assert.equal(persisted.verification.status, "reserved");
				assert.equal(persisted.verification.runId, "verify-run");
			}, { analysis });
		});
	}
});

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
			(/** @type {unknown} */ error) =>
				errorCode(error) === "verification_launch_indeterminate",
		);
		await assert.rejects(
			operations.prepareVerification({
				planId: plan.id,
				expectedRevision: plan.revision,
				reservationId: "duplicate-replacement",
				replacementReason: "Attempt to override duplicate runs.",
				requestedBy: "octocat",
			}),
			(/** @type {unknown} */ error) =>
				errorCode(error) === "verification_duplicate_runs",
		);
	}, {
		analysis: analysisStub({
			discoverVerificationRun: async () => ({
				state: "inconclusive",
				reason: "multiple Workflow runs carry the verification reservation",
				candidates: [
					{ runId: "first-run" },
					{ runId: "second-run" },
				],
			}),
		}),
	})
));

for (const state of /** @type {const} */ (["active", "paused"])) test(`repeated verification preparation preserves ${state} runs`, () => {
	const found = {
		runId: "discovered-verification",
		status: state === "active" ? "running" : "paused",
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
		assert.ok("runId" in replay);
		assert.equal(replay.runId, found.runId);
		assert.equal(replay.launchSpec, null);
		assert.equal(replay.plan.revision, plan.revision + 1);
		assert.equal(replay.plan.verification.runId, found.runId);
		plan = replay.plan;
		const rebound = await operations.prepareVerification({
			planId: plan.id, expectedRevision: plan.revision, reservationId: "discover-existing-run",
		});
		assert.equal(rebound.plan.revision, plan.revision);
		await assert.rejects(
			operations.prepareVerification({
				planId: plan.id,
				expectedRevision: plan.revision,
				reservationId: "replacement-reservation",
			}),
			(/** @type {unknown} */ error) =>
				errorCode(error) === "verification_replacement_requires_approval",
		);
		await assert.rejects(
			operations.prepareVerification({
				planId: plan.id,
				expectedRevision: plan.revision,
				reservationId: "replacement-reservation",
				replacementReason: "Attempted replacement while active.",
				requestedBy: "octocat",
			}),
			(/** @type {unknown} */ error) =>
				errorCode(error) === "verification_already_reserved",
		);
	}, {
		analysis: analysisStub({
			discoverVerificationRun: async () => ({
				state: "found",
				run: found,
				duplicates: [],
			}),
			assessVerificationRun: async () => ({ state }),
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
		const replacementReason = ` \t${"Complete original diagnostic \u2014 \u65e5\u672c\u8a9e\n".repeat(1000)} `;
		const requestedBy = ` ${"requesting-actor".repeat(100)} `;
		await assert.rejects(
			operations.prepareVerification({
				planId: plan.id,
				expectedRevision: plan.revision,
				reservationId: "replacement-reservation",
			}),
			(/** @type {unknown} */ error) =>
				errorCode(error) === "verification_replacement_requires_approval",
		);
		const replacement = await operations.prepareVerification({
			planId: plan.id,
			expectedRevision: plan.revision,
			reservationId: "replacement-reservation",
			replacementReason,
			requestedBy,
		});
		assert.equal(
			replacement.plan.verification.reservationId,
			"replacement-reservation",
		);
		assert.deepEqual(replacement.plan.verification.replacement, {
			supersededReservationId: "failed-reservation",
			supersededRunId: "failed-run",
			reason: replacementReason,
			requestedBy,
			at: replacement.plan.verification.reservedAt,
		});
		assert.equal(replacement.plan.activity.at(-1)?.event, "verification-replaced");
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

for (const candidates of [[], [{ runId: "failed-run", status: "error" }]]) test("verification preparation never relaunches on inconclusive discovery", () => (
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
			(/** @type {unknown} */ error) =>
				errorCode(error) === "verification_launch_indeterminate",
		);
		await assert.rejects(operations.prepareVerification({
			planId: plan.id,
			expectedRevision: plan.revision,
			reservationId: "inconclusive-replacement",
			replacementReason: "Workflow progress remained unreadable.",
			requestedBy: "octocat",
		}), { code: "verification_launch_indeterminate" });
		assert.equal((await operations.getPlan({ planId: plan.id })).verification.reservationId, "inconclusive-prepare");
	}, {
		analysis: analysisStub({
			discoverVerificationRun: async () => ({
				state: "inconclusive",
				reason: "terminal run progress is unreadable",
				candidates,
			}),
		}),
	})
));

for (const status of ["running", "paused"]) test(`verification replacement cannot orphan a ${status} inconclusive run`, () => (
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
			(/** @type {unknown} */ error) =>
				errorCode(error) === "verification_already_reserved"
				&& /active-run/.test(errorMessage(error)),
		);
	}, {
		analysis: analysisStub({
			discoverVerificationRun: async () => ({
				state: "inconclusive",
				reason: "active run has no readable marker yet",
				candidates: [{ runId: "active-run", status }],
			}),
		}),
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
		plan = completed(await operations.finishVerification({
			planId: plan.id,
			expectedRevision: plan.revision,
			runId: "failed-verification",
		}));
		assert.equal(plan.status, PLAN_STATUS.FAILED);
		plan = await operations.approve({
			planId: plan.id,
			expectedRevision: plan.revision,
			approvedBy: "octocat",
			approvalType: "retry",
			retryStatus: PLAN_STATUS.RUNNING,
		});
		assert.equal(plan.tasks[0].status, TASK_STATUS.PLANNED);
		assert.deepEqual((await operations.getStatus({ planId: plan.id })).projection.scheduling.readyTaskIds, ["T-001"]);
		assert.equal(plan.tasks[1].status, TASK_STATUS.PLANNED);
		assert.equal(plan.tasks[0].attempts.length, 1);
		assert.equal(plan.activity.at(-1)?.actor, "octocat");
		assert.equal(plan.activity.at(-1)?.verificationRunId, "failed-verification");
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
