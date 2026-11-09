import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { request } from "node:http";
import test from "node:test";
import { isList, readString } from "../../data.mjs";
import { available, jsonField, jsonResponse } from "../assertions.mjs";
import { fixture, gate, nativeUi, poster } from "./fixture.mjs";

/** @typedef {Pick<import("@github/copilot-sdk").SessionUiApi, "confirm" | "select" | "elicitation">} TestUi */

test("native forms persist the host decision rather than renderer-supplied attribution", async () => {
	/** @type {import("@github/copilot-sdk").ElicitationParams[]} */
	const prompts = [];
	const current = await fixture({
		getUi: () => nativeUi({
			elicitation: async (input) => {
				prompts.push(input);
				return {
					action: "accept", content: {
						approvedBy: "  native-user  ", requestedBy: "native-requester", reason: "Native cancellation reason",
					}
				};
			},
		})
	});
	try {
		const post = await poster(current);
		assert.equal((await current.server.snapshot()).interactions.native, true);
		const response = await post({
			action: "approve", approvalType: "plan", revision: current.plan.revision,
			approvedBy: "untrusted-renderer", confirmed: true,
		});
		assert.equal(response.status, 200);
		assert.deepEqual(await jsonResponse(response), { ok: true, value: { action: "approve" } });
		const state = await current.server.snapshot();
		assert.equal(state.plan.gates.planApprovedBy, "native-user");
		assert.match(prompts[0].message, /Approve plan canvas-plan at revision 2/);
		assert.deepEqual(prompts[0].requestedSchema.required, ["approvedBy"]);
		const cancelled = await post({
			action: "cancel", revision: state.plan.revision, requestId: "native-cancel",
			requestedBy: "untrusted-renderer", reason: "Untrusted reason",
		});
		assert.equal(cancelled.status, 200);
		assert.deepEqual(await jsonResponse(cancelled), { ok: true, value: { action: "cancel" } });
		const { plan } = await current.server.snapshot();
		assert.equal(plan.cancellation?.requestedBy, "native-requester");
		assert.equal(plan.cancellation?.reason, "Native cancellation reason");
		assert.match(prompts[1].message, /External App sessions keep running/);
	} finally {
		await current.close();
	}
});

test("mutation acknowledgments and dismissals never depend on a subsequent snapshot read", async () => {
	let ui = nativeUi({ elicitation: async () => ({ action: "cancel" }) });
	const current = await fixture({ getUi: () => ui });
	try {
		const post = await poster(current);
		const body = { action: "approve", approvalType: "plan", revision: current.plan.revision };
		assert.deepEqual(await jsonResponse(await post(body)), { ok: true, cancelled: true });
		assert.equal(current.snapshotReads.length, 0);
		ui = nativeUi();
		assert.deepEqual(await jsonResponse(await post(body)), { ok: true, value: { action: "approve" } });
		assert.equal(current.snapshotReads.length, 0);
		assert.equal((await current.operations.getPlan({ planId: current.plan.id })).gates.planApprovedBy, "native-user");
	} finally { await current.close(); }
});

test("native decline, dismissal, malformed input, and UI errors never fall back to browser approval", async () => {
	/** @type {TestUi} */
	let ui = nativeUi();
	const current = await fixture({ getUi: () => ui });
	try {
		const post = await poster(current);
		for (const action of /** @type {const} */ (["decline", "cancel"])) {
			ui = nativeUi({ elicitation: async () => ({ action }) });
			const response = await post({ action: "approve", approvalType: "plan", revision: current.plan.revision, confirmed: true, approvedBy: "spoof" });
			assert.equal(response.status, 200);
			assert.equal(jsonField(await jsonResponse(response), "cancelled"), true);
		}
		ui = nativeUi({ elicitation: async () => ({ action: "accept", content: { approvedBy: " " } }) });
		const invalid = await post({ action: "approve", approvalType: "plan", revision: current.plan.revision });
		assert.equal(invalid.status, 400);
		ui = nativeUi({ elicitation: async () => { throw new Error("Host dialog unavailable"); } });
		const failed = await post({ action: "approve", approvalType: "plan", revision: current.plan.revision, confirmed: true, approvedBy: "spoof" });
		assert.equal(failed.status, 500);
		assert.match(readString(jsonField(await jsonResponse(failed), "error", "message")), /Host dialog unavailable/);
		ui = nativeUi({ confirm: async () => false });
		const pause = await post({ action: "pause-workflow", runId: "native-run", revision: current.plan.revision, confirmed: true });
		assert.equal(jsonField(await jsonResponse(pause), "cancelled"), true);
		assert.equal(current.workflowCalls.length, 0);
		assert.equal((await current.operations.getPlan({ planId: current.plan.id })).revision, current.plan.revision);
	} finally {
		await current.close();
	}
});

