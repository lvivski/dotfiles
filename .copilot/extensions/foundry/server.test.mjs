import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createFoundryOperations } from "./operations.mjs";
import { startServer } from "./server.mjs";

async function fixture() {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "foundry-canvas-"));
    /** @type {((event: any) => void) | null} */
    let subscriber = null;
    const operations = createFoundryOperations({
        getWorkspacePath: () => workspacePath,
        notify: (event) => subscriber?.(event),
        analysis: {
            importPlanning: async (runId) => ({
                runId,
                inputDigest: "a".repeat(64),
                plan: {
                    title: "Canvas plan",
                    objective: "Render a safe plan board",
                    constraints: [],
					tasks: [
						{
							id: "T-001",
							title: "Render",
							kind: "implement",
							description: "Render the plan",
							dependsOn: [],
							acceptanceCriteria: ["Board is visible"],
							expectedFiles: ["renderer/**"],
							deliveryRequirement: "commit",
						},
						{
							id: "T-002",
							title: "Verify",
							kind: "verify",
							description: "Verify the board",
							dependsOn: ["T-001"],
							acceptanceCriteria: [],
							expectedFiles: [],
							deliveryRequirement: "commit",
						},
					],
                },
            }),
        },
    });
    let plan = await operations.createPlan({
        expectedRevision: 0,
        id: "canvas-plan",
        runId: "canvas-planning-run",
        repository: {
            workingDirectory: workspacePath,
            baseBranch: "main",
        },
    });
    plan = await operations.submitPlan({
        planId: plan.id,
        expectedRevision: plan.revision,
    });
    const server = await startServer({
        instanceId: "canvas-test",
        planId: plan.id,
        workspacePath,
        operations,
        subscribe: (_workspace, _plan, listener) => {
            subscriber = listener;
            return () => {
                subscriber = null;
            };
        },
    });
    return {
        workspacePath,
        operations,
        plan,
        server,
        async close() {
            await server.close();
            await rm(workspacePath, { recursive: true, force: true });
        },
    };
}

test("canvas server renders assets and exposes the validated plan snapshot", async () => {
    const current = await fixture();
    try {
        const htmlResponse = await fetch(current.server.url);
        assert.equal(htmlResponse.status, 200);
        assert.match(
            htmlResponse.headers.get("content-security-policy") ?? "",
            /default-src 'none'/,
        );
        const html = await htmlResponse.text();
        assert.match(html, /<title>Foundry<\/title>/);
		assert.match(html, /id="activity"/);
        assert.doesNotMatch(html, /__FOUNDRY_/);

        const snapshotResponse = await fetch(new URL("/api/plan", current.server.url));
        const snapshot = await snapshotResponse.json();
        assert.equal(snapshot.ok, true);
        assert.equal(snapshot.value.plan.id, "canvas-plan");
        assert.equal(snapshot.value.plan.status, "awaiting-approval");
		assert.ok(snapshot.value.plan.activity.length > 0);
		assert.equal(snapshot.value.plan.activity[0].revision, 1);
        assert.equal(snapshot.value.projection.nextAction.kind, "approve-plan");

        const reboundStatus = await new Promise((resolve, reject) => {
            const url = new URL("/api/plan", current.server.url);
            const reboundRequest = request({
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                headers: { Host: "attacker.example" },
            }, (response) => {
                response.resume();
                response.on("end", () => resolve(response.statusCode));
            });
            reboundRequest.on("error", reject);
            reboundRequest.end();
        });
        assert.equal(reboundStatus, 421);
    } finally {
        await current.close();
    }
});

