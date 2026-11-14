import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createNativeRetention, retentionSubject } from "../../native/retention.mjs";

/** @typedef {import("../../native/retention.mjs").RetentionHost} Host */
/** @typedef {import("../../native/retention.mjs").Subject} Subject */
/** @typedef {import("../../native/retention.mjs").Observation} Observation */
/** @typedef {import("../../native/retention.mjs").RetentionResult} Result */
/** @typedef {import("../../native/retention.mjs").Hold} Hold */
/** @typedef {import("../../native/retention.mjs").Status} Status */
/** @typedef {import("../../native/retention.mjs").Receipt} Receipt */

/** @returns {Subject} */
function subject() {
	return {
		attempt: { owner: "synthetic-owner", repositoryId: "a".repeat(64), planId: "retention-fixture", taskId: "T-001", attemptId: "T-001-A001", reservationId: "fixture-reservation" },
		child: { sessionId: "synthetic-child", projectId: "synthetic-project", creatorSessionId: "synthetic-coordinator", branch: "synthetic-branch", worktreePath: "/synthetic/worktrees/child" },
		coordinatorSessionId: "synthetic-coordinator", runIds: ["synthetic-run"],
	};
}

/**
 * Entirely synthetic host, including the conditional effect boundary and permission.
 * The effect is a counter ONLY: no native App call, cancellation, deletion or removal.
 * Its single synchronous effect guard models host-wide change exclusion, not a local
 * lock claimed to provide production safety. Real Git fixtures below exercise actual
 * filesystem observations, but do not turn this synthetic host into an App adapter.
 * @param {Subject} [bound]
 */
