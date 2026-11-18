import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FoundryError, containsPath, decodeCandidate, digest, json, latestEvidence, resourcePath } from "./values.mjs";

/** @typedef {import("./model.d.ts").Candidate} Candidate */
/** @param {Uint8Array} content */
const hash = content => createHash("sha256").update(content).digest("hex");
/** @param {string} databasePath */
const artifactRoot = databasePath => path.join(path.dirname(databasePath), "artifacts");

/** @param {string} root @param {string} name */
function fileAt(root, name) {
	const relative = resourcePath(name);
	if (relative === "." || relative.split("/")[0] === ".git") throw new FoundryError("invalid_artifact_path", "Declare a repository file, not operational storage");
	const filename = path.join(root, relative);
	const metadata = lstatSync(filename);
	if (!metadata.isFile() || metadata.isSymbolicLink() || realpathSync(filename) !== path.join(realpathSync(root), relative)) {
		throw new FoundryError("invalid_artifact_path", `Artifact must be a contained regular file: ${relative}`);
	}
	return { filename, path: relative, mode: metadata.mode & 0o777, content: readFileSync(filename) };
}

/** @param {string} directory @param {string} commit @param {NonNullable<import("./model.d.ts").Check["oracleFiles"]>} pins */
export function committedOracles(directory, commit, pins) {
	const git = (/** @type {string[]} */ args) => execFileSync("git", ["--no-pager", "--no-replace-objects", "--no-lazy-fetch",
		"--literal-pathspecs", "-C", directory, ...args], { env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1", GIT_ALLOW_PROTOCOL: "" }, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, timeout: 30000 });
	try {
		if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit) || git(["cat-file", "-t", commit]).toString().trim() !== "commit")
			throw new Error("expected an immutable local commit");
		return pins.map(pin => {
			const name = resourcePath(pin.path);
			if (name !== pin.path || name.split("/").some(part => !part || part === "." || /^\.git[ .]*$/i.test(part))
				|| /[\x00-\x1f\\:]/.test(name)) throw new Error(`invalid evaluator path: ${pin.path}`);
			const entry = /^(100644|100755) blob ([a-f0-9]+)\t([^\0]+)\0$/.exec(git(["ls-tree", "--full-tree", "-z", commit, "--", name]).toString());
			if (!entry || entry[3] !== name) throw new Error(`missing regular file: ${name}`);
			const content = git(["cat-file", "blob", entry[2]]);
			if (hash(content) !== pin.sha256) throw new Error(`hash mismatch: ${name}`);
			return { path: name, mode: entry[1] === "100755" ? 0o755 : 0o644, content };
		});
	} catch (error) {
		throw new FoundryError("oracle_input", `Cannot provision assigned evaluators from ${commit}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** @param {string} directory @param {string[]} files @param {NonNullable<import("./model.d.ts").Check["oracleFiles"]>} oracles @param {string[]} scope @param {string} databasePath @param {string} [oracleCommit] @returns {Candidate} */
export function captureCandidate(directory, files, oracles, scope, databasePath, oracleCommit) {
	const sources = files.map(name => {
		const source = fileAt(directory, name);
		if (!scope.some(base => containsPath(base, source.path))) throw new FoundryError("artifact_scope", `Artifact is outside this task's paths: ${source.path}`);
		return source;
	});
	const evaluators = oracleCommit ? committedOracles(directory, oracleCommit, oracles) : oracles.map(oracle => {
		const source = fileAt(directory, oracle.path);
		if (hash(source.content) !== oracle.sha256) throw new FoundryError("oracle_changed", `Assigned evaluator changed: ${oracle.path}`);
		return source;
	});
	if (evaluators.some(source => sources.some(file => file.path === source.path))) throw new FoundryError("artifact_oracle_overlap", "Candidate files and conserved evaluator files must be distinct");
	const root = artifactRoot(databasePath);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	if (lstatSync(root).isSymbolicLink() || path.dirname(realpathSync(root)) !== realpathSync(path.dirname(databasePath))) {
		throw new FoundryError("unsafe_artifact_path", "Artifacts must remain in the private Foundry directory");
	}
	const reference = path.join(root, randomUUID());
	mkdirSync(reference, { mode: 0o700 });
	for (const source of [...sources, ...evaluators]) {
		const target = path.join(reference, source.path);
		mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
		writeFileSync(target, source.content, { flag: "wx", mode: 0o600 });
		chmodSync(target, source.mode);
	}
	const entries = sources.map(source => ({ path: source.path, sha256: hash(source.content), mode: source.mode }))
		.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	const candidate = { reference, version: digest(json(entries)), files: entries };
	writeFileSync(`${reference}.json`, JSON.stringify(candidate), { flag: "wx", mode: 0o600 });
	return candidate;
}

/** @param {string} reference @param {string} version @param {string} databasePath @returns {Candidate|undefined} */
export function readCandidate(reference, version, databasePath) {
	const root = artifactRoot(databasePath);
	const relative = path.relative(root, reference);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
	const name = relative.split(path.sep)[0];
	if (!/^(?:[a-f0-9-]{36}|[a-f0-9]{64})$/.test(name)) throw new FoundryError("invalid_artifact_reference", "Invalid captured artifact reference");
	const metadata = fileAt(root, `${name}.json`);
	if (lstatSync(metadata.filename).nlink !== 1 || lstatSync(root).isSymbolicLink()) throw new FoundryError("unsafe_artifact_path", "Artifact metadata must not be linked");
	const candidate = decodeCandidate(/** @type {unknown} */ (JSON.parse(metadata.content.toString("utf8"))));
	if (candidate.reference !== path.join(root, name) || candidate.version !== version
		|| lstatSync(candidate.reference).isSymbolicLink()) throw new FoundryError("candidate_identity_mismatch", "Published artifact no longer matches its evaluated materialization");
	for (const expected of candidate.files) {
		const actual = fileAt(candidate.reference, expected.path);
		if (lstatSync(actual.filename).nlink !== 1 || hash(actual.content) !== expected.sha256 || actual.mode !== expected.mode) {
			throw new FoundryError("candidate_changed", `Evaluated artifact changed: ${expected.path}`);
		}
	}
	if (reference !== candidate.reference && !candidate.files.some(file => path.join(candidate.reference, file.path) === reference)) {
		throw new FoundryError("invalid_artifact_reference", "Output is not a declared candidate file");
	}
	return candidate;
}

