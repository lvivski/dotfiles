import assert from "node:assert/strict";
import test from "node:test";
import { readRecord } from "../../data.mjs";
import { verificationMarker } from "../../marker.mjs";
import { createWorkflowAnalysis } from "../../workflow.mjs";
import { fakeApi } from "./api.mjs";
import { reservedPlan } from "./plans.mjs";

test("discoverVerificationRun is base-agnostic and reports duplicates", async () => {
	const plan = reservedPlan("find-reservation");
	const marker = verificationMarker(plan.verification.reservationId);
	const records = {
		match: {
			workflowName: "verify",
			run: { runId: "match", status: "running" },
			progress: ["earlier runtime record", marker, "later progress"],
			seqBase: 1,
		},
		foreign: {
			workflowName: "verify",
			run: { runId: "foreign", status: "running" },
			progress: [verificationMarker("other-reservation")],
		},
	};
	const analysis = createWorkflowAnalysis(() => fakeApi(records));
	const found = await analysis.discoverVerificationRun(
		plan.verification.reservationId,
		plan.verification.reservedAt,
	);
	assert.equal(found.state, "found");
	assert.equal(found.run.runId, "match");

	const malformedTimestamp = createWorkflowAnalysis(() => fakeApi({
		match: {
			workflowName: "verify",
			run: { runId: "match", status: "running" },
			createdAt: Number.NaN,
			progress: [marker],
		},
	}));
	const recovered = await malformedTimestamp.discoverVerificationRun(
		plan.verification.reservationId,
		plan.verification.reservedAt,
	);
	assert.equal(recovered.state, "found");
	assert.equal(recovered.run.runId, "match");

	const ambiguous = createWorkflowAnalysis(() => fakeApi({
		first: {
			workflowName: "verify",
			run: { runId: "first", status: "running" },
			progress: [marker],
		},
		second: {
			workflowName: "verify",
			run: { runId: "second", status: "running" },
			progress: [marker],
		},
	}));
	const duplicate = await ambiguous.discoverVerificationRun(
		plan.verification.reservationId,
		plan.verification.reservedAt,
	);
	assert.equal(duplicate.state, "inconclusive");
	assert.deepEqual(duplicate.candidates?.map((run) => run.runId), [
		"first",
		"second",
	]);
});

test("discoverVerificationRun distinguishes absent from inconclusive", async () => {
	const plan = reservedPlan("tri-state-reservation");
	const marker = verificationMarker(plan.verification.reservationId);
	const active = createWorkflowAnalysis(() => fakeApi({
		pending: {
			workflowName: "verify",
			run: { runId: "pending", status: "pending" },
			progress: [],
		},
	}));
	assert.equal(
		(await active.discoverVerificationRun(
			plan.verification.reservationId,
			plan.verification.reservedAt,
		)).state,
		"inconclusive",
	);

	const terminal = createWorkflowAnalysis(() => fakeApi({
		failed: {
			workflowName: "verify",
			run: { runId: "failed", status: "error" },
			progress: [],
		},
	}));
	assert.deepEqual(
		await terminal.discoverVerificationRun(
			plan.verification.reservationId,
			plan.verification.reservedAt,
		),
		{ state: "absent" },
	);

	const malformedActive = createWorkflowAnalysis(() => fakeApi({
		pending: {
			workflowName: "verify",
			run: { runId: "pending", status: "pending" },
			createdAt: Number.NaN,
			progress: [],
		},
	}));
	assert.equal(
		(await malformedActive.discoverVerificationRun(
			plan.verification.reservationId,
			plan.verification.reservedAt,
		)).state,
		"inconclusive",
	);

	const malformedTerminal = createWorkflowAnalysis(() => fakeApi({
		failed: {
			workflowName: "verify",
			run: { runId: "failed", status: "error" },
			createdAt: Number.NaN,
			progressUnavailable: true,
		},
	}));
	const unknownTerminal = await malformedTerminal.discoverVerificationRun(
		plan.verification.reservationId,
		plan.verification.reservedAt,
	);
	assert.equal(unknownTerminal.state, "inconclusive");
	assert.deepEqual(
		unknownTerminal.candidates?.map((candidate) => candidate.runId),
		[],
	);
	assert.deepEqual(
		unknownTerminal.unattributable?.map((candidate) => candidate.runId),
		["failed"],
	);

	const attributableMatch = createWorkflowAnalysis(() => fakeApi({
		matched: {
			workflowName: "verify",
			run: { runId: "matched", status: "completed" },
			progress: [marker],
		},
		stale: {
			workflowName: "verify",
			run: { runId: "stale", status: "error" },
			createdAt: Number.NaN,
			progressUnavailable: true,
		},
	}));
	const unresolvedHistory = await attributableMatch.discoverVerificationRun(
		plan.verification.reservationId,
		plan.verification.reservedAt,
	);
	assert.equal(unresolvedHistory.state, "inconclusive");
	assert.deepEqual(unresolvedHistory.candidates.map((run) => run.runId), ["matched"]);
	assert.deepEqual(unresolvedHistory.unattributable?.map((run) => run.runId), ["stale"]);
});

