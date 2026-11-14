import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, constants, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { isList, parseJson, readRecord } from "../../data.mjs";
import { createArtifactRetention } from "../../native/artifacts.mjs";
import { planArtifactRetention } from "../../plan/artifacts.mjs";

test("LP13 pinned parent spill decoder preserves complete unchanged originals and rejects unavailable readback", {
	skip: !process.env.FOUNDRY_EXACT_REPORT_PREFLIGHT_MANIFEST,
}, async t => {
	const manifestPath = process.env.FOUNDRY_EXACT_REPORT_PREFLIGHT_MANIFEST;
	assert.ok(manifestPath);
	/** @param {Buffer} bytes */
	const hash = bytes => createHash("sha256").update(bytes).digest("hex");
	const manifestBytes = readFileSync(manifestPath);
	assert.equal(hash(manifestBytes), "3dbf1049bb9d2f607ef867ac96eb0ccc72b87afa8078b1142c0a6dab28b1e31d");
	const sources = readRecord(readRecord(parseJson(manifestBytes.toString("utf8"))).sources);
	/** @param {string} name */
	const original = name => {
		const entry = readRecord(sources[name]);
		assert.ok(typeof entry.path === "string");
		const bytes = readFileSync(entry.path);
		assert.equal(bytes.length, entry.bytes);
		assert.equal(hash(bytes), entry.sha256);
		return { bytes, path: entry.path };
	};
	const helper = original("exact-report-helper-original.mjs");
	const { decodeNativeValue } = await import(pathToFileURL(helper.path).href);
	const native = original("full-kickoff-readback-original.json");
	const report = readRecord(parseJson(original("full-kickoff-verifier-original.json").bytes.toString("utf8")));
	const comparison = readRecord(parseJson(original("full-kickoff-readback-comparison.json").bytes.toString("utf8")));
	const spillId = randomUUID();
	const filename = path.join(os.tmpdir(), `${Date.now()}-copilot-tool-output-${spillId}.txt`);
	writeFileSync(filename, native.bytes, { flag: "wx", mode: 0o600 });
	t.after(() => rmSync(filename));
	/** @param {string} id @param {string} file */
	const preview = (id, file) => ({
		resultType: "success", textResultForLlm: `Output too large to read at once.\nSaved to: ${file}\nPreview omitted.`,
		toolTelemetry: { properties: { largeOutputWrittenToFile: "true", largeOutputSpillId: id } },
	});
	const decoded = await decodeNativeValue(preview(spillId, filename));
	assert.ok(native.bytes.length > 20 * 1024);
	assert.deepEqual(decoded.bytes, native.bytes);
	assert.deepEqual(decoded.value, readRecord(parseJson(native.bytes.toString("utf8"))).value);
	const plan = readRecord(readRecord(decoded.value).plan);
	assert.ok(isList(plan.tasks) && isList(report.evidence));
	const task = readRecord(plan.tasks.find(raw => readRecord(raw).id === report.taskId));
	assert.ok(isList(task.attempts));
	const attempt = readRecord(task.attempts.find(raw => readRecord(raw).id === report.attemptId));
	const evidence = attempt.evidence;
	assert.ok(isList(evidence));
	const expected = report.evidence.map(raw => readRecord(raw));
	/** @param {unknown[]} records */
	const compare = records => {
		assert.equal(records.length, comparison.admittedCount);
		assert.equal(expected.length, comparison.originalCount);
		const actual = records.map(raw => readRecord(raw));
		const mismatches = expected.flatMap(item => {
			const admitted = readRecord(actual.find(raw => raw.checkId === item.checkId));
			return ["checkId", "type", "summary", "source", "outcome"]
				.filter(field => item[field] !== admitted[field])
				.map(field => ({ checkId: item.checkId, field, original: item[field], admitted: admitted[field] }));
		});
		assert.deepEqual(mismatches, comparison.mismatches);
		return mismatches;
	};
	const mismatches = compare(evidence);
	assert.deepEqual(mismatches.map(({ checkId, field }) => ({ checkId, field })), [{ checkId: "T-001-C010", field: "summary" }]);
	assert.throws(() => compare(evidence.slice(0, -1)));
	const altered = structuredClone(evidence);
	altered[0] = { ...readRecord(altered[0]), source: "not the retained original" };
	assert.throws(() => compare(altered));
	const missingId = randomUUID();
	const missing = path.join(os.tmpdir(), `${Date.now()}-copilot-tool-output-${missingId}.txt`);
	await assert.rejects(decodeNativeValue(preview(missingId, missing)), { code: "ENOENT" });
	t.diagnostic(JSON.stringify({ originalBytes: native.bytes.length, originalCount: expected.length,
		admittedCount: evidence.length, retainedHistoricalMismatches: mismatches.length, nativeInvocation: false }));
});