test("canvas mutations require a token, explicit confirmation, and current revision", async () => {
    const current = await fixture();
    try {
        const html = await (await fetch(current.server.url)).text();
        const token = html.match(/name="foundry-token" content="([a-f0-9]+)"/)?.[1];
        assert.ok(token);
        const actionUrl = new URL("/api/action", current.server.url);

        const denied = await fetch(actionUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "approve", confirmed: true }),
        });
        assert.equal(denied.status, 403);

        const unconfirmed = await fetch(actionUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-foundry-token": token,
            },
            body: JSON.stringify({ action: "approve", confirmed: false }),
        });
        assert.equal(unconfirmed.status, 400);

		const missingApprover = await fetch(actionUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-foundry-token": token,
			},
			body: JSON.stringify({
				action: "approve",
				approvalType: "plan",
				revision: current.plan.revision,
				confirmed: true,
			}),
		});
		assert.equal(missingApprover.status, 400);

		const retryApproval = await fetch(actionUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-foundry-token": token,
			},
			body: JSON.stringify({
				action: "approve",
				approvalType: "retry",
				approvedBy: "octocat",
				revision: current.plan.revision,
				confirmed: true,
			}),
		});
		assert.equal(retryApproval.status, 400);
		assert.match((await retryApproval.json()).error.message, /must be plan or completion/);
		assert.equal((await current.operations.getPlan({ planId: current.plan.id })).revision, current.plan.revision);

		for (const action of ["approve-correction", "reserve-task", "finalize-cancellation"]) {
			const unsupported = await fetch(actionUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json", "x-foundry-token": token },
				body: JSON.stringify({ action, confirmed: true }),
			});
			assert.equal(unsupported.status, 404);
		}
		const foreignOrigin = await fetch(actionUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-foundry-token": token,
				Origin: "https://attacker.example",
			},
			body: JSON.stringify({
				action: "approve", approvalType: "plan", approvedBy: "tester",
				revision: current.plan.revision, confirmed: true,
			}),
		});
		assert.equal(foreignOrigin.status, 403);

        const approved = await fetch(actionUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-foundry-token": token,
            },
            body: JSON.stringify({
                action: "approve",
                approvalType: "plan",
				approvedBy: "octocat",
                revision: current.plan.revision,
                confirmed: true,
            }),
        });
        assert.equal(approved.status, 200);
        const approvedBody = await approved.json();
        assert.equal(approvedBody.value.plan.status, "approved");
		assert.equal(approvedBody.value.plan.gates.planApprovedBy, "octocat");

        const stale = await fetch(actionUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-foundry-token": token,
            },
            body: JSON.stringify({
                action: "cancel",
                reason: "stale request",
				requestedBy: "octocat",
                revision: current.plan.revision,
                confirmed: true,
            }),
        });
        assert.equal(stale.status, 409);
    } finally {
        await current.close();
    }
});

test("HTTP task retry follows projected eligibility without granting correction approval", async () => {
	const current = await fixture();
	try {
		const html = await (await fetch(current.server.url)).text();
		const token = html.match(/name="foundry-token" content="([a-f0-9]+)"/)?.[1];
		assert.ok(token);
		const post = (body) => fetch(new URL("/api/action", current.server.url), {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-foundry-token": token },
			body: JSON.stringify({ ...body, confirmed: true }),
		});
		let plan = await current.operations.approve({
			planId: current.plan.id,
			expectedRevision: current.plan.revision,
			approvalType: "plan",
			approvedBy: "tester",
		});
		const reserved = await current.operations.reserveTask({
			planId: plan.id, expectedRevision: plan.revision,
			taskId: "T-001", reservationId: "retry-reservation",
		});
		plan = await current.operations.completeTask({
			planId: plan.id, expectedRevision: reserved.plan.revision,
			taskId: "T-001", attemptId: reserved.attemptId, status: "blocked",
			error: "Session was not created",
		});
		const blocked = await current.server.snapshot();
		assert.ok(blocked.projection.actions.some((entry) => entry.kind === "retry-task"));
		const retried = await post({ action: "retry", taskId: "T-001", revision: plan.revision });
		assert.equal(retried.status, 200);
		const retriedState = (await retried.json()).value;
		assert.equal(retriedState.plan.tasks[0].status, "ready");
		assert.ok(!retriedState.projection.actions.some((entry) => entry.kind === "retry-task"));
		const repeated = await post({
			action: "retry", taskId: "T-001", revision: retriedState.plan.revision,
		});
		assert.equal(repeated.status, 400);
		assert.equal((await repeated.json()).error.code, "invalid_task_transition");
		const correction = await post({
			action: "approve", approvalType: "retry", approvedBy: "tester",
			revision: retriedState.plan.revision,
		});
		assert.equal(correction.status, 400);
		assert.match((await correction.json()).error.message, /must be plan or completion/);
	} finally {
		await current.close();
	}
});

test("renderer assigns plan-authored content through textContent", async () => {
    const script = await readFile(
        new URL("./renderer/app.js", import.meta.url),
        "utf8",
    );
    assert.doesNotMatch(script, /\.innerHTML\s*=/);
    assert.match(script, /\.textContent\s*=/);
});