function synthetic(bound = subject()) {
	const state = {
		subject: structuredClone(bound),
		context: { owner: bound.attempt.owner, sessionId: "synthetic-coordinator", projectId: bound.child.projectId, repositoryId: bound.attempt.repositoryId, worktreePath: "/synthetic/worktrees/coordinator" },
		activity: /** @type {Observation["activity"]} */ ("idle"),
		taskStatus: /** @type {Observation["pages"][number]["attempts"][number]["taskStatus"]} */ ("done"),
		attemptStatus: /** @type {Observation["pages"][number]["attempts"][number]["attemptStatus"]} */ ("done"),
		runStatus: /** @type {Observation["pages"][number]["runs"][number]["status"]} */ ("completed"),
		workspace: /** @type {Observation["workspace"]} */ ({ tracked: [], untracked: [], ignored: [] }),
		automation: false, openPr: false, merge: false, consumer: false, evaluator: false, retained: true, permission: true,
	};
	const events = /** @type {string[]} */ ([]);
	const counters = { checkpoints: 0, observations: 0, conditional: 0, effects: 0, reconciliations: 0 };
	let sequence = 0;
	/** @type {Observation | null} */
	let lastObservation = null;
	/** @type {Receipt | null} */
	let lastReceipt = null;
	/** @type {Receipt | null} */
	let reconciliation = null;
	const hooks = {
		beforeReassessment: () => {},
		afterReassessment: () => {},
		/** @param {Observation} value */
		observation: value => value,
		workspace: () => structuredClone(state.workspace),
		/** @param {Receipt} receipt @returns {Receipt} */
		reply: receipt => receipt,
	};
	/** @returns {Hold[]} */
	function policyHolds() {
		const reasons = [];
		for (const [present, code] of [
			[state.automation, "attached-automation"], [state.openPr, "open-pr"], [state.merge, "agent-merge"],
			[state.consumer, "consumer-hold"], [state.evaluator, "evaluator-hold"], [!state.retained, "retention-lost"],
		]) if (present) reasons.push({ code: String(code), message: `Synthetic current authority requires ${code} to be resolved` });
		return reasons;
	}
	/** @param {string} intentId @param {Status} status @param {Hold[]} [reasons] @returns {Receipt} */
	function receipt(intentId, status, reasons = []) {
		return { source: "synthetic native archive receipt", raw: { subject: structuredClone(bound), intentId, operation: "archive_session", status, reasons } };
	}
	/** @returns {Hold[]} */
	function effectHolds() {
		const reasons = policyHolds();
		if (!lastObservation || JSON.stringify(state.subject) !== JSON.stringify(lastObservation.subject)) {
			reasons.push({ code: "identity-changed", message: "Synthetic action-boundary identity changed" });
		}
		if (state.context.sessionId !== bound.coordinatorSessionId) reasons.push({ code: "owner-changed", message: "Synthetic native owner changed" });
		if (state.activity !== "idle" || state.taskStatus !== "done" || state.attemptStatus !== "done" || state.runStatus !== "completed") {
			reasons.push({ code: "new-activity", message: "Synthetic action-boundary work is not terminal/idle" });
		}
		for (const [kind, files] of Object.entries(hooks.workspace())) {
			if (files.length) reasons.push({ code: `workspace-${kind}`, message: `Preserve new ${kind} bytes: ${files.join(", ")}` });
		}
		return reasons;
	}
	/** @type {Host} */
	const host = {
		source: "explicitly synthetic conditional archive host",
		context: () => structuredClone(state.context),
		async checkpoint() { counters.checkpoints++; return { epoch: "synthetic-authority-epoch", sequence: ++sequence }; },
		async observe({ subject: actual, after }) {
			counters.observations++;
			assert.deepEqual(actual, bound);
			/** @type {Observation} */
			const value = {
				subject: structuredClone(state.subject), after, detailSequence: ++sequence, inventorySequence: ++sequence,
				activity: state.activity, workspace: hooks.workspace(),
				pages: [{
					cursor: null, next: null, sessions: [structuredClone(state.subject)],
					attempts: [{ identity: structuredClone(bound.attempt), taskStatus: state.taskStatus, attemptStatus: state.attemptStatus }],
					runs: bound.runIds.map(runId => ({ runId, attempt: structuredClone(bound.attempt), status: state.runStatus })),
				}],
			};
			lastObservation = hooks.observation(value);
			events.push("observation");
			return { source: "synthetic ordered detail and exhaustive inventory", raw: structuredClone(lastObservation) };
		},
		decodeObservation: raw => raw,
		async assess() {
			events.push("retention-assessment");
			return { source: "synthetic canonical retention authority", raw: { retained: state.retained, consumer: state.consumer, evaluator: state.evaluator }, reasons: policyHolds() };
		},
		route: () => "supported",
		async conditionalArchive({ subject: actual, intentId, reassess }) {
			counters.conditional++;
			assert.deepEqual(actual, bound);
			hooks.beforeReassessment();
			const current = await reassess();
			events.push("final-reassessment");
			hooks.afterReassessment();
			events.push("attempted-archive-effect");
			// This is the simulated host condition, not a port-side inspect/delete window.
			const reasons = [...current.reasons, ...effectHolds()];
			if (current.status !== "inspected" || reasons.length) {
				events.push("guard-held");
				lastReceipt = receipt(intentId, "held", reasons);
			} else if (!state.permission) {
				events.push("permission-denied");
				lastReceipt = receipt(intentId, "denied", [{ code: "native-permission-denied", message: "Native permission was lost; preserve the subject" }]);
			} else {
				events.push("synthetic-archive-effect");
				counters.effects++;
				lastReceipt = receipt(intentId, "archived");
			}
			return hooks.reply(lastReceipt);
		},
		decodeArchive: raw => raw,
		async observeOutcome({ subject: actual }) {
			counters.reconciliations++;
			assert.deepEqual(actual, bound);
			return reconciliation;
		},
		decodeReconciliation: raw => raw,
	};
	return {
		state, host, hooks, counters, events, bound,
		native: () => createNativeRetention({ subject: bound, host }),
		receipt,
		get lastReceipt() { return lastReceipt; },
		/** @param {Receipt | null} value */
		reconciliation(value) { reconciliation = value; },
	};
}

const request = { intentId: "canonical-retention-intent" };

