import { EVIDENCE_OUTCOME, EVIDENCE_TYPE, LIMITS, PLAN_ID_PATTERN } from "../plan/values.mjs";

/** @typedef {import("../types/json.js").JsonSchema} JsonSchema */

/** JSON Schema for stable plan IDs. @type {JsonSchema} */
export const PLAN_ID = {
	type: "string",
	pattern: PLAN_ID_PATTERN,
	maxLength: LIMITS.planId,
};

/** JSON Schema for task IDs. @type {JsonSchema} */
export const TASK_ID = {
	type: "string",
	pattern: "^T-\\d{3}$",
};

/** JSON Schema for task-attempt IDs. @type {JsonSchema} */
export const ATTEMPT_ID = {
	type: "string",
	pattern: "^T-\\d{3}-A\\d{3}$",
	maxLength: LIMITS.attemptId,
};

/** JSON Schema for idempotency and cancellation request IDs. @type {JsonSchema} */
export const REQUEST_ID = {
	type: "string",
	pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
	maxLength: LIMITS.requestId,
};

/** JSON Schema for optimistic-concurrency revisions. @type {JsonSchema} */
export const REVISION = {
	type: "integer",
	minimum: 0,
	maximum: Number.MAX_SAFE_INTEGER,
};

/**
 * Creates a bounded non-empty string schema.
 *
 * @param {number} maximum
 * @returns {JsonSchema}
 */
export const NON_EMPTY = (maximum) => ({
	type: "string",
	minLength: 1,
	maxLength: maximum,
});

/**
 * Creates a bounded array-of-strings schema.
 *
 * @param {number} maximum
 * @param {number} itemMaximum
 * @param {number} [minimum]
 * @returns {JsonSchema}
 */
export const STRING_LIST = (maximum, itemMaximum, minimum = 0) => ({
	type: "array",
	minItems: minimum,
	maxItems: maximum,
	items: NON_EMPTY(itemMaximum),
});

/**
 * Creates a closed object schema.
 *
 * @param {string[]} required
 * @param {Record<string, JsonSchema>} properties
 * @returns {JsonSchema & {type: "object", properties: Record<string, JsonSchema>, required: string[]}}
 */
export function objectSchema(required, properties) {
	return {
		type: "object",
		additionalProperties: false,
		required,
		properties,
	};
}

/** JSON Schema for caller-supplied claimed evidence. */
export const EVIDENCE_INPUT = objectSchema(
	["type", "summary", "outcome"],
	{
		type: { type: "string", enum: Object.values(EVIDENCE_TYPE) },
		summary: NON_EMPTY(LIMITS.evidenceItem),
		source: NON_EMPTY(LIMITS.evidenceSource),
		outcome: { type: "string", enum: Object.values(EVIDENCE_OUTCOME) },
		checkId: NON_EMPTY(32),
	},
);

/** JSON Schema for an explicitly complete or partial App session inventory. */
export const SESSION_INVENTORY = objectSchema(
	["complete", "capturedAt", "sessions"],
	{
		complete: { type: "boolean" },
		capturedAt: NON_EMPTY(64),
		sessions: {
			type: "array",
			maxItems: 1_000,
			items: objectSchema(
				["id", "status"],
				{
					id: NON_EMPTY(LIMITS.sessionId),
					status: NON_EMPTY(64),
				},
			),
		},
	},
);

/** @type {JsonSchema} */
export const FACTORY_ID = { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,95}$", maxLength: 96 };

/** @type {JsonSchema} */
export const DIGEST = { type: "string", pattern: "^[a-f0-9]{64}$" };

export const KNOWLEDGE_REF = objectSchema(["id", "revision"], { id: FACTORY_ID, revision: { type: "integer", minimum: 1 } });

/** @type {JsonSchema} */
export const REFERENCES = { type: "array", maxItems: 32, items: KNOWLEDGE_REF };