test("discovery finds an older terminal run using native terminal-window cursors", async () => {
	const plan = reservedPlan("older-run");
	const marker = verificationMarker(plan.verification.reservationId);
	for (const seqBase of [0, 1, 37]) {
		const api = fakeApi({
			match: {
				workflowName: "verify",
				run: { runId: "match", status: "completed" },
				progress: [marker, ...Array.from({ length: 220 }, () => "later progress")],
				seqBase,
			},
			active: {
				workflowName: "verify",
				run: { runId: "active", status: "running" },
				progress: [verificationMarker("foreign-reservation")],
			},
			newest: {
				workflowName: "plan",
				run: { runId: "newest", status: "completed" },
			},
		}, { pageSize: 1, seqBase });
		const result = await createWorkflowAnalysis(() => api).discoverVerificationRun(
			plan.verification.reservationId,
			plan.verification.reservedAt,
		);
		assert.equal(result.state, "found");
		assert.equal(result.run.runId, "match");
		assert.deepEqual(api.listCalls, [
			{ limit: 200 },
			{ limit: 200, beforeSeq: seqBase + 2 },
		]);
		assert.equal(api.detailCalls.filter((runId) => runId === "active").length, 1);
	}
});

test("discovery rejects duplicate reservations across terminal pages", async () => {
	const plan = reservedPlan("paged-duplicates");
	const marker = verificationMarker(plan.verification.reservationId);
	const api = fakeApi(Object.fromEntries(["older", "newer"].map((runId) => [
		runId,
		{
			workflowName: "verify",
			run: { runId, status: "completed" },
			progress: [marker],
		},
	])), { pageSize: 1 });
	const result = await createWorkflowAnalysis(() => api).discoverVerificationRun(
		plan.verification.reservationId,
		plan.verification.reservedAt,
	);
	assert.equal(result.state, "inconclusive");
	assert.match(result.reason, /multiple Workflow runs/);
	assert.deepEqual(result.candidates.map((run) => run.runId).sort(), ["newer", "older"]);
	assert.equal(api.listCalls.length, 2);
});

test("discovery requires one reservation across the complete progress history", async () => {
	const plan = reservedPlan("progress-identity");
	const marker = verificationMarker(plan.verification.reservationId);
	for (const seqBase of [0, 1, 37]) {
		for (const foreign of [false, true]) {
			for (const paged of [false, true]) {
				const api = fakeApi({
					match: {
						workflowName: "verify",
						run: { runId: "match", status: "running" },
						progress: [
							foreign ? verificationMarker("foreign-reservation") : marker,
							...Array.from({ length: paged ? 220 : 0 }, () => "later progress"),
							marker,
						],
						seqBase,
					},
				});
				const analysis = createWorkflowAnalysis(() => api);
				const result = await analysis.discoverVerificationRun(
					plan.verification.reservationId, plan.verification.reservedAt,
				);
				if (foreign) {
					assert.equal(result.state, "inconclusive");
					assert.match(result.candidates[0].reason ?? "", /ambiguous/);
					await assert.rejects(analysis.importVerification("match", plan, { wait: false }), {
						code: "workflow_progress_inconclusive",
					});
				} else {
					assert.equal(result.state, "found");
					assert.equal(result.run.runId, "match");
				}
			}
		}
	}
});