test("RET-N01 closed subject and archive requests cannot select identity or grant permission through model JSON", async () => {
	const f = synthetic(), native = f.native();
	assert.deepEqual(retentionSubject(f.bound), f.bound);
	for (const extra of [{ owner: "other" }, { complete: true }, { authorized: true }, { raceSafe: true }, { token: "opaque" }, { release: true }]) {
		await assert.rejects(native.archive({ ...request, ...extra }), { code: "factory_input_invalid" });
		assert.throws(() => retentionSubject({ ...f.bound, ...extra }), { code: "factory_input_invalid" });
	}
	assert.throws(() => retentionSubject({ ...f.bound, runIds: ["duplicate", "duplicate"] }), { code: "factory_input_invalid" });
	assert.throws(() => retentionSubject({ ...f.bound, child: { ...f.bound.child, worktreePath: "/worktrees/../owner" } }), { code: "dispatch_child_invalid" });
	assert.equal(f.counters.conditional, 0);
	assert.equal(f.counters.effects, 0);
});

test("RET-N01/N04 absent observer, decoder, retention, route or conditional implementation fails closed", async () => {
	const absent = createNativeRetention({ subject: subject() });
	assert.equal((await absent.inspect()).code, "unsupported-observation");
	assert.equal((await absent.archive(request)).code, "unsupported-route");
	/** @type {[keyof Host, string][]} */
	const cases = [
		["context", "unsupported-observation"], ["checkpoint", "unsupported-observation"], ["observe", "unsupported-observation"],
		["decodeObservation", "unsupported-decoder"], ["assess", "unsupported-retention"],
		["route", "unsupported-route"], ["conditionalArchive", "unsupported-race-safety"], ["decodeArchive", "unsupported-decoder"],
	];
	for (const [key, code] of cases) {
		const f = synthetic();
		delete f.host[key];
		const result = await f.native().archive(request);
		assert.equal(result.status, "unsupported", key);
		assert.equal(result.code, code, key);
		assert.equal(f.counters.conditional, 0, key);
		assert.equal(f.counters.effects, 0, key);
	}
});

test("RET-N04 metadata, boolean guarantees, tokens and local locks do not supply a conditional host implementation", async () => {
	for (const metadata of [
		{ raceSafe: true, authorized: true, complete: true },
		{ token: "supposed-fence", capabilities: ["archive_session"], advertised: true },
		{ lock: { held: true }, canonicalFence: 42, previousSuccessfulRoute: "primary-App" },
	]) {
		const f = synthetic();
		let ordinaryArchiveCalls = 0;
		delete f.host.conditionalArchive;
		const ordinaryHost = { ...f.host, ...metadata, archiveSession: () => { ordinaryArchiveCalls++; } };
		const native = createNativeRetention({ subject: f.bound, host: ordinaryHost });
		assert.equal((await native.inspect()).status, "inspected");
		const result = await native.archive(request);
		assert.equal(result.code, "unsupported-race-safety");
		assert.equal(ordinaryArchiveCalls, 0);
		assert.equal(f.counters.effects, 0);
	}
});

test("RET-N04/N06 unavailable, unproven and disabled routes never invoke a conditional archive or fallback", async () => {
	for (const state of /** @type {const} */ (["unavailable", "unproven", "disabled"])) {
		const f = synthetic();
		f.host.route = () => state;
		const result = await f.native().archive(request);
		assert.equal(result.code, "unsupported-route");
		assert.equal(f.counters.conditional, 0);
		assert.equal(f.counters.effects, 0);
		assert.ok(result.evidence.some(item => item.phase === "route" && item.raw === state));
	}
});

test("RET-N02 exact current owner, creator, coordinator, project, repository and worktree binding is mandatory", async () => {
	/** @type {((f: ReturnType<typeof synthetic>) => void)[]} */
	const changes = [
		f => { f.state.context.owner = "foreign-owner"; },
		f => { f.state.context.repositoryId = "b".repeat(64); },
		f => { f.state.context.projectId = "foreign-project"; },
		f => { f.state.context.sessionId = "foreign-coordinator"; },
		f => { f.state.context.sessionId = f.bound.child.sessionId; },
		f => { f.state.context.worktreePath = f.bound.child.worktreePath; },
		f => { f.state.context.worktreePath = "/synthetic/worktrees"; },
		f => { f.state.context.worktreePath = `${f.bound.child.worktreePath}/nested`; },
	];
	for (const change of changes) {
		const f = synthetic();
		change(f);
		const result = await f.native().archive(request);
		assert.equal(result.status, "held");
		assert.ok(["owner-or-self", "foreign-subject"].includes(result.code));
		assert.equal(f.counters.conditional, 0);
		assert.equal(f.counters.effects, 0);
	}
	for (const field of /** @type {const} */ (["creatorSessionId", "sessionId", "projectId", "worktreePath", "branch"])) {
		const f = synthetic();
		f.state.subject.child[field] = field === "worktreePath" ? "/synthetic/foreign" : "foreign";
		assert.equal((await f.native().archive(request)).code, "identity-changed");
		assert.equal(f.counters.effects, 0);
	}
});

