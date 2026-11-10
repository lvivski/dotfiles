import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isList, isRecord, parseJson, readRecord, readString } from "../../data.mjs";
import { evaluateApi } from "./evaluators/api.mjs";
import { evaluate } from "./evaluators/policy.mjs";
import { evaluateWeighted } from "./evaluators/weighted.mjs";

const input = readRecord(parseJson(readString(process.argv[2])));
if (typeof input.mode !== "string" || typeof input.policy !== "string") throw new TypeError("Proof evaluation requires its mode and policy path");
if (!["policy", "weighted", "api", "weighted-api"].includes(input.mode)) throw new TypeError("Unknown proof evaluation mode");
if (input.conservation !== undefined && typeof input.conservation !== "boolean") throw new TypeError("Conservation must be a boolean");
/** @param {Uint8Array} content */
const hash = (content) => createHash("sha256").update(content).digest("hex");
const policyBytes = await readFile(input.policy);
/** @type {unknown} */
const policyModule = await import(pathToFileURL(input.policy).href);
const policy = readPolicy(policyModule);
const weighted = input.mode.startsWith("weighted");
let schedule = checkedSchedule(policy);
let apiDigest = null;
let delegation = null;
if (input.mode.endsWith("api")) {
	if (typeof input.api !== "string") throw new TypeError("API evaluation requires its module path");
	const bytes = await readFile(input.api);
	apiDigest = hash(bytes);
	/** @type {unknown} */
	const apiModule = await import(pathToFileURL(input.api).href);
	const create = readRecord(apiModule).createAdmissionApi;
	if (typeof create !== "function") throw new TypeError("API module must export createAdmissionApi");
	/** @param {import("./types.js").AdmissionPolicy<unknown, unknown>} policy */
	const createAdmissionApi = (policy) => {
		/** @type {unknown} */
		const api = create(policy);
		return readPolicy(api);
	};
	try {
		delegation = evaluateApi(createAdmissionApi);
	} catch (error) {
		delegation = { evaluationId: "api-delegation", outcome: "failed", detail: error instanceof Error ? error.message : String(error) };
	}
	const api = createAdmissionApi(policy);
	schedule = checkedSchedule(api);
}
const checks = evaluate(schedule, { conservation: input.conservation !== false });
if (weighted) checks.push(evaluateWeighted(schedule));
const receipts = delegation ? [
	delegation,
	{
		evaluationId: "api-integration",
		outcome: checks.every((entry) => entry.outcome === "passed") ? "passed" : "failed",
		detail: JSON.stringify(checks),
	},
] : checks;
process.stdout.write(JSON.stringify({
	processId: process.pid,
	observedAt: new Date().toISOString(),
	mode: input.mode,
	policyDigest: hash(policyBytes),
	apiDigest,
	runnerDigest: hash(await readFile(new URL(import.meta.url))),
	receipts,
}));

/** Untrusted generated modules have no guaranteed return shape until evaluated.
 * @param {unknown} value @returns {import("./types.js").AdmissionPolicy<unknown, unknown>} */
function readPolicy(value) {
	assertPolicy(value);
	return value;
}

/** Only callability is claimed; generated inputs and outputs remain unknown.
 * @param {unknown} value @returns {asserts value is import("./types.js").AdmissionPolicy<unknown, unknown>} */
function assertPolicy(value) {
	if (!isRecord(value) || typeof value.schedule !== "function") throw new TypeError("Policy must export schedule");
}
/** @param {unknown} value @returns {asserts value is import("./types.js").AdmissionResult} */
function assertAdmissionResult(value) {
	if (!isRecord(value) || !["ready", "admitted", "held"].every((key) => {
		const field = value[key];
		return isList(field) && field.every((entry) => typeof entry === "string");
	})) throw new TypeError("Policy did not return admission ID arrays");
}

/** @param {import("./types.js").AdmissionPolicy<unknown, unknown>} policy @returns {import("./types.js").Schedule} */
function checkedSchedule(policy) {
	return (tasks, capacity) => {
		const result = policy.schedule(tasks, capacity);
		assertAdmissionResult(result);
		return result;
	};
}