/** @param {string} repository @param {string[]} args */
function git(repository, args) {
	const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

/** Synthetic only: roots, repositories, private text and refs are all unique runner outputs.
 * @param {import("node:test").TestContext} t @param {string} [report] */
function fixture(t, report) {
	const output = process.env.FOUNDRY_PARALLEL_OUTPUT;
	assert.ok(output, "Use the isolated parallel runner");
	const root = realpathSync(mkdtempSync(path.join(output, "retention-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const source = path.join(root, "source"), storage = path.join(root, "private"), repository = path.join(root, "repository");
	for (const directory of [source, storage, repository]) mkdirSync(directory, { mode: 0o700 });
	git(source, ["init", "-q", "--initial-branch=work"]);
	git(repository, ["init", "--bare", "-q"]);
	const originals = new Map();
	const artifacts = /** @type {const} */ (["report", "evaluator", "context", "decision", "failure"]).map(kind => {
		const content = kind === "report" && report !== undefined ? report
			: `${kind}: complete synthetic original\nattribution: fixture-producer\nprivate-fixture-marker\n`;
		const bytes = Buffer.from(content);
		originals.set(kind, bytes);
		writeFileSync(path.join(source, `${kind}.json`), bytes, { mode: 0o600 });
		return { id: kind, kind, originalId: `original-${kind}`, producerId: "fixture-producer", root: "work",
			path: `${kind}.json`, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
	});
	git(source, ["add", "."]);
	git(source, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "Synthetic source"]);
	const commit = git(source, ["rev-parse", "HEAD"]);
	const inventory = {
		subject: { repositoryId: "repo", ownerId: "owner", sessionId: "child", planId: "plan", taskId: "T-002", attemptId: "T-002-A001" },
		storeId: "private-store", artifacts,
		commits: [{ commit, sourceRef: "refs/heads/work", durableRef: "refs/foundry/retained/child/source" }],
	};
	const manifest = planArtifactRetention(inventory);
	let calls = 0;
	/** @type {import("../../native/artifacts.mjs").RetentionBinding | null} */
	let binding = { revision: "inventory-1", inventory, removalRoots: [source] };
	/** @type {import("../../native/artifacts.mjs").ArtifactRetentionOptions} */
	const options = {
		subject: inventory.subject, storeId: inventory.storeId, sourceRoots: { work: source },
		sourceRepository: source, retentionRoot: storage, retainedRepository: repository,
		readBinding: () => binding,
		provider: {
			retainArtifact: async request => {
				calls++; request.revalidate();
				mkdirSync(path.dirname(request.destination), { recursive: true, mode: 0o700 });
				copyFileSync(request.source, request.destination, constants.COPYFILE_EXCL);
				chmodSync(request.destination, 0o600);
				return { status: "completed", receiptId: `artifact-${calls}` };
			},
			retainCommit: async request => {
				calls++; request.revalidate();
				git(request.retainedRepository, ["fetch", "--no-tags", request.sourceRepository, request.commit.commit]);
				git(request.retainedRepository, ["update-ref", request.commit.durableRef, request.commit.commit, "0".repeat(40)]);
				return { status: "completed", receiptId: `commit-${calls}` };
			},
		},
	};
	return { root, source, storage, repository, originals, inventory, manifest, options,
		calls: () => calls, setBinding: (/** @type {typeof binding} */ value) => { binding = value; } };
}

/** @param {import("../../native/artifacts.mjs").PreservationResult} result @param {RegExp} [code] */
function held(result, code) {
	assert.equal(result.status, "held", JSON.stringify(result.reasons));
	assert.equal(result.raceSafe, false);
	assert.ok(result.reasons.length);
	if (code) assert.match(result.reasons.join(","), code);
}

test("synthetic original bytes and unique commits remain independently readable without the source directory", async t => {
	const f = fixture(t), port = createArtifactRetention(f.options);
	const saved = await port.retain(f.manifest);
	assert.equal(saved.status, "observed", saved.reasons.join(","));
	assert.equal(saved.observations.length, 6);
	assert.equal(saved.receipts.length, 6);
	assert.equal(saved.raceSafe, false);
	assert.doesNotMatch(JSON.stringify(saved), /private-fixture-marker/);
	assert.match(saved.guarantee, /no archive permission/);
	const again = await port.retain(f.manifest);
	assert.equal(again.status, "observed");
	assert.equal(again.receipts.length, 0);
	assert.equal(f.calls(), 6, "Verified existing content is reused without provider writes");
	rmSync(f.source, { recursive: true });
	assert.equal((await createArtifactRetention(f.options).observe(f.manifest)).status, "observed");
	for (const item of f.manifest.artifacts) assert.deepEqual(readFileSync(path.join(f.storage, item.destination)), f.originals.get(item.id));
	assert.equal(git(f.repository, ["rev-parse", f.manifest.commits[0].durableRef]), f.manifest.commits[0].commit);
	assert.match(git(f.repository, ["show", `${f.manifest.commits[0].commit}:report.json`]), /complete synthetic original/);
	t.diagnostic(`Synthetic ${os.platform()} fixtures; no Windows-native or native-archive evidence.`);
});

test("manifest, branch names and successful provider requests cannot prove preservation", async t => {
	const f = fixture(t);
	held(await createArtifactRetention(f.options).observe(f.manifest), /ENOENT/);
	assert.equal(f.calls(), 0);
	f.options.provider.retainArtifact = async () => ({ status: "completed", receiptId: "no-write" });
	const result = await createArtifactRetention(f.options).retain(f.manifest);
	held(result, /ENOENT/);
	assert.equal(result.receipts[0].receiptId, "no-write");
	assert.ok(existsSync(f.source));
});

test("the streaming observer retains an original report beyond the old 16 MiB cutoff without replacing it with a preview", async t => {
	const f = fixture(t, " 原文 🧪\t\n".repeat(1_500_000));
	const item = f.manifest.artifacts.find(item => item.id === "report");
	assert.ok(item);
	assert.ok(item.bytes > 16 * 1024 * 1024);
	const result = await createArtifactRetention(f.options).retain(f.manifest);
	assert.equal(result.status, "observed", result.reasons.join(","));
	rmSync(f.source, { recursive: true });
	const retained = readFileSync(path.join(f.storage, item.destination));
	assert.deepEqual(retained, f.originals.get("report"));
	assert.equal(createHash("sha256").update(retained).digest("hex"), item.sha256);
	assert.equal((await createArtifactRetention(f.options).observe(f.manifest)).status, "observed");
	assert.equal(result.raceSafe, false);
});

test("complete trusted inventory and ownership are mandatory and cannot be supplied by manifest flags", async t => {
	const f = fixture(t);
	f.setBinding(null);
	held(await createArtifactRetention(f.options).retain(f.manifest), /binding_unobserved/);
	f.setBinding({ revision: "inventory-1", inventory: f.inventory, removalRoots: [] });
	held(await createArtifactRetention(f.options).retain(f.manifest), /binding_unobserved/);
	f.setBinding({ revision: "inventory-1", inventory: { ...f.inventory, subject: { ...f.inventory.subject, ownerId: "foreign" } }, removalRoots: [f.source] });
	held(await createArtifactRetention(f.options).retain(f.manifest), /identity_changed/);
	held(await createArtifactRetention(f.options).retain({ ...f.manifest, permitted: true }));
	assert.equal(f.calls(), 0);
});

test("unobserved extra required content and foreign source roots hold without writes", async t => {
	const f = fixture(t);
	f.setBinding({ revision: "inventory-2", inventory: { ...f.inventory, artifacts: [...f.inventory.artifacts,
		{ ...f.inventory.artifacts[0], id: "another-report", originalId: "report-2", path: "report-2.json" }] }, removalRoots: [f.source] });
	held(await createArtifactRetention(f.options).retain(f.manifest), /identity_changed/);
	f.setBinding({ revision: "inventory-1", inventory: f.inventory, removalRoots: [f.source] });
	f.options.sourceRoots = {};
	held(await createArtifactRetention(f.options).retain(f.manifest), /foreign_root/);
	assert.equal(f.calls(), 0);
});

test("retention destinations inside or above any removable root are held", async t => {
	const f = fixture(t);
	for (const removed of [f.root, f.storage, path.join(f.storage, "nested"), f.repository, path.join(f.repository, "objects")]) {
		f.setBinding({ revision: "inventory-1", inventory: f.inventory, removalRoots: [f.source, removed] });
		held(await createArtifactRetention(f.options).retain(f.manifest), /destination_removable/);
	}
	assert.equal(f.calls(), 0);
});

test("private storage is required and denial/interruption never invokes a fallback or deletes source", async t => {
	const f = fixture(t);
	chmodSync(f.storage, 0o755);
	held(await createArtifactRetention(f.options).retain(f.manifest), /private_storage/);
	chmodSync(f.storage, 0o700);
	for (const status of /** @type {const} */ (["denied", "interrupted"])) {
		let deniedCalls = 0;
		f.options.provider.retainArtifact = async () => { deniedCalls++; return { status, receiptId: `${status}-original` }; };
		const result = await createArtifactRetention(f.options).retain(f.manifest);
		held(result, new RegExp(status));
		assert.deepEqual(result.receipts.map(item => item.receiptId), [`${status}-original`]);
		assert.equal(deniedCalls, 1);
		assert.equal(f.calls(), 0);
		assert.ok(existsSync(f.source));
		assert.equal(existsSync(path.join(f.storage, f.manifest.artifacts[0].destination)), false);
	}
	f.options.provider.retainArtifact = async () => { throw new Error("private-provider-error-body"); };
	const result = await createArtifactRetention(f.options).retain(f.manifest);
	held(result);
	assert.doesNotMatch(JSON.stringify(result), /private-provider-error-body/);
});

test("partial writes and digest mismatches remain untouched and hold future reuse", async t => {
	for (const short of [true, false]) {
		const f = fixture(t);
		f.options.provider.retainArtifact = async request => {
			request.revalidate();
			mkdirSync(path.dirname(request.destination), { mode: 0o700 });
			writeFileSync(request.destination, Buffer.alloc(short ? 1 : request.artifact.bytes, 120), { mode: 0o600, flag: "wx" });
			return { status: "completed", receiptId: "partial-original" };
		};
		const first = await createArtifactRetention(f.options).retain(f.manifest);
		held(first, /digest_mismatch|size_mismatch/);
		const target = path.join(f.storage, f.manifest.artifacts[0].destination), original = readFileSync(target);
		let retries = 0;
		f.options.provider.retainArtifact = async () => { retries++; return { status: "completed", receiptId: "should-not-run" }; };
		held(await createArtifactRetention(f.options).retain(f.manifest), /digest_mismatch|size_mismatch/);
		assert.deepEqual(readFileSync(target), original);
		assert.equal(retries, 0);
	}
});

test("source and destination symlinks, linked parents, hard links and case aliases are held", async t => {
	for (const kind of ["source-link", "source-hardlink", "source-parent", "destination-link", "destination-hardlink", "destination-parent", "case-alias"]) {
		await t.test(kind, async t => {
			const f = fixture(t), item = f.manifest.artifacts[0], original = path.join(f.source, item.path);
			const foreign = path.join(f.root, "foreign");
			writeFileSync(foreign, f.originals.get(item.id), { mode: 0o600 });
			if (kind === "source-link" || kind === "source-hardlink") {
				rmSync(original);
				if (kind === "source-link") symlinkSync(foreign, original); else linkSync(foreign, original);
			} else if (kind === "source-parent") {
				const displaced = `${f.source}-displaced`; renameSync(f.source, displaced); symlinkSync(displaced, f.source, "dir");
			} else if (kind === "destination-parent") {
				mkdirSync(path.join(f.root, "foreign-dir")); symlinkSync(path.join(f.root, "foreign-dir"), path.join(f.storage, "child"), "dir");
			} else if (kind === "case-alias") {
				mkdirSync(path.join(f.storage, "Child"), { mode: 0o700 });
			} else {
				mkdirSync(path.join(f.storage, "child"), { mode: 0o700 });
				const destination = path.join(f.storage, item.destination);
				if (kind === "destination-link") symlinkSync(foreign, destination); else linkSync(foreign, destination);
			}
			held(await createArtifactRetention(f.options).retain(f.manifest), /path_linked|path_alias/);
			assert.equal(f.calls(), 0);
			assert.deepEqual(readFileSync(foreign), f.originals.get(item.id));
		});
	}
});

test("use-time source, root and parent substitutions are detected before provider writes", async t => {
	for (const target of ["source", "storage", "parent"]) {
		await t.test(target, async t => {
			const f = fixture(t);
			f.options.provider.retainArtifact = async request => {
				const directory = target === "source" ? f.source : target === "storage" ? f.storage : path.join(f.storage, "child");
				if (target === "parent") {
					// Observe a real parent before substituting it.
					mkdirSync(directory, { mode: 0o700 }); request.revalidate();
				}
				renameSync(directory, `${directory}-old`);
				mkdirSync(directory, { mode: 0o700 });
				request.revalidate();
				assert.fail("Substitution must stop the provider");
			};
			held(await createArtifactRetention(f.options).retain(f.manifest), /path_substituted/);
		});
	}
});

test("changed causal inventory and source ref after a write preserve receipt but hold the operation", async t => {
	const f = fixture(t), original = f.options.provider.retainArtifact;
	f.options.provider.retainArtifact = async request => {
		const result = await original(request);
		f.setBinding({ revision: "inventory-2", inventory: f.inventory, removalRoots: [f.source] });
		return result;
	};
	const result = await createArtifactRetention(f.options).retain(f.manifest);
	held(result, /binding_changed/);
	assert.equal(result.receipts.length, 1);
	assert.ok(existsSync(path.join(f.storage, f.manifest.artifacts[0].destination)));
	const second = fixture(t);
	git(second.source, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "Moved source"]);
	held(await createArtifactRetention(second.options).retain(second.manifest), /source_changed/);
	assert.equal(second.calls(), 0);
});

test("byte-identical source replacement and appearing destinations do not bypass use-time checks", async t => {
	for (const fault of ["source-replacement", "destination-appeared"]) {
		const f = fixture(t);
		f.options.provider.retainArtifact = async request => {
			if (fault === "source-replacement") {
				renameSync(request.source, `${request.source}.original`);
				copyFileSync(`${request.source}.original`, request.source);
			} else {
				mkdirSync(path.dirname(request.destination), { mode: 0o700 });
				copyFileSync(request.source, request.destination);
				chmodSync(request.destination, 0o600);
			}
			request.revalidate();
			assert.fail("The provider must not overwrite a changed or newly occupied path");
		};
		held(await createArtifactRetention(f.options).retain(f.manifest), /path_substituted|destination_appeared/);
		assert.ok(existsSync(f.source));
	}
});

test("worktree-local objects, missing exact durable refs and alternate databases are not retention", async t => {
	const f = fixture(t);
	assert.equal((await createArtifactRetention(f.options).retain(f.manifest)).status, "observed");
	const ref = f.manifest.commits[0].durableRef;
	git(f.repository, ["update-ref", "-d", ref]);
	held(await createArtifactRetention(f.options).observe(f.manifest), /ref_mismatch/);
	git(f.repository, ["update-ref", "refs/heads/mutable", f.manifest.commits[0].commit]);
	git(f.repository, ["symbolic-ref", ref, "refs/heads/mutable"]);
	held(await createArtifactRetention(f.options).observe(f.manifest), /ref_mismatch/);
	git(f.repository, ["symbolic-ref", "--delete", ref]);
	git(f.repository, ["update-ref", ref, f.manifest.commits[0].commit]);
	writeFileSync(path.join(f.repository, "objects", "info", "alternates"), `${path.join(f.source, ".git", "objects")}\n`);
	held(await createArtifactRetention(f.options).observe(f.manifest), /git_dependency/);
	rmSync(path.join(f.repository, "objects", "info", "alternates"));
	const external = path.join(f.root, "worktree-only"); mkdirSync(external, { mode: 0o700 }); git(external, ["init", "-q"]);
	f.options.retainedRepository = external;
	held(await createArtifactRetention(f.options).observe(f.manifest), /git_not_independent|git_unavailable/);
});

test("a later provider cannot silently corrupt earlier complete evidence", async t => {
	const f = fixture(t), original = f.options.provider.retainCommit;
	f.options.provider.retainCommit = async request => {
		const result = await original(request);
		writeFileSync(path.join(f.storage, f.manifest.artifacts[0].destination), "corrupted", { mode: 0o600 });
		return result;
	};
	const result = await createArtifactRetention(f.options).retain(f.manifest);
	held(result, /size_mismatch/);
	assert.equal(result.receipts.length, 6);
	assert.ok(existsSync(f.source));
});

test("multiple unique commits and refs are retained without relying on mutable fetch metadata", async t => {
	const f = fixture(t), first = f.manifest.commits[0].commit;
	git(f.source, ["update-ref", "refs/heads/first", first]);
	writeFileSync(path.join(f.source, "new.txt"), "second synthetic unique source\n");
	git(f.source, ["add", "new.txt"]);
	git(f.source, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "Second source"]);
	const second = git(f.source, ["rev-parse", "HEAD"]);
	f.inventory.commits = [
		{ commit: first, sourceRef: "refs/heads/first", durableRef: "refs/foundry/retained/child/first" },
		{ commit: second, sourceRef: "refs/heads/work", durableRef: "refs/foundry/retained/child/second" },
	];
	const manifest = planArtifactRetention(f.inventory);
	const saved = await createArtifactRetention(f.options).retain(manifest);
	assert.equal(saved.status, "observed", saved.reasons.join(","));
	assert.equal(saved.receipts.filter(item => item.kind === "commit").length, 2);
	rmSync(f.source, { recursive: true });
	assert.equal((await createArtifactRetention(f.options).observe(manifest)).status, "observed");
	assert.equal(git(f.repository, ["show", `${second}:new.txt`]), "second synthetic unique source");
});

test("missing objects, shared Git directories and corrupt retained objects fail independent observation", async t => {
	for (const fault of ["missing-object", "corrupt-object", "common-directory", "shallow"]) {
		await t.test(fault, async t => {
			const f = fixture(t);
			assert.equal((await createArtifactRetention(f.options).retain(f.manifest)).status, "observed");
			if (fault === "common-directory") {
				writeFileSync(path.join(f.repository, "commondir"), `${f.source}/.git\n`);
			} else if (fault === "shallow") {
				writeFileSync(path.join(f.repository, "shallow"), `${f.manifest.commits[0].commit}\n`);
			} else {
				const commit = f.manifest.commits[0].commit;
				const object = path.join(f.repository, "objects", commit.slice(0, 2), commit.slice(2));
				assert.ok(existsSync(object), "Fixture must have a loose commit object");
				if (fault === "missing-object") rmSync(object);
				else { chmodSync(object, 0o600); writeFileSync(object, "broken-object"); }
			}
			held(await createArtifactRetention(f.options).observe(f.manifest), /git_dependency|git_unavailable/);
		});
	}
});

test("a provider cannot turn a changed original or linked destination into verified preservation", async t => {
	for (const fault of ["changed-original", "linked-destination", "partial-denial"]) {
		await t.test(fault, async t => {
			const f = fixture(t), original = f.options.provider.retainArtifact;
			f.options.provider.retainArtifact = async request => {
				const result = await original(request);
				if (fault === "changed-original") writeFileSync(request.source, "changed original");
				if (fault === "linked-destination") {
					rmSync(request.destination); symlinkSync(request.source, request.destination);
				}
				return fault === "partial-denial" ? { status: "denied", receiptId: "partial-denial-original" } : result;
			};
			const result = await createArtifactRetention(f.options).retain(f.manifest);
			held(result, /size_mismatch|path_linked|provider_denied/);
			assert.equal(result.receipts.length, 1);
			assert.ok(existsSync(f.source));
			assert.ok(existsSync(path.join(f.storage, f.manifest.artifacts[0].destination)));
		});
	}
});