test("RET-N02 binding cannot be rewritten by caller mutation after construction", async () => {
	const f = synthetic(), native = f.native();
	f.bound.child.sessionId = "changed-input";
	f.bound.attempt.owner = "changed-owner";
	const result = await native.inspect();
	// The fixture detects the retained binding differs from the changed external input.
	assert.equal(result.status, "held");
	assert.equal(result.subject.child.sessionId, "synthetic-child");
	assert.equal(result.subject.attempt.owner, "synthetic-owner");
	assert.equal(f.counters.effects, 0);
});

test("RET-N03 exact exhaustive inventory rejects aliases, gaps, stale details, duplicates, foreign and discovered work", async () => {
	/** @type {[string, (value: Observation) => void][]} */
	const changes = [
		["ambiguous-session", value => { value.pages[0].sessions.push(structuredClone(value.subject)); }],
		["ambiguous-session", value => { value.pages[0].sessions[0].child.sessionId = "conflicting-alias"; }],
		["incomplete-inventory", value => { value.pages[0].next = "missing-page"; }],
		["incomplete-inventory", value => { value.pages[0].cursor = "missing-first"; }],
		["incomplete-inventory", value => { value.pages.push(structuredClone(value.pages[0])); }],
		["stale-inventory", value => { value.detailSequence = value.after.sequence; }],
		["stale-inventory", value => { value.inventorySequence = value.detailSequence; }],
		["stale-inventory", value => { value.after.epoch = "different-authority"; }],
		["attempt-inventory-changed", value => { value.pages[0].attempts = []; }],
		["attempt-inventory-changed", value => { value.pages[0].attempts[0].identity.reservationId = "foreign-reservation"; }],
		["run-inventory-changed", value => { value.pages[0].runs = []; }],
		["run-inventory-changed", value => { value.pages[0].runs[0].runId = "newly-discovered-run"; }],
		["run-inventory-changed", value => { value.pages[0].runs[0].attempt.owner = "foreign"; }],
		["run-inventory-changed", value => { value.pages[0].runs.push(structuredClone(value.pages[0].runs[0])); }],
	];
	for (const [code, change] of changes) {
		const f = synthetic();
		f.hooks.observation = value => { change(value); return value; };
		const result = await f.native().archive(request);
		assert.equal(result.status, "held", code);
		assert.ok(result.reasons.some(reason => reason.code === code), JSON.stringify(result.reasons));
		assert.equal(f.counters.conditional, 0);
		assert.equal(f.counters.effects, 0);
	}
});

test("RET-N03 idle alone cannot settle unknown, paused, reserved or nonterminal actual work", async () => {
	/** @type {((f: ReturnType<typeof synthetic>) => void)[]} */
	const changes = [
		f => { f.state.activity = "unknown"; }, f => { f.state.activity = "busy"; },
		f => { f.state.taskStatus = "running"; }, f => { f.state.taskStatus = "blocked"; },
		f => { f.state.attemptStatus = "reserved"; }, f => { f.state.attemptStatus = "unknown"; },
		f => { f.state.runStatus = "paused"; }, f => { f.state.runStatus = "running"; },
		f => { f.state.runStatus = "pending"; }, f => { f.state.runStatus = "unknown"; },
	];
	for (const change of changes) {
		const f = synthetic();
		change(f);
		assert.equal((await f.native().archive(request)).status, "held");
		assert.equal(f.counters.effects, 0);
	}
});

test("RET-N03 closed decoders reject oversized pages, extra fields and self-declared complete inventory", async () => {
	for (const modify of [
		/** @param {Observation} value */ value => ({ ...value, complete: true }),
		/** @param {Observation} value */ value => ({ ...value, pages: Array.from({ length: 65 }, () => value.pages[0]) }),
		/** @param {Observation} value */ value => ({ ...value, pages: [] }),
		/** @param {Observation} value */ value => ({ ...value, activity: "probably-idle" }),
	]) {
		const f = synthetic();
		f.host.decodeObservation = raw => {
			assert.ok(typeof raw === "object" && raw !== null);
			return modify(/** @type {Observation} */ (raw));
		};
		assert.equal((await f.native().archive(request)).code, "observation-unconfirmed");
		assert.equal(f.counters.effects, 0);
	}
});

