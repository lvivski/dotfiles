// Compile-only checks for the owned DTOs and decoded/undecoded boundary.
import { parseJson } from "../data.mjs";
import { decodeRequest } from "../requests.mjs";
import type { FactoryEvent } from "./factory.js";
import type { FoundryPlan, TaskInitialization } from "./plan.js";

// @ts-expect-error Guard noImplicitAny: declaration parameters require a type.
declare function implicitParameter(value): void;
try {
	throw new Error("compile-only catch boundary");
} catch (error) {
	// @ts-expect-error Guard useUnknownInCatchVariables: narrow before property access.
	error.message;
}

const request = decodeRequest("attachTask", {});
const sessionId: string = request.sessionId;
const branch: string | null | undefined = request.branch;
// @ts-expect-error Decoded IDs cannot masquerade as numeric values.
const numericSession: number = request.sessionId;
// @ts-expect-error The attachment request does not accept a verification verdict.
request.passed;

const parsed = parseJson("{}");
// @ts-expect-error Parsed JSON is unknown until checked.
parsed.planId;
declare const event: FactoryEvent;
// @ts-expect-error Action payloads have not passed replay validation yet.
event.input.candidateId.length;

declare const plan: FoundryPlan;
// @ts-expect-error A fresh recipe requires its sealed assignment digest.
const unsealedStartup: TaskInitialization = { recipe: "complete-kickoff-v1", acknowledgement: "receipt", kickoff: { mode: "interactive", prompt: "task" } };
// @ts-expect-error A legacy initialization cannot carry an unversioned fresh digest.
const ambiguousStartup: TaskInitialization = { assignmentDigest: "a".repeat(64), acknowledgement: "receipt", kickoff: { mode: "interactive", prompt: "task" } };
// @ts-expect-error Stored task states do not include arbitrary native states.
plan.tasks[0].status = "paused";
// @ts-expect-error Evidence provenance is a bounded claim classification.
plan.tasks[0].attempts[0].evidence[0].trust = "authenticated";
if (plan.factoryVerification) {
	// @ts-expect-error A frozen JSON snapshot is not trusted before analysis validation.
	plan.factoryVerification.definitions.evaluations;
}