test("native decisions reject duplicate dialogs and revisions changed while awaiting the user", async () => {
	const started = gate();
	const release = gate();
	const current = await fixture({
		getUi: () => nativeUi({
			elicitation: async () => {
				started.release();
				await release.promise;
				return { action: "accept", content: { approvedBy: "late-user" } };
			},
		})
	});
	try {
		const post = await poster(current);
		const body = { action: "approve", approvalType: "plan", revision: current.plan.revision };
		const pending = post(body);
		await started.promise;
		const duplicate = await post(body);
		assert.equal(duplicate.status, 409);
		await duplicate.text();
		const external = await current.operations.approve({
			planId: current.plan.id, expectedRevision: current.plan.revision, approvalType: "plan", approvedBy: "other-board",
		});
		release.release();
		const response = await pending;
		assert.equal(response.status, 409);
		assert.equal(jsonField(await jsonResponse(response), "error", "code"), "revision_conflict");
		const saved = await current.operations.getPlan({ planId: current.plan.id });
		assert.equal(saved.revision, external.revision);
		assert.equal(saved.gates.planApprovedBy, "other-board");
	} finally {
		release.release();
		await current.close();
	}
});

test("an abandoned native dialog cannot apply its late answer", async () => {
	const started = gate();
	const release = gate();
	const current = await fixture({
		getUi: () => nativeUi({
			elicitation: async () => {
				started.release();
				await release.promise;
				return { action: "accept", content: { approvedBy: "late-user" } };
			},
		})
	});
	try {
		const post = await poster(current);
		const controller = new AbortController();
		const pending = post({ action: "approve", approvalType: "plan", revision: current.plan.revision }, { signal: controller.signal });
		const abandoned = assert.rejects(pending, { name: "AbortError" });
		await started.promise;
		controller.abort();
		await abandoned;
		await current.server.close();
		release.release();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal((await current.operations.getPlan({ planId: current.plan.id })).revision, current.plan.revision);
	} finally {
		release.release();
		if (current.server.server.listening) await current.server.close();
		await rm(current.workspacePath, { recursive: true, force: true });
	}
});

test("a settled native resume dialog does not prevent pausing its still-running workflow", async () => {
	const started = gate();
	const release = gate();
	const current = await fixture({
		getUi: () => nativeUi(),
		control: async (runId, action) => {
			if (action === "resume") { started.release(); await release.promise; }
			else release.release();
			return { runId, status: "paused" };
		},
	});
	try {
		const post = await poster(current);
		const pending = post({ action: "resume-workflow", runId: "native-run", revision: current.plan.revision });
		await started.promise;
		const paused = await post({ action: "pause-workflow", runId: "native-run", revision: current.plan.revision });
		assert.equal(paused.status, 200);
		await paused.text();
		const resumed = await pending;
		assert.equal(resumed.status, 200);
		await resumed.text();
		assert.deepEqual(current.workflowCalls.map(({ action }) => action), ["resume", "pause"]);
	} finally {
		release.release();
		await current.close();
	}
});