test("RET-N03/N06 correctly exhausted multiple pages and zero run inventory remain inspection, not authorization", async () => {
	const bound = subject();
	bound.runIds = [];
	const f = synthetic(bound);
	f.hooks.observation = value => {
		value.pages[0].next = "page-2";
		value.pages.push({ cursor: "page-2", next: null, sessions: [], attempts: [], runs: [] });
		return value;
	};
	const result = await f.native().inspect();
	assert.equal(result.status, "inspected");
	assert.equal(result.code, "inspection-only");
	assert.equal(f.counters.effects, 0);
	f.state.automation = true;
	assert.equal((await f.native().archive(request)).code, "attached-automation");
	assert.equal(f.counters.effects, 0);
});

test("RET-N05 canonical holds at reassessment prevent effect despite a previously eligible snapshot", async () => {
	const f = synthetic(), native = f.native();
	assert.equal((await native.inspect()).status, "inspected");
	f.hooks.beforeReassessment = () => { f.state.evaluator = true; };
	const result = await native.archive(request);
	assert.equal(result.status, "held");
	assert.ok(result.reasons.some(reason => reason.code === "evaluator-hold"));
	assert.equal(f.counters.conditional, 1);
	assert.equal(f.counters.effects, 0);
});

test("RET-N04 route loss before action-boundary reassessment preserves the subject without another route", async () => {
	const f = synthetic();
	f.hooks.beforeReassessment = () => { f.host.route = () => "disabled"; };
	const result = await f.native().archive(request);
	assert.equal(result.status, "held");
	assert.ok(result.reasons.some(reason => reason.code === "unsupported-route"));
	assert.equal(f.counters.conditional, 1);
	assert.equal(f.counters.effects, 0);
});

/** @type {[string, (f: ReturnType<typeof synthetic>) => void][]} */
const races = [
	["new-activity", f => { f.state.activity = "busy"; }],
	["new-activity", f => { f.state.runStatus = "running"; }],
	["attached-automation", f => { f.state.automation = true; }],
	["open-pr", f => { f.state.openPr = true; }],
	["agent-merge", f => { f.state.merge = true; }],
	["consumer-hold", f => { f.state.consumer = true; }],
	["evaluator-hold", f => { f.state.evaluator = true; }],
	["retention-lost", f => { f.state.retained = false; }],
	["identity-changed", f => { f.state.subject.child.sessionId = "new-native-identity"; }],
	["owner-changed", f => { f.state.context.sessionId = "other-coordinator"; }],
	["native-permission-denied", f => { f.state.permission = false; }],
];
for (const [index, [code, change]] of races.entries()) {
	test(`RET-N05 post-reassessment synthetic action-boundary race ${index + 1}: ${code}`, async () => {
		const f = synthetic();
		f.hooks.afterReassessment = () => { f.events.push(`change:${code}`); change(f); };
		const result = await f.native().archive(request);
		assert.equal(result.status, code === "native-permission-denied" ? "denied" : "held");
		assert.ok(result.reasons.some(reason => reason.code === code));
		assert.equal(f.counters.conditional, 1);
		assert.equal(f.counters.effects, 0);
		assert.deepEqual(f.events.slice(-4), ["final-reassessment", `change:${code}`, "attempted-archive-effect", code === "native-permission-denied" ? "permission-denied" : "guard-held"]);
		console.log(JSON.stringify({ case: code, trace: f.events, effects: f.counters.effects, reasons: result.reasons }));
	});
}

/** @param {string} directory @param {string[]} args */
function git(directory, args) {
	const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}

