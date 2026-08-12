import assert from "node:assert/strict";
import test from "node:test";

import {
    PLAN_STATUS,
    approvePlan,
    attachTaskAttempt,
    createDraftPlan,
    requestPlanCancellation,
    reserveTaskAttempt,
    transitionPlan,
} from "./domain.mjs";
import { normalizeInventory } from "./inventory.mjs";
import { projectPlan } from "./projection.mjs";

test("inventory accepts omitted timestamps as unknown", () => {
    const omitted = normalizeInventory({ complete: false, sessions: [] });
    const explicit = normalizeInventory({
		complete: false,
		capturedAt: null,
		sessions: [],
    });
    assert.equal(omitted.capturedAt, null);
    assert.deepEqual(
		{
			supplied: omitted.supplied,
			complete: omitted.complete,
			capturedAt: omitted.capturedAt,
			sessions: [...omitted.sessions],
		},
		{
			supplied: explicit.supplied,
			complete: explicit.complete,
			capturedAt: explicit.capturedAt,
			sessions: [...explicit.sessions],
		},
    );
    assert.throws(
		() => normalizeInventory({
			complete: false,
			capturedAt: "2026-08-12T10:00:00Z",
			sessions: [],
		}),
		/canonical timestamp/,
    );
});

function approvedPlan() {
    let plan = createDraftPlan({
        id: "projection-plan",
        title: "Projection plan",
        objective: "Derive recovery without duplicate state",
        constraints: [],
        repository: {
            workingDirectory: "/tmp/projection-plan",
            baseBranch: "main",
        },
        tasks: [
            {
                id: "T-001",
                title: "Foundation",
				kind: "implement",
                description: "Build the foundation",
                dependsOn: [],
                acceptanceCriteria: ["Foundation works"],
                expectedFiles: ["src/foundation.mjs"],
				deliveryRequirement: "branch",
            },
            {
                id: "T-002",
                title: "Dependent",
				kind: "implement",
                description: "Use the foundation",
                dependsOn: ["T-001"],
                acceptanceCriteria: ["Dependent works"],
                expectedFiles: ["src/dependent.mjs"],
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
    }, { now: "2026-08-06T00:00:00.000Z" });
    plan = transitionPlan(plan, PLAN_STATUS.AWAITING_APPROVAL, {
        at: "2026-08-06T00:01:00.000Z",
    });
    return approvePlan(plan, "tester", {
        at: "2026-08-06T00:02:00.000Z",
    });
}

test("projection treats omitted and incomplete session inventories as unknown", () => {
    let plan = approvedPlan();
    plan = reserveTaskAttempt(plan, "T-001", {
        reservationId: "projection-reservation",
        at: "2026-08-06T00:03:00.000Z",
    });

    plan = attachTaskAttempt(plan, "T-001", "T-001-A001", {
        sessionId: "projection-session",
        at: "2026-08-06T00:04:00.000Z",
    });
    assert.equal(projectPlan(plan).activeAttempts[0].sessionState, "unknown");
    assert.equal(projectPlan(plan, {
        sessionInventory: {
            complete: false,
            capturedAt: "2026-08-06T00:05:00.000Z",
            sessions: [],
        },
    }).activeAttempts[0].sessionState, "unknown");
    assert.equal(projectPlan(plan, {
        sessionInventory: {
            complete: true,
            capturedAt: "2026-08-06T00:03:30.000Z",
            sessions: [],
        },
    }).activeAttempts[0].sessionState, "unknown");
    assert.equal(projectPlan(plan, {
        sessionInventory: {
            complete: true,
            capturedAt: "2026-08-06T00:04:00.000Z",
            sessions: [],
        },
    }).activeAttempts[0].sessionState, "unknown");
    assert.equal(projectPlan(plan, {
        sessionInventory: {
            complete: true,
            capturedAt: "2026-08-06T00:05:00.000Z",
            sessions: [],
        },
    }).activeAttempts[0].sessionState, "absent");
});

test("projection replaces attach guidance for stale task reservations", () => {
	let plan = approvedPlan();
	plan = reserveTaskAttempt(plan, "T-001", {
		reservationId: "stale-projection",
		at: "2026-08-06T00:03:00.000Z",
	});
	const fresh = projectPlan(plan, {
		sessionInventory: {
			complete: true,
			capturedAt: "2026-08-06T00:20:00.000Z",
			sessions: [],
		},
	});
	assert.equal(fresh.nextAction.kind, "create-or-attach-session");

	const stale = projectPlan(plan, {
		sessionInventory: {
			complete: true,
			capturedAt: "2026-08-06T00:34:00.001Z",
			sessions: [],
		},
	});
	assert.equal(stale.activeAttempts[0].staleReservation, true);
	assert.equal(stale.nextAction.kind, "resolve-stale-reservation");
});

test("projection reports dependency waits and deterministic ready work", () => {
    const projection = projectPlan(approvedPlan());
    assert.equal(projection.nextAction.kind, "reserve-task");
    assert.equal(projection.nextAction.taskId, "T-001");
    assert.deepEqual(projection.dependencyWaits, [{
        taskId: "T-002",
        dependencies: [{ taskId: "T-001", status: "ready" }],
	}, {
		taskId: "T-003",
		dependencies: [{ taskId: "T-002", status: "planned" }],
	}]);
    assert.equal(projection.progress.percent, 0);
});

test("cancellation actions require attempt resolution before finalization", () => {
    let plan = approvedPlan();
    plan = reserveTaskAttempt(plan, "T-001", {
        reservationId: "projection-cancel-reservation",
        at: "2026-08-06T00:03:00.000Z",
    });
    plan = requestPlanCancellation(plan, {
        requestId: "projection-cancel-request",
        reason: "Stop",
        requestedBy: "tester",
        at: "2026-08-06T00:04:00.000Z",
    });
    const projection = projectPlan(plan);
    assert.deepEqual(
        projection.actions.map((entry) => entry.kind),
        ["resolve-session-creation", "finalize-cancellation"],
    );
    assert.equal(projection.nextAction.attemptId, "T-001-A001");
});