test("workflow detail and older progress routes are read-only and preserve native observations", async () => {
	const current = await fixture();
	try {
		const response = await fetch(new URL("api/workflow?runId=native-run", current.server.url));
		assert.equal(response.status, 200);
		const detail = jsonField(await jsonResponse(response), "value");
		assert.equal(jsonField(detail, "consumed", "nanoAiu"), 250_000_000);
		const older = await fetch(new URL("api/workflow?runId=native-run&beforeSeq=20", current.server.url));
		assert.equal(older.status, 200);
		assert.equal(jsonField(await jsonResponse(older), "value", "progress", "records", 0, "seq"), 19);
		const invalid = await fetch(new URL("api/workflow?runId=native-run&beforeSeq=", current.server.url));
		assert.equal(invalid.status, 400);
		await invalid.text();
		assert.equal((await current.operations.getPlan({ planId: current.plan.id })).revision, current.plan.revision);
	} finally {
		await current.close();
	}
});

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

		const snapshotResponse = await fetch(new URL("api/plan", current.server.url));
		const snapshot = await jsonResponse(snapshotResponse);
		assert.equal(jsonField(snapshot, "ok"), true);
		assert.equal(jsonField(snapshot, "value", "plan", "id"), "canvas-plan");
		assert.equal(jsonField(snapshot, "value", "plan", "status"), "awaiting-approval");
		const activity = jsonField(snapshot, "value", "plan", "activity");
		assert.ok(isList(activity) && activity.length > 0);
		assert.equal(jsonField(activity, 0, "revision"), 1);
		assert.equal(jsonField(snapshot, "value", "projection", "nextAction", "kind"), "approve-plan");
		assert.deepEqual(jsonField(snapshot, "value", "workflows", "runs", 0, "currentPhase"), { id: "audit", ordinal: 0 });
		assert.deepEqual(jsonField(snapshot, "value", "workflows", "runs", 0, "actions"), ["pause"]);

		const reboundStatus = await new Promise((resolve, reject) => {
			const url = new URL("api/plan", current.server.url);
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

test("canvas pause and resume use confirmed native controls without granting approval", async () => {
	const current = await fixture();
	try {
		const html = await (await fetch(current.server.url)).text();
		const token = html.match(/name="foundry-token" content="([a-f0-9]+)"/)?.[1];
		assert.ok(token);
		const actionUrl = new URL("api/action", current.server.url);
		for (const [action, expectedStatus] of [["pause", "paused"], ["resume", "completed"]]) {
			const body = { action: `${action}-workflow`, runId: "native-run", revision: current.plan.revision };
			/** @type {Response} */
			const unconfirmed = await fetch(actionUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json", "x-foundry-token": token },
				body: JSON.stringify(body),
			});
			assert.equal(unconfirmed.status, 400);
			/** @type {Response} */
			const response = await fetch(actionUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json", "x-foundry-token": token },
				body: JSON.stringify({ ...body, confirmed: true }),
			});
			assert.equal(response.status, 200);
			assert.deepEqual(await jsonResponse(response), {
				ok: true, value: { action: `${action}-workflow`, runId: "native-run", status: expectedStatus },
			});
			const value = await current.server.snapshot();
			assert.equal(available(value.workflows).runs[0].status, expectedStatus);
			assert.equal(value.plan.status, "awaiting-approval");
			assert.equal(value.plan.revision, current.plan.revision);
		}
		assert.deepEqual(current.workflowCalls, [
			{ runId: "native-run", action: "pause" },
			{ runId: "native-run", action: "resume" },
		]);
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
		const actionUrl = new URL("api/action", current.server.url);

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
		assert.match(readString(jsonField(await jsonResponse(retryApproval), "error", "message")), /must be plan or completion/);
		assert.equal((await current.operations.getPlan({ planId: current.plan.id })).revision, current.plan.revision);

		for (const action of ["approve-correction", "reserve-task", "finalize-cancellation"]) {
			/** @type {Response} */
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
		const approvedBody = await jsonResponse(approved);
		assert.deepEqual(approvedBody, { ok: true, value: { action: "approve" } });
		const approvedPlan = await current.operations.getPlan({ planId: current.plan.id });
		assert.equal(approvedPlan.status, "approved");
		assert.equal(approvedPlan.gates.planApprovedBy, "octocat");

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
		/** @param {Record<string, unknown>} body */
		const post = (body) => fetch(new URL("api/action", current.server.url), {
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
		assert.deepEqual(await jsonResponse(retried), { ok: true, value: { action: "retry" } });
		const retriedState = await current.server.snapshot();
		assert.equal(retriedState.plan.tasks[0].status, "planned");
		assert.ok(retriedState.projection.scheduling.readyTaskIds.includes("T-001"));
		assert.ok(!retriedState.projection.actions.some((entry) => entry.kind === "retry-task"));
		const repeated = await post({
			action: "retry", taskId: "T-001", revision: retriedState.plan.revision,
		});
		assert.equal(repeated.status, 400);
		assert.equal(jsonField(await jsonResponse(repeated), "error", "code"), "invalid_task_transition");
		const correction = await post({
			action: "approve", approvalType: "retry", approvedBy: "tester",
			revision: retriedState.plan.revision,
		});
		assert.equal(correction.status, 400);
		assert.match(readString(jsonField(await jsonResponse(correction), "error", "message")), /must be plan or completion/);
	} finally {
		await current.close();
	}
});
