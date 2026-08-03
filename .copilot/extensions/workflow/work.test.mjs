/** @module work.test — unified Work lifecycle, control fencing, heartbeat, and reconciliation. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
	HEARTBEAT_STALE_MS,
	Work,
	abortWork,
	readWorkOwner,
	reconcileWorkRecord,
	requestWorkControl,
	takeWorkControl,
} from "./work.mjs";
import { PROCESS_INSTANCE_ID } from "./persistence.mjs";
import { tmpDir, waitFor } from "./fixtures/support.mjs";

/** @param {string} runDir @param {{ token: string, generation: number, pid: number, instanceId?: string }} owner */
function writeOwner(runDir, owner) {
	mkdirSync(join(runDir, ".lock"), { recursive: true });
	writeFileSync(join(runDir, ".lock", "owner.json"), JSON.stringify(owner));
}

test("Work owns lease, heartbeat, local control, settlement, and release", async () => {
	const runDir = tmpDir();
	const work = Work.open({ runId: "work", runDir, heartbeatIntervalMs: 20, controlPollMs: 20 });
	assert.equal(Work.find("work"), work);
	assert.equal(readWorkOwner(runDir)?.generation, work.generation);
	const first = JSON.parse(readFileSync(join(runDir, "heartbeat.json"), "utf8")).heartbeatAt;
	await waitFor(() => JSON.parse(readFileSync(join(runDir, "heartbeat.json"), "utf8")).heartbeatAt !== first, 1000, 10);
	assert.equal(work.request("pause"), true);
	assert.equal(work.signal.reason.kind, "pause");
	assert.equal(work.request("cancel"), true);
	assert.equal(work.signal.reason.kind, "cancel");
	work.close();
	await work.settled;
	assert.equal(Work.find("work"), null);
	assert.equal(work.request("cancel"), false);
	assert.equal(existsSync(join(runDir, ".lock")), false);
});

test("Work deadline is opt-in", async () => {
	const untimed = Work.open({ runId: "untimed", runDir: tmpDir() });
	assert.equal(untimed.signal.aborted, false);
	untimed.close();
	const timed = Work.open({ runId: "timed", runDir: tmpDir(), timeoutSec: 0.02 });
	await waitFor(() => timed.signal.aborted, 1000, 5);
	assert.equal(timed.signal.reason.kind, "timeout");
	timed.close();
});

test("durable control targets the current generation and cancel supersedes pause", () => {
	const runDir = tmpDir();
	const owner = { token: "owner-1", generation: 1, pid: process.pid, instanceId: PROCESS_INSTANCE_ID };
	writeOwner(runDir, owner);
	assert.deepEqual(readWorkOwner(runDir), owner);
	requestWorkControl(runDir, "pause");
	const cancel = requestWorkControl(runDir, "cancel");
	const consumed = takeWorkControl(runDir);
	assert.equal(consumed.id, cancel.id);
	assert.equal(consumed.action, "cancel");
	assert.equal(takeWorkControl(runDir), null);
});

test("a request for generation N cannot control generation N+1", () => {
	const runDir = tmpDir();
	writeOwner(runDir, { token: "owner-1", generation: 1, pid: process.pid });
	const requested = requestWorkControl(runDir, "pause");
	writeOwner(runDir, { token: "owner-2", generation: 2, pid: process.pid });
	assert.equal(takeWorkControl(runDir), null);
	assert.equal(requested.target.generation, 1);
	assert.deepEqual(readdirSync(join(runDir, "control")), []);
});

test("Work reconciliation uses owner identity and heartbeat freshness", () => {
	const liveDir = tmpDir();
	const live = Work.open({ runId: "live", runDir: liveDir });
	assert.equal(reconcileWorkRecord({ status: "running" }, liveDir).status, "running");
	live.close();

	const staleDir = tmpDir();
	const owner = { token: "stale", generation: 1, pid: process.pid, instanceId: PROCESS_INSTANCE_ID };
	writeOwner(staleDir, owner);
	writeFileSync(join(staleDir, "heartbeat.json"), JSON.stringify({
		...owner,
		heartbeatAt: new Date(Date.now() - HEARTBEAT_STALE_MS - 1000).toISOString(),
	}));
	assert.equal(reconcileWorkRecord({ status: "running" }, staleDir).status, "running");
	assert.doesNotThrow(() => requestWorkControl(staleDir, "cancel"));

	const legacyDir = tmpDir();
	assert.equal(reconcileWorkRecord({
		status: "running",
		updatedAt: new Date(Date.now() - HEARTBEAT_STALE_MS - 1000).toISOString(),
	}, legacyDir).status, "interrupted");
});

test("abortWork addresses only process-local Work", () => {
	assert.equal(abortWork("missing"), false);
	const work = Work.open({ runId: "abort", runDir: tmpDir() });
	assert.equal(abortWork("abort"), true);
	assert.equal(work.signal.reason.kind, "cancel");
	work.close();
});