/** @param {Candidate} candidate @param {string} databasePath @returns {void} */
export function verifyCandidate(candidate, databasePath) {
	const actual = readCandidate(candidate.reference, candidate.version, databasePath);
	if (!actual || digest(json(actual)) !== digest(json(candidate))) throw new FoundryError("candidate_identity_mismatch", "Captured candidate metadata changed");
}

/** @param {Candidate} candidate @param {string} databasePath */
function publishCandidate(candidate, databasePath) {
	const reference = path.join(artifactRoot(databasePath), candidate.version);
	const published = { ...candidate, reference };
	if (!existsSync(reference)) {
		const staging = captureCandidate(candidate.reference, candidate.files.map(file => file.path), [], ["."], databasePath);
		try {
			if (staging.version !== candidate.version) throw new FoundryError("candidate_changed", "Candidate changed while publishing evaluated bytes");
			try { renameSync(staging.reference, reference); }
			catch (error) {
				if (!(error instanceof Error) || !("code" in error) || !["EEXIST", "ENOTEMPTY"].includes(String(error.code))) throw error;
			}
		} finally {
			if (existsSync(staging.reference)) rmSync(staging.reference, { recursive: true });
			rmSync(`${staging.reference}.json`);
		}
	}
	try { writeFileSync(`${reference}.json`, JSON.stringify(published), { flag: "wx", mode: 0o600 }); }
	catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
	}
	verifyCandidate(published, databasePath);
	return published;
}

/** @param {import("./model.d.ts").Check[]} checks @param {import("./model.d.ts").Evidence[]} evidence */
function evaluatedCandidates(checks, evidence) {
	const latest = latestEvidence(evidence);
	const candidates = checks.filter(check => check.artifactFiles).map(check => {
		const observation = latest.get(JSON.stringify([check.id, check.version]));
		const candidate = observation?.outcome === "passed" ? observation.candidate : undefined;
		if (!candidate || digest(json(candidate.files.map(file => file.path).sort())) !== digest(json(check.artifactFiles))) {
			throw new FoundryError("candidate_not_evaluated", "Every artifact-bound governing check must identify its tested files");
		}
		return candidate;
	});
	if (candidates.length && candidates.some(candidate => candidate.version !== candidates[0].version)) {
		throw new FoundryError("mixed_candidate_checks", "Governing checks passed against different candidates; reevaluate one final materialization");
	}
	return candidates;
}

/** @param {Candidate[]} candidates @param {import("./model.d.ts").Output[]} outputs @param {string} databasePath */
function normalizedOutputs(candidates, outputs, databasePath) {
	if (!candidates.length) return outputs;
	return outputs.map(output => {
		const candidate = candidates.find(candidate => output.reference === candidate.reference || candidate.files.some(file =>
			output.reference === file.path || output.reference === path.join(candidate.reference, file.path)
			|| output.reference === path.join(artifactRoot(databasePath), candidate.version, file.path))
			|| output.reference === path.join(artifactRoot(databasePath), candidate.version));
		if (!candidate) {
			if (output.kind === "code" || output.kind === "artifact") throw new FoundryError("unbound_artifact", "Publish a declared evaluated artifact, not a mutable or untested code reference");
			return output;
		}
		if (output.version !== candidate.version) throw new FoundryError("candidate_version_mismatch", "Use the candidate version returned by the actual assigned evaluator");
		const published = { ...candidate, reference: path.join(artifactRoot(databasePath), candidate.version) };
		const file = candidate.files.find(file => output.reference === file.path
			|| output.reference === path.join(candidate.reference, file.path) || output.reference === path.join(published.reference, file.path));
		return { ...output, reference: file ? path.join(published.reference, file.path) : published.reference };
	});
}

/** @param {import("./model.d.ts").Check[]} checks @param {import("./model.d.ts").Evidence[]} evidence @param {import("./model.d.ts").Output[]} outputs @param {string} databasePath @returns {import("./model.d.ts").Output[]} */
export function normalizeCandidateOutputs(checks, evidence, outputs, databasePath) {
	return normalizedOutputs(evaluatedCandidates(checks, evidence), outputs, databasePath);
}

/** @param {import("./model.d.ts").Check[]} checks @param {import("./model.d.ts").Evidence[]} evidence @param {import("./model.d.ts").Output[]} outputs @param {string} databasePath @returns {import("./model.d.ts").Output[]} */
export function bindCandidateOutputs(checks, evidence, outputs, databasePath) {
	const candidates = evaluatedCandidates(checks, evidence);
	for (const candidate of candidates) verifyCandidate(candidate, databasePath);
	const normalized = normalizedOutputs(candidates, outputs, databasePath);
	for (const candidate of new Map(candidates.map(candidate => [candidate.version, candidate])).values()) {
		const reference = path.join(artifactRoot(databasePath), candidate.version);
		if (normalized.some(output => output.reference === reference
			|| candidate.files.some(file => output.reference === path.join(reference, file.path)))) {
			publishCandidate(candidate, databasePath);
		}
	}
	return normalized;
}