test("a visible marker cannot establish identity from incomplete progress", async () => {
	const plan = reservedPlan("partial-progress");
	const marker = verificationMarker(plan.verification.reservationId);
	/** @type {Array<[Record<string, unknown>, RegExp]>} */
	const metadata = [
		[{ hasMoreNewer: true }, /progress-newer/],
		[{ hasMoreNewer: undefined }, /progress-newer/],
		[{ hasMoreOlder: undefined }, /progress-history/],
		[{ hasMoreOlder: null }, /progress-history/],
		[{ hasMoreOlder: "false" }, /progress-history/],
		[{ oldestSeq: null }, /progress-cursor/],
		[{ oldestSeq: 0.5 }, /progress-cursor/],
	];
	for (const [patch, reason] of metadata) {
		const api = fakeApi({
			match: {
				workflowName: "verify",
				run: { runId: "match", status: "running" },
				progress: [marker, ...Array.from({ length: 220 }, () => "progress"), marker],
			},
		});
		const getRunDetail = api.getRunDetail;
		api.getRunDetail = async (runId) => {
			const detail = readRecord(await getRunDetail(runId));
			return { ...detail, progress: { ...readRecord(detail.progress), ...patch } };
		};
		const result = await createWorkflowAnalysis(() => api).discoverVerificationRun(
			plan.verification.reservationId, plan.verification.reservedAt,
		);
		assert.equal(result.state, "inconclusive");
		assert.match(result.candidates[0].reason ?? "", reason);
	}
	for (const failedPage of [null, { records: null }, { records: [] }, new Error("older progress unavailable")]) {
		const api = fakeApi({
			match: {
				workflowName: "verify",
				run: { runId: "match", status: "running" },
				progress: [marker, ...Array.from({ length: 220 }, () => "progress"), marker],
			},
		});
		api.getRunProgress = async () => {
			if (failedPage instanceof Error) throw failedPage;
			return failedPage;
		};
		const result = await createWorkflowAnalysis(() => api).discoverVerificationRun(
			plan.verification.reservationId, plan.verification.reservedAt,
		);
		assert.equal(result.state, "inconclusive");
		assert.match(result.candidates[0].reason ?? "", /progress-(unavailable|history)|older progress unavailable/);
	}
});

test("progress cursors must advance even when a page claims to finish history", async () => {
	const plan = reservedPlan("stalled-progress");
	const marker = verificationMarker(plan.verification.reservationId);
	for (const hasMoreOlder of [false, true]) {
		for (const offset of [-1, 0, 1]) {
			const api = fakeApi({
				match: {
					workflowName: "verify",
					run: { runId: "match", status: "running" },
					progress: [marker, ...Array.from({ length: 220 }, () => "progress"), marker],
				},
			});
			let reads = 0;
			api.getRunProgress = async (_runId, options) => {
				reads++;
				assert.equal(typeof options?.beforeSeq, "number");
				const seq = Number(options?.beforeSeq) + offset;
				const newestSeq = Math.max(seq, Number(options?.beforeSeq));
				return {
					records: [
						{ seq, kind: "log", text: marker },
						{ seq: newestSeq, kind: "log", text: "overlapping progress" },
					],
					oldestSeq: seq, newestSeq, hasMoreOlder, hasMoreNewer: true,
				};
			};
			const result = await createWorkflowAnalysis(() => api).discoverVerificationRun(
				plan.verification.reservationId, plan.verification.reservedAt,
			);
			assert.equal(result.state, "inconclusive");
			assert.match(result.candidates[0].reason ?? "", /progress-cursor/);
			assert.equal(reads, 1);
		}
	}
});

test("progress discovery exhausts complete history beyond the former page cutoff", async () => {
	const plan = reservedPlan("bounded-progress");
	const marker = verificationMarker(plan.verification.reservationId);
	const api = fakeApi({
		match: {
			workflowName: "verify",
			run: { runId: "match", status: "running" },
			progress: [marker, ...Array.from({ length: 5000 }, () => "progress"), marker],
		},
	});
	let reads = 0;
	const getRunProgress = api.getRunProgress;
	api.getRunProgress = async (runId, options) => {
		reads++;
		return getRunProgress(runId, options);
	};
	const result = await createWorkflowAnalysis(() => api).discoverVerificationRun(
		plan.verification.reservationId, plan.verification.reservedAt,
	);
	assert.equal(result.state, "found");
	assert.equal(result.run.runId, "match");
	assert.equal(reads, 10);
});

