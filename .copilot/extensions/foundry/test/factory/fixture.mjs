import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createFactoryService } from "../../factory.mjs";
import { factoryMutator } from "./accessors.mjs";
import { fixtureRoot, seedRepository } from "../git.mjs";
import { resolveEvaluatorBundle } from "../../evidence/bundles.mjs";

/** @param {string} value */
export const hash = (value) => createHash("sha256").update(value).digest("hex");

/** @param {import("../../types/factory.js").KnowledgeRef} entry */
const ref = (entry) => ({ id: entry.id, revision: entry.revision });

export const initialCode = "export function debit(records, id, amount) { const account = records.find(r => r.id === id); account.balance -= amount; return records; }\n";

export const freshCode = "export function debit(records, id, amount) { return records.map(r => r.id === id ? {...r, balance: r.balance - amount} : {...r}); }\n";

/** @param {boolean} conserveInput */
export const evaluator = (conserveInput) => `
import assert from 'node:assert/strict';
const {debit} = await import(process.argv[1]);
const records = [{id:'a',balance:20},{id:'b',balance:5}];
const before = structuredClone(records);
const result = debit(records,'a',3);
assert.deepEqual(result,[{id:'a',balance:17},{id:'b',balance:5}]);
assert.deepEqual(result.map(r=>r.id),before.map(r=>r.id));
${conserveInput ? "assert.deepEqual(records,before,'caller-owned input is an exclusive authority boundary');" : ""}
console.log('Balance, identity conservation${conserveInput ? " and caller authority" : ""} checks passed');
`;