/** No cleanup effect: preserve fixture bytes and the trace in the unique runner root. */
function workspace() {
	const root = process.env.FOUNDRY_PARALLEL_SCRATCH;
	assert.ok(root, "Use the confined parallel runner");
	assert.equal(realpathSync(root), root);
	const directory = mkdtempSync(path.join(root, "retention-git-"));
	git(directory, ["init", "--quiet"]);
	git(directory, ["config", "user.email", "synthetic@example.invalid"]);
	git(directory, ["config", "user.name", "Synthetic retention fixture"]);
	writeFileSync(path.join(directory, "tracked.txt"), "retained original\n");
	writeFileSync(path.join(directory, ".gitignore"), "ignored.txt\n");
	git(directory, ["add", "tracked.txt", ".gitignore"]);
	git(directory, ["commit", "--quiet", "-m", "Synthetic fixture"]);
	return {
		directory,
		/** @returns {Observation["workspace"]} */
		read() {
			const records = git(directory, ["status", "--porcelain=v1", "--ignored", "--untracked-files=all", "-z"]).split("\0").filter(Boolean);
			return {
				tracked: records.filter(line => !line.startsWith("??") && !line.startsWith("!!")).map(line => line.slice(3)),
				untracked: records.filter(line => line.startsWith("??")).map(line => line.slice(3)),
				ignored: records.filter(line => line.startsWith("!!")).map(line => line.slice(3)),
			};
		},
	};
}

for (const kind of /** @type {const} */ (["tracked", "untracked", "ignored"])) {
	test(`RET-N05 real confined Git ${kind} bytes written after final reassessment remain intact with zero archive effects`, async () => {
		const repository = workspace(), bound = subject();
		bound.child.worktreePath = repository.directory;
		const f = synthetic(bound);
		f.hooks.workspace = () => repository.read();
		const filename = `${kind}.txt`, bytes = Buffer.from(`new ${kind} bytes after final reassessment\n\0preserve all bytes\n`);
		f.hooks.afterReassessment = () => {
			assert.deepEqual(repository.read(), { tracked: [], untracked: [], ignored: [] });
			assert.equal(f.events.at(-1), "final-reassessment");
			writeFileSync(path.join(repository.directory, filename), bytes);
			f.events.push(`write:${kind}`);
		};
		const result = await f.native().archive(request);
		assert.equal(result.status, "held");
		assert.ok(result.reasons.some(reason => reason.code === `workspace-${kind}` && reason.message.includes(filename)));
		assert.equal(f.counters.conditional, 1);
		assert.equal(f.counters.effects, 0);
		assert.deepEqual(readFileSync(path.join(repository.directory, filename)), bytes);
		assert.deepEqual(repository.read()[kind], [filename]);
		assert.deepEqual(f.events.slice(-4), ["final-reassessment", `write:${kind}`, "attempted-archive-effect", "guard-held"]);
		const evidence = { kind, repository: repository.directory, trace: f.events, effects: f.counters.effects, preservedHex: bytes.toString("hex"), reasons: result.reasons, result };
		writeFileSync(path.join(path.dirname(repository.directory), `workspace-${kind}-trace.json`), `${JSON.stringify(evidence, null, 2)}\n`);
		console.log(JSON.stringify({ case: `workspace-${kind}`, trace: f.events, effects: 0, bytesPreserved: true, reasons: result.reasons }));
	});
}

test("RET-N06 supported synthetic execution uses only the exact bound native archive operation and raw receipt", async () => {
	const f = synthetic();
	const result = await f.native().archive(request);
	assert.equal(result.status, "archived");
	assert.equal(f.counters.effects, 1);
	assert.equal(f.counters.observations, 2);
	assert.equal(f.counters.conditional, 1);
	assert.equal(result.receipt, f.lastReceipt);
	assert.ok(result.evidence.some(item => item.phase === "archive" && item.raw === f.lastReceipt?.raw));
	assert.equal(result.intentId, request.intentId);
	assert.deepEqual(result.subject, f.bound);
});

test("RET-N07 all thrown native errors and raw results remain original evidence, without receipt fabrication or retry", async () => {
	for (const afterEffect of [false, true]) {
		const f = synthetic(), error = Object.assign(new Error("transport lost"), { code: "EPIPE", detail: { original: true } });
		if (afterEffect) f.hooks.reply = () => { throw error; };
		else f.host.conditionalArchive = async () => { f.counters.conditional++; throw error; };
		const result = await f.native().archive(request);
		assert.equal(result.status, "uncertain");
		assert.equal(result.receipt, null);
		assert.ok(result.evidence.some(item => item.error === error));
		assert.equal(f.counters.conditional, 1);
		assert.equal(f.counters.effects, afterEffect ? 1 : 0);
		const resolved = await f.native().reconcile(result);
		assert.equal(resolved.status, "uncertain");
		assert.equal(resolved.receipt, null);
		assert.equal(f.counters.conditional, 1);
	}
});