test("discovery rejects mismatched detail and result identities despite matching markers", async () => {
	const plan = reservedPlan("mismatched-progress");
	for (const mismatch of ["detail-run", "workflow", "result-run"]) {
		const api = fakeApi({
			match: {
				workflowName: "verify",
				run: { runId: "match", status: "completed" },
				progress: [verificationMarker(plan.verification.reservationId)],
			},
		});
		const getRunDetail = api.getRunDetail;
		api.getRunDetail = async (runId) => ({
			...readRecord(await getRunDetail(runId)),
			...(mismatch === "detail-run" ? { runId: "foreign" } : {}),
			...(mismatch === "workflow" ? { workflowName: "audit" } : {}),
		});
		if (mismatch === "result-run") {
			api.getRun = async () => ({ runId: "foreign", status: "completed" });
		}
		const result = await createWorkflowAnalysis(() => api).discoverVerificationRun(
			plan.verification.reservationId, plan.verification.reservedAt,
		);
		assert.equal(result.state, "inconclusive");
		assert.match(result.candidates[0].reason ?? "", /identity does not match|belongs to another run/);
		assert.deepEqual(api.cancelCalls, []);
	}
});

test("repeated active runs are inspected once and unmarked runs still block uniqueness", async () => {
	const plan = reservedPlan("repeated-active");
	for (const unmarked of [false, true]) {
		const api = fakeApi({
			older: {
				workflowName: "plan",
				run: { runId: "older", status: "completed" },
			},
			active: {
				workflowName: "verify",
				run: { runId: "active", status: "running" },
				progress: [verificationMarker(plan.verification.reservationId)],
			},
			pending: {
				workflowName: "verify",
				run: { runId: "pending", status: "pending" },
				progress: unmarked ? [] : [verificationMarker("another-reservation")],
			},
			newer: {
				workflowName: "plan",
				run: { runId: "newer", status: "completed" },
			},
		}, { pageSize: 1 });
		const result = await createWorkflowAnalysis(() => api).discoverVerificationRun(
			plan.verification.reservationId,
			plan.verification.reservedAt,
		);
		if (unmarked) {
			assert.equal(result.state, "inconclusive");
			assert.deepEqual(result.candidates.map((run) => run.runId), ["active", "pending"]);
		} else {
			assert.equal(result.state, "found");
			assert.equal(result.run.runId, "active");
		}
		assert.deepEqual(api.detailCalls, ["active", "pending"]);
		assert.equal(api.listCalls.length, 2);
	}
});

test("discovery establishes absence only after complete native history", async () => {
	const plan = reservedPlan("complete-absence");
	const api = fakeApi({
		stale: {
			workflowName: "verify",
			run: { runId: "stale", status: "completed" },
			createdAt: Date.parse(plan.verification.reservedAt) - 1,
			progressUnavailable: true,
		},
		foreign: {
			workflowName: "verify",
			run: { runId: "foreign", status: "completed" },
			progress: [verificationMarker("another-reservation")],
		},
		unmarked: {
			workflowName: "verify",
			run: { runId: "unmarked", status: "error" },
			progress: [],
		},
	}, { pageSize: 1 });
	assert.deepEqual(
		await createWorkflowAnalysis(() => api).discoverVerificationRun(
			plan.verification.reservationId,
			plan.verification.reservedAt,
		),
		{ state: "absent" },
	);
	assert.equal(api.listCalls.length, 3);
	assert.equal(api.detailCalls.includes("stale"), false);
	assert.deepEqual(
		await createWorkflowAnalysis(() => fakeApi()).discoverVerificationRun(
			plan.verification.reservationId,
			plan.verification.reservedAt,
		),
		{ state: "absent" },
	);
});