/** @param {import("node:test").TestContext} t */
export async function fixture(t) {
	const root = await fixtureRoot(t, "factory");
	const repositoryPath = path.join(root, "repo");
	await mkdir(repositoryPath);
	/** @param {string[]} args */
	const git = (...args) => execFileSync("git", ["-C", repositoryPath, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	seedRepository(repositoryPath);
	for (const version of [1, 2]) {
		await mkdir(path.join(repositoryPath, "oracles", `v${version}`), { recursive: true });
		await writeFile(path.join(repositoryPath, "oracles", `v${version}`, "check.mjs"), evaluator(version > 1).replace("process.argv[1]", "new URL('../../implementation.mjs', import.meta.url).href"));
	}
	git("add", "oracles");
	git("-c", "user.name=Factory fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Preserved fixture evaluators");
	const evaluatorCommit = git("rev-parse", "HEAD");
	const procedure = (version = 1) => {
		const resolved = resolveEvaluatorBundle(repositoryPath, {
			version: 1, commit: evaluatorCommit, root: `oracles/v${version}`, entryPoint: `oracles/v${version}/check.mjs`,
			support: ["package-lock.json", "package.json"], invocation: { argv: ["node", `oracles/v${version}/check.mjs`], cwd: "." },
		});
		return { kind: /** @type {const} */ ("command"), ref: `node oracles/v${version}/check.mjs`, bundle: resolved.bundle, digest: resolved.digest };
	};
	let time = Date.now();
	const clock = () => new Date(time += 1000);
	const factory = createFactoryService({ repositoryPath, storageRoot: root, clock });
	/** @param {import("../../types/factory.js").SourceKind} [kind] @param {string} [runId] */
	const source = (kind = "discovery", runId = "discovery") => ({
		kind, ref: `fixture:${runId}`, actor: "fixture-researcher", at: new Date(time).toISOString(),
		...(kind === "external-run" ? { runId, owner: "fixture-session" } : {}),
	});
	const call = factoryMutator(factory);
	/** @param {string} [id] @param {string[]} [dependencies] @param {"complete" | "partial"} [relationshipCoverage] */
	const createUnit = (id = "ledger", dependencies = [], relationshipCoverage = "complete") => call("createUnit", {
		id, name: id, purpose: "Debit balances without losing identity or crossing authority boundaries",
		boundary: { owns: [`${id}-balance-transform`], exposes: ["debit(records,id,amount)"], consumes: [], preserves: ["account identity and caller contracts"] },
		dependencies, relationshipCoverage, actor: "owner",
	}).unit;
	const contract = (revision = 1) => {
		const obligation = call("appendKnowledge", {
			id: "balance-contract", unitId: "ledger", kind: "obligation",
			statement: revision === 1 ? "Return debited balances and preserve account identity" : "Return debited balances, preserve identities, and never mutate caller-owned records",
			source: source(), uncertainty: null,
			links: revision === 1 ? [] : [{ relation: "supersedes", target: { id: "balance-contract", revision: revision - 1 } }, { relation: "derived-from", target: { id: "input-discovery", revision: 1 } }],
		}).knowledge;
		const definition = call("appendKnowledge", {
			id: "boundary-eval", unitId: "ledger", kind: "evaluation", statement: "Execute the durable balance/identity/authority oracle",
			source: source(), uncertainty: null,
			links: revision === 1 ? [] : [{ relation: "supersedes", target: { id: "boundary-eval", revision: revision - 1 } }],
			evaluation: {
				modality: "boundary", procedure: procedure(revision),
				obligations: [ref(obligation)], environment: "node-fixture", workload: "single-debit",
				maxAgeSeconds: 86400, independent: true, preservation: true,
			},
		}).knowledge;
		return call("acceptContract", {
			unitId: "ledger", unitRevision: 1, obligations: [ref(obligation)], evaluations: [ref(definition)],
			actor: "capability-owner", reason: "Accept the recovered behavior and its independent boundary oracle",
		}).contract;
	};
	/** @param {string} id @param {number} contractRevision @param {import("../../types/factory.js").Candidate["mode"]} [mode] */
	const prepare = (id, contractRevision, mode = "reconstruction") => call("prepareCandidate", {
		id, unitId: "ledger", contractRevision, mode, actor: "fixture-generator",
		context: {
			generation: [{ kind: "test", ref: `fixture-evaluator-v${contractRevision}`, digest: procedure(contractRevision).digest }],
			comparisonOnly: mode === "reconstruction" ? [{ kind: "implementation", ref: "incumbent", digest: hash(initialCode) }] : [],
			independence: { method: "fresh-process", reason: "The bounded fixture generator runs in a new Node process; no OS isolation is claimed." },
		},
	}).candidate;
	/** @param {import("../../types/factory.js").Candidate} candidate @param {string} code */
	const deliver = async (candidate, code) => {
		const filename = "implementation.mjs";
		const output = path.join(repositoryPath, filename);
		// This generator receives only the explicitly supplied fixture implementation.
		execFileSync(process.execPath, ["--input-type=module", "-e", "import {writeFileSync} from 'node:fs'; writeFileSync(process.argv[1], process.argv[2]);", output, code]);
		git("add", filename);
		git("-c", "user.name=Factory fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "--allow-empty", "-m", candidate.id);
		const commit = git("rev-parse", "HEAD");
		call("recordDelivery", {
			candidateId: candidate.id, commit, artifact: { kind: "implementation", ref: pathToFileURL(output).href, digest: hash(code) },
			source: source("external-run", `generate-${candidate.id}`),
		});
		return { filename: pathToFileURL(output).href, commit };
	};
	/** @param {import("../../types/factory.js").Candidate} candidate @param {Awaited<ReturnType<typeof deliver>>} delivery @param {number} revision */
	const evaluate = (candidate, delivery, revision) => {
		const pinned = procedure(revision);
		const run = spawnSync(process.execPath, pinned.bundle.invocation.argv.slice(1), { cwd: repositoryPath, encoding: "utf8" });
		const result = call("recordEvaluation", {
			id: `evidence-${candidate.id}`, candidateId: candidate.id,
			evaluation: { id: "boundary-eval", revision }, contractDigest: candidate.contractDigest,
			contextDigest: candidate.contextDigest, commit: delivery.commit, procedureDigest: pinned.digest,
			outcome: run.status === 0 ? "passed" : "failed", source: source("external-run", `evaluate-${candidate.id}`),
			environment: "node-fixture", workload: "single-debit",
			independence: { method: "separate-process", reason: "A distinct Node evaluator imports the delivered module and runs the pinned assertions." },
			report: (run.stdout + run.stderr).slice(0, 16000),
		});
		return { run, ...result };
	};
	/** @param {import("../../types/factory.js").Candidate} candidate @param {"accept" | "reject"} action @param {string | null} incumbentId */
	const decide = (candidate, action, incumbentId) => call("decideCandidate", {
		candidateId: candidate.id, action, expectedIncumbentId: incumbentId, actor: "owner",
		reason: action === "accept" ? "Select against the same pinned obligations with preserved identity" : "Independent boundary oracle rejects caller-input mutation",
	});
	return { root, repositoryPath, git, factory, source, call, createUnit, contract, prepare, deliver, evaluate, decide, procedure, clock, advance: (/** @type {number} */ seconds) => { time += seconds * 1000; } };
}