test("RET-N07 permission denial, disabled native failure and malformed or foreign receipts retain exact raw evidence", async () => {
	/** @type {unknown[]} */
	const raws = [
		{ resultType: "failure", error: "This session management tool is disabled" },
		{ status: "archived" }, null, "lost native result",
		{ ...fauxDisposition(), intentId: "foreign-intent" },
		{ ...fauxDisposition(), operation: "delete_item" },
		{ ...fauxDisposition(), subject: { ...subject(), coordinatorSessionId: "foreign" } },
		{ ...fauxDisposition(), status: "archived", reasons: [{ code: "conflict", message: "Inconsistent success" }] },
	];
	for (const raw of raws) {
		const f = synthetic();
		f.host.conditionalArchive = async () => {
			f.counters.conditional++;
			return { source: "original native response", raw };
		};
		const result = await f.native().archive(request);
		assert.equal(result.status, "uncertain");
		assert.equal(result.receipt?.raw, raw);
		assert.ok(result.evidence.some(item => item.raw === raw));
		assert.equal(f.counters.conditional, 1);
		assert.equal(f.counters.effects, 0);
	}
	const f = synthetic();
	const raw = { ...fauxDisposition(), status: "denied", reasons: [{ code: "native-denied", message: "Native permission denied" }] };
	f.host.conditionalArchive = async () => ({ source: "native denial", raw });
	const result = await f.native().archive(request);
	assert.equal(result.status, "denied");
	assert.equal(result.receipt?.raw, raw);
	assert.equal(f.counters.effects, 0);
});

function fauxDisposition() {
	return { subject: subject(), intentId: request.intentId, operation: "archive_session", status: "archived", reasons: [] };
}

test("RET-N07 broken conditional host implementations cannot claim success without exactly one successful reassessment", async () => {
	for (const mode of ["missing", "duplicate", "held"]) {
		const f = synthetic();
		f.host.conditionalArchive = async ({ reassess }) => {
			f.counters.conditional++;
			if (mode === "held") f.state.consumer = true;
			if (mode !== "missing") await reassess();
			if (mode === "duplicate") await reassess();
			return f.receipt(request.intentId, "archived");
		};
		assert.equal((await f.native().archive(request)).status, "uncertain");
		assert.equal(f.counters.effects, 0);
	}
});

test("RET-N07 observation, policy and decoder errors retain their original error and cannot invoke archive", async () => {
	for (const phase of ["observation", "policy", "decoder", "route"]) {
		const f = synthetic(), error = new Error(`original ${phase} error`);
		if (phase === "observation") f.host.observe = async () => { throw error; };
		if (phase === "policy") f.host.assess = async () => { throw error; };
		if (phase === "decoder") f.host.decodeObservation = () => { throw error; };
		if (phase === "route") f.host.route = () => { throw error; };
		const result = await f.native().archive(request);
		assert.ok(result.evidence.some(item => item.error === error));
		assert.equal(f.counters.conditional, 0);
		assert.equal(f.counters.effects, 0);
	}
});

test("RET-N07 decoder mutation cannot overwrite retained raw native responses", async () => {
	const f = synthetic();
	f.host.decodeObservation = raw => {
		assert.ok(typeof raw === "object" && raw !== null);
		Reflect.set(raw, "activity", "busy");
		return raw;
	};
	const result = await f.native().inspect();
	assert.equal(result.code, "activity-unsettled");
	const evidence = result.evidence.find(item => item.phase === "observation");
	assert.ok(evidence?.raw && typeof evidence.raw === "object");
	assert.equal(Reflect.get(evidence.raw, "activity"), "idle");
});