test("complete discovery beyond the former page cutoff finds old matches without concealing duplicates", async () => {
	const plan = reservedPlan("bounded-history");
	const marker = verificationMarker(plan.verification.reservationId);
	for (const visibleMatch of [false, true]) {
		const api = fakeApi(Object.fromEntries(Array.from({ length: 11 }, (_, index) => {
			const runId = `run-${index}`;
			return [runId, {
				workflowName: index === 0 || (visibleMatch && index === 10) ? "verify" : "plan",
				run: { runId, status: "completed" },
				progress: [marker],
			}];
		})), { pageSize: 1 });
		const result = await createWorkflowAnalysis(() => api).discoverVerificationRun(
			plan.verification.reservationId,
			plan.verification.reservedAt,
		);
		assert.equal(api.listCalls.length, 11);
		assert.equal(api.detailCalls.includes("run-0"), true);
		if (visibleMatch) {
			assert.equal(result.state, "inconclusive");
			assert.deepEqual(new Set(result.candidates.map((run) => run.runId)), new Set(["run-10", "run-0"]));
		} else {
			assert.equal(result.state, "found");
			assert.equal(result.run.runId, "run-0");
		}
	}
});

test("empty pages with older cursors continue discovery rather than proving absence", async () => {
	const plan = reservedPlan("empty-page");
	const api = fakeApi({
		match: {
			workflowName: "verify",
			run: { runId: "match", status: "completed" },
			progress: [verificationMarker(plan.verification.reservationId)],
		},
		newer: {
			workflowName: "plan",
			run: { runId: "newer", status: "completed" },
		},
	}, { pageSize: 1 });
	const listRuns = api.listRuns;
	api.listRuns = async (options) => {
		const page = await listRuns(options);
		return options?.beforeSeq === undefined ? { ...readRecord(page), runs: [] } : page;
	};
	const result = await createWorkflowAnalysis(() => api).discoverVerificationRun(
		plan.verification.reservationId,
		plan.verification.reservedAt,
	);
	assert.equal(result.state, "found");
	assert.equal(result.run.runId, "match");
	assert.equal(api.listCalls.length, 2);
});

test("missing or unusable run-history metadata is inconclusive even with a match", async () => {
	const plan = reservedPlan("unknown-history");
	const record = {
		workflowName: "verify",
		run: { runId: "match", status: "completed" },
		progress: [verificationMarker(plan.verification.reservationId)],
	};
	const summary = {
		runId: "match",
		workflowName: "verify",
		status: "completed",
		createdAt: Date.parse(plan.verification.reservedAt),
	};
	/** @type {Array<[Record<string, unknown>, RegExp]>} */
	const cases = [
		[{ hasMoreNewer: false }, /unknown omitted older history/],
		[{ hasMoreNewer: false, omittedOlder: -1 }, /unknown omitted older history/],
		[{ hasMoreNewer: false, omittedOlder: 1, oldestSeq: null }, /older cursor/],
		[{ hasMoreNewer: false, omittedOlder: 1, oldestSeq: 0.5 }, /older cursor/],
		[{ hasMoreNewer: true, omittedOlder: 0 }, /unresolved newer history/],
		[{ omittedOlder: 0 }, /unresolved newer history/],
	];
	for (const runs of [[], [summary]]) {
		for (const [metadata, reason] of cases) {
			const api = fakeApi({ match: record });
			api.listRuns = async () => ({ runs, ...metadata });
			const result = await createWorkflowAnalysis(() => api).discoverVerificationRun(
				plan.verification.reservationId,
				plan.verification.reservedAt,
			);
			assert.equal(result.state, "inconclusive");
			assert.match(result.reason, reason);
			assert.deepEqual(result.candidates.map((run) => run.runId), runs.map((run) => run.runId));
		}
	}
	for (const invalidPage of [null, [], { runs: null }]) {
		const api = fakeApi();
		api.listRuns = async () => invalidPage;
		const result = await createWorkflowAnalysis(() => api).discoverVerificationRun(
			plan.verification.reservationId,
			plan.verification.reservedAt,
		);
		assert.equal(result.state, "inconclusive");
		assert.match(result.reason, /listing is unavailable/);
	}
});