/** Package wire limits do not increase the executable plan's task limit. @type {JsonSchema} */
const PACKAGE_REFERENCES = { type: "array", maxItems: 128, items: KNOWLEDGE_REF };
const PACKAGE_INPUT = objectSchema(["producer", "output", "destination"], {
	producer: FACTORY_ID, output: FACTORY_ID, destination: NON_EMPTY(1024),
});
const PACKAGE_OUTPUT = objectSchema(["id", "path"], { id: FACTORY_ID, path: NON_EMPTY(1024) });
const PACKAGE_EVALUATOR = objectSchema(["id", "revision", "procedureDigest", "requirements", "independent", "modality"], {
	...KNOWLEDGE_REF.properties, procedureDigest: DIGEST,
	requirements: { ...PACKAGE_REFERENCES, minItems: 1 }, independent: { type: "boolean" },
	modality: { type: "string", enum: ["implementation-test", "boundary", "operational", "human"] },
});
const PACKAGE_BINDINGS = objectSchema(["authority", "repositoryId", "unit", "contract", "requirements", "evaluators", "visualEvaluation"], {
	authority: { type: "string", enum: ["discovery-only", "accepted-contract"] },
	repositoryId: DIGEST, unit: KNOWLEDGE_REF,
	contract: { anyOf: [objectSchema(["revision", "digest"], { revision: KNOWLEDGE_REF.properties.revision, digest: DIGEST }), { type: "null" }] },
	requirements: PACKAGE_REFERENCES,
	evaluators: { type: "array", maxItems: 128, items: PACKAGE_EVALUATOR },
	visualEvaluation: { anyOf: [KNOWLEDGE_REF, { type: "null" }] },
});
export const PACKAGE_DECOMPOSITION = objectSchema(["format", "bindings", "packages", "target"], {
	format: { const: "foundry-packages-v1" }, bindings: PACKAGE_BINDINGS, target: FACTORY_ID,
	packages: {
		type: "array", minItems: 1, maxItems: 128,
		items: objectSchema(["id", "title", "expectedFiles", "inputs", "outputs", "requirements", "evaluators"], {
			id: FACTORY_ID, title: NON_EMPTY(256), expectedFiles: STRING_LIST(128, 4096, 1),
			inputs: { type: "array", maxItems: 128, items: PACKAGE_INPUT },
			outputs: { type: "array", minItems: 1, maxItems: 128, items: PACKAGE_OUTPUT },
			requirements: PACKAGE_REFERENCES, evaluators: PACKAGE_REFERENCES,
		}),
	},
});

export const FACTORY_SOURCE = objectSchema(["kind", "ref", "actor", "at"], {
	kind: { type: "string", enum: ["discovery", "implementation", "audit", "research", "review", "security", "triage", "command", "human", "operational", "app-task", "external-run", "native-workflow"] },
	ref: NON_EMPTY(4096), actor: NON_EMPTY(256), at: NON_EMPTY(64),
	sessionId: NON_EMPTY(512), planId: NON_EMPTY(64), taskId: TASK_ID, attemptId: ATTEMPT_ID,
	runId: NON_EMPTY(512), owner: NON_EMPTY(4096),
	digest: DIGEST,
	judgmentId: NON_EMPTY(512),
});

export const FACTORY_ARTIFACT = objectSchema(["kind", "ref", "digest"], {
	kind: { type: "string", enum: ["knowledge", "schema", "test", "reference", "foundation", "implementation", "data"] },
	ref: NON_EMPTY(4096), digest: DIGEST,
});

export const FACTORY_LEARNING = objectSchema(["kind", "statement"], {
	kind: { type: "string", enum: ["observation", "inference", "proposal"] },
	statement: NON_EMPTY(8000), uncertainty: { type: ["string", "null"], maxLength: 8000 },
});

export const FACTORY_REPORT = objectSchema(["evaluation", "procedureDigest", "environment", "workload", "outcome", "report", "independenceReason"], {
	evaluation: KNOWLEDGE_REF, procedureDigest: DIGEST,
	environment: NON_EMPTY(2048), workload: NON_EMPTY(2048),
	outcome: { type: "string", enum: ["passed", "failed", "inconclusive"] },
	report: NON_EMPTY(16000), independenceReason: NON_EMPTY(2048),
});

export const EVALUATOR_BUNDLE = objectSchema(["version", "commit", "root", "entryPoint", "support", "invocation"], {
	version: { const: 1 },
	commit: { type: "string", pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" },
	root: NON_EMPTY(1024), entryPoint: NON_EMPTY(1024), support: STRING_LIST(32, 1024),
	invocation: objectSchema(["argv", "cwd"], { argv: STRING_LIST(64, 4096, 2), cwd: NON_EMPTY(1024) }),
});