test("RET-N08 matching read-only reconciliation preserves the original receipt and does not replay the effect", async () => {
	const f = synthetic(), native = f.native();
	const original = await native.archive(request);
	f.reconciliation({ source: "synthetic authoritative operation record", raw: { ...fauxDisposition(), basis: "native-operation" } });
	for (let replay = 0; replay < 2; replay++) {
		const resolved = await native.reconcile(original);
		assert.equal(resolved.status, "archived");
		assert.equal(resolved.receipt, original.receipt);
		assert.deepEqual(resolved.evidence.slice(0, original.evidence.length), original.evidence);
	}
	assert.equal(f.counters.conditional, 1);
	assert.equal(f.counters.effects, 1);
	assert.equal(f.counters.reconciliations, 2);
});

test("RET-N08 uncertain results resolve only with exact authoritative operation evidence; absence and conflicts remain unresolved", async () => {
	const f = synthetic(), error = new Error("result lost after effect");
	f.hooks.reply = () => { throw error; };
	const native = f.native(), original = await native.archive(request);
	const rawCases = [
		{ absent: true, worktreeExists: false },
		{ ...fauxDisposition(), basis: "worktree-absence" },
		{ ...fauxDisposition(), basis: "native-operation", intentId: "foreign" },
		{ ...fauxDisposition(), basis: "native-operation", subject: { ...subject(), runIds: ["foreign"] } },
	];
	for (const raw of rawCases) {
		f.reconciliation({ source: "uncorroborated observation", raw });
		const resolved = await native.reconcile(original);
		assert.equal(resolved.status, "uncertain");
		assert.equal(resolved.receipt, null);
		assert.ok(resolved.evidence.some(item => item.error === error));
		assert.ok(resolved.evidence.some(item => item.raw === raw));
	}
	f.reconciliation({ source: "synthetic authoritative exact operation", raw: { ...fauxDisposition(), basis: "native-operation" } });
	const resolved = await native.reconcile(original);
	assert.equal(resolved.status, "archived");
	assert.equal(resolved.receipt, null, "Do not replace a missing original receipt with a generated success");
	assert.ok(resolved.evidence.some(item => item.error === error));
	assert.equal(f.counters.effects, 1);
	assert.equal(f.counters.conditional, 1);
	f.reconciliation({ source: "conflicting disposition", raw: { ...fauxDisposition(), basis: "native-operation", status: "not-archived", reasons: [{ code: "not-executed", message: "Synthetic contradiction" }] } });
	assert.equal((await native.reconcile(resolved)).code, "conflicting-disposition");
});

test("RET-N08 reconciliation holds foreign ownership, absent capabilities and thrown observations without mutation", async () => {
	const f = synthetic(), native = f.native();
	const original = await native.archive(request);
	f.state.context.owner = "foreign";
	assert.equal((await native.reconcile(original)).code, "foreign-subject");
	assert.equal(f.counters.reconciliations, 0);
	f.state.context.owner = f.bound.attempt.owner;
	const error = new Error("native reconciliation unavailable");
	f.host.observeOutcome = async () => { throw error; };
	const failed = await native.reconcile(original);
	assert.equal(failed.status, "uncertain");
	assert.ok(failed.evidence.some(item => item.error === error));
	delete f.host.decodeReconciliation;
	assert.equal((await native.reconcile(original)).code, "unsupported-reconciliation");
	await assert.rejects(native.reconcile({ ...original, subject: { ...original.subject, runIds: ["different"] } }), /another subject/);
	assert.equal(f.counters.effects, 1);
	assert.equal(f.counters.conditional, 1);
});

test("RET-N06 source has no effect API except the injected conditional archive and no policy/persistence imports", () => {
	const source = readFileSync(new URL("../../native/retention.mjs", import.meta.url), "utf8");
	const imports = [...source.matchAll(/^import .* from "([^"]+)";/gm)].map(match => match[1]);
	assert.deepEqual(imports, ["node:path", "../digest.mjs", "../factory/fields.mjs", "../plan/parallel-contracts.mjs", "./dispatch.mjs"]);
	assert.doesNotMatch(source, /\b(?:spawn|execFile|rmSync|unlink|terminate|cancelSession|delete_item|worktree remove)\s*\(/);
	assert.doesNotMatch(source, /(?:session\.rpc|tools\.execute|workflow\.run)\s*[.(]/);
	assert.match(source, /await host\.conditionalArchive\(/);
});