test("discovery stops on a nonadvancing older cursor", async () => {
	const plan = reservedPlan("stalled-cursor");
	for (const nextCursor of [42, 43]) {
		const api = fakeApi();
		let reads = 0;
		api.listRuns = async () => ({
			runs: [],
			hasMoreNewer: reads > 0,
			oldestSeq: reads++ === 0 ? 42 : nextCursor,
			omittedOlder: 1,
		});
		const result = await createWorkflowAnalysis(() => api).discoverVerificationRun(
			plan.verification.reservationId,
			plan.verification.reservedAt,
		);
		assert.equal(result.state, "inconclusive");
		assert.match(result.reason, /no advancing older cursor/);
		assert.equal(reads, 2);
	}
});

test("unreadable run pages and progress never establish absence or uniqueness", async () => {
	const plan = reservedPlan("unreadable-history");
	const marker = verificationMarker(plan.verification.reservationId);
	const failures = [new Error("run page unavailable"), new Error(), ""];
	for (const { failOnPage, failure } of [0, 1].flatMap((failOnPage) =>
		failures.map((failure) => ({ failOnPage, failure })),
	)) {
		const api = fakeApi({
			older: {
				workflowName: "plan",
				run: { runId: "older", status: "completed" },
			},
			match: {
				workflowName: "verify",
				run: { runId: "match", status: "completed" },
				progress: [marker],
			},
		}, { pageSize: 1 });
		const listRuns = api.listRuns;
		api.listRuns = async (options) => {
			if (api.listCalls.length === failOnPage) throw failure;
			return listRuns(options);
		};
		const result = await createWorkflowAnalysis(() => api).discoverVerificationRun(
			plan.verification.reservationId,
			plan.verification.reservedAt,
		);
		assert.equal(result.state, "inconclusive");
		assert.equal(result.reason, failure instanceof Error ? failure.message : failure);
		assert.deepEqual(result.candidates.map((run) => run.runId), failOnPage ? ["match"] : []);
	}
	for (const failedMethod of /** @type {const} */ (["getRunDetail", "getRunProgress"])) {
		const api = fakeApi({
			unreadable: {
				workflowName: "verify",
				run: { runId: "unreadable", status: "completed" },
				progress: [marker, ...Array.from({ length: 220 }, () => "later progress")],
			},
		});
		api[failedMethod] = async () => { throw new Error("progress unavailable"); };
		const result = await createWorkflowAnalysis(() => api).discoverVerificationRun(
			plan.verification.reservationId,
			plan.verification.reservedAt,
		);
		assert.equal(result.state, "inconclusive");
		assert.deepEqual(result.candidates.map((run) => run.runId), ["unreadable"]);
		assert.match(result.candidates[0].reason ?? "", /progress unavailable/);
	}
});

test("native workflow lookup codes identify missing runs without matching error text", async () => {
	for (const details of [
		{ code: "workflow_run_not_found" },
		{ data: { code: "workflow_run_not_found" } },
		{ cause: { code: "workflow_run_not_found" } },
		{ cause: { data: { code: "workflow_run_not_found" } } },
		{ code: "not_found" },
	]) {
		const failure = Object.assign(new Error("Lookup failed"), details);
		const api = fakeApi();
		api.getRun = api.getRunDetail = async () => { throw failure; };
		const analysis = createWorkflowAnalysis(() => api);
		await assert.rejects(
			analysis.importPlanning("missing"),
			{
				name: "FoundryWorkflowError",
				code: "workflow_run_not_found",
				details: { runId: "missing" },
			},
		);
		assert.equal(await analysis.verificationRunIsTerminal("missing"), false);
	}
});

test("unrelated Workflow read failures are never treated as missing runs", async () => {
	const api = {
		async getRun() {
			throw new Error("unknown accounting state");
		},
		async getRunDetail() {
			throw new Error("unknown accounting state");
		},
		async listRuns() {
			throw new Error("unknown accounting state");
		},
		async getRunProgress() {
			throw new Error("unknown accounting state");
		},
	};
	const analysis = createWorkflowAnalysis(() => api);
	await assert.rejects(
		analysis.verificationRunIsTerminal("run"),
		/unknown accounting state/,
	);
});
