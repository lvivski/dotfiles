import type { JsonValue } from "./json.js";
import type { AttemptIdentity } from "./parallel.js";

export type RetentionScope = {
	repositoryId: string; owner: string; coordinatorSessionId: string; currentSessionId: string;
};
export type RetentionSubject = {
	attempt: AttemptIdentity; sessionId: string; coordinatorSessionId: string; worktreePath: string;
};
export type RetentionEvent = {
	version: 1; id: string; subject: RetentionSubject; revision: number; sequence: number;
	sourceCommit: string; sourceDigest: string; at: string; source: string;
};
export type RetentionInventoryKind =
	"tasks" | "attempts" | "runs" | "sessions" | "work" | "prs" | "merges" | "automations" | "consumers" | "evaluators";
export type RetentionInventory = {
	kind: RetentionInventoryKind; revision: number; sequence: number; source: string;
	coverage: "exhaustive" | "partial" | "unknown"; nextCursor: string | null;
	knownIds: string[];
	items: {
		id: string; subject: RetentionSubject; state: "terminal" | "active" | "unknown" | "ambiguous";
		revision: number; sequence: number; source: string; authority: string;
	}[];
};
/** A projection of trusted observations, not proof of completeness or a permission grant.
 * The observer must exhaust all pages and retain positive identities across captures.
 * Sequence is a scope-local causal watermark, not a timestamp or a model counter.
 */
export type RetentionObservation = {
	version: 1; subject: RetentionSubject; eventId: string; eventRevision: number; eventSequence: number;
	revision: number; sequence: number; capturedAt: string; validUntil: string; source: string;
	ownership: "owned" | "foreign" | "unknown" | "ambiguous";
	inventories: RetentionInventory[];
	workspace: { state: "observed" | "unknown"; tracked: string[]; untracked: string[]; ignored: string[] };
};
export type RetentionArtifactKind = "source" | "ref" | "context" | "decision" | "report" | "evaluator" | "artifact";
/** The artifact port verifies actual durable bytes, canonical paths and conservation.
 * Each category has a retained inventory, even when its domain inventory is empty.
 * Policy path checks alone cannot detect symlinks or prove durable retention.
 */
export type RetentionManifest = {
	version: 1; subject: RetentionSubject; sourceCommit: string; sourceDigest: string;
	sequence: number; capturedAt: string; source: string; retainedRoot: string;
	required: { kind: RetentionArtifactKind; id: string }[];
	items: {
		kind: RetentionArtifactKind; id: string; digest: string; location: string;
		state: "retained" | "missing" | "unknown"; source: string;
	}[];
};
export type RetentionHold = { code: string; reason: string; authority: string };
export type RetentionAssessment = {
	version: 1; id: string; event: RetentionEvent; observation: RetentionObservation;
	manifest: RetentionManifest | null; assessedAt: string;
	state: "held" | "candidate"; holds: RetentionHold[];
};
export type RetentionArchiveRequest = {
	version: 1; operationId: string; intentId: string; subject: RetentionSubject;
	completionRevision: number; sourceCommit: string; sourceDigest: string;
	observationDigest: string; manifestDigest: string; assessmentId: string;
};
export type RetentionOutcome = {
	version: 1; operationId: string; subject: RetentionSubject;
	disposition: "archived" | "denied" | "unavailable" | "failed" | "uncertain";
	source: string; at: string; receipt: JsonValue;
	error: { code: string; message: string } | null;
};
export type RetentionIntent = {
	version: 1; id: string; event: RetentionEvent; revision: number;
	assessments: RetentionAssessment[]; start: RetentionArchiveRequest | null;
	outcomes: RetentionOutcome[];
};

/** Integration supplies the canonical store/outbox transaction, not a new database.
 * Every transaction must enforce scope, immutable event ID AND completion identity,
 * monotone events, current attempt/retry/cancellation fences and subject-wide exclusion.
 * assertCurrent(start) must also compare the observed canonical revisions and all holds.
 * Outcomes remain appendable after cancellation/reopening; they never release claims.
 * read/insert/replace share one synchronous durable transaction; replace is revision-CAS.
 * The backing store and original receipts must survive removal of the subject worktree.
 * Its owner validates that durable placement, not a model-supplied path or digest.
 * Direct v1 AdmissionPort.withFence is NOT this binding: it excludes settled subjects
 * and its receipt kinds do not include archive. Omission explicitly holds all writes.
 */
export type RetentionTransaction = {
	assertCurrent(event: RetentionEvent, assessment: RetentionAssessment | null, mode: "assess" | "start"): void;
	read(id: string): unknown | null;
	insert(intent: RetentionIntent): void;
	replace(intent: RetentionIntent, expectedRevision: number): void;
};
export type RetentionCanonicalPort = {
	read(id: string): unknown | null;
	transaction<T>(event: RetentionEvent, operation: (transaction: RetentionTransaction) => T): T;
};
export type RetentionPersistencePort = {
	read(id: string): RetentionIntent | null;
	assess(event: RetentionEvent, assessment: RetentionAssessment): RetentionIntent;
	start(id: string, expectedRevision: number, assessmentId: string): RetentionIntent;
	outcome(id: string, outcome: RetentionOutcome): RetentionIntent;
};
/** These constructor-only ports read authoritative application state, including live
 * captures under the host guard, not cached snapshots merely within an expiry window.
 * No public method accepts an observation, completion document, release flag or permission descriptor.
 */
export type RetentionObservationPort = {
	completion(eventId: string): Promise<unknown>;
	capture(event: RetentionEvent): Promise<unknown>;
};
export type RetentionArtifactPort = { inspect(event: RetentionEvent, observation: RetentionObservation): Promise<unknown> };
export type RetentionResult = {
	state: "held" | "candidate" | "archived";
	holds: RetentionHold[]; intent: RetentionIntent | null;
	/** Preserve the original value if decoding or durable outcome recording fails. */
	unpersisted?: unknown;
};
/** A trusted host implementation must acquire real subject/resource exclusion covering
 * observation, artifact inspection, canonical start admission AND the native operation.
 * It must recheck actual ownership/permissions/holds at the action's linearization point.
 * It calls action exactly once with the one supported permission-preserving archive route,
 * awaits action, and releases exclusion only afterwards. It cannot provide check-then-delete.
 * The invocation returns original source/time/error/receipt fields as RetentionOutcome.
 * Thrown exceptions represent indeterminate transport failure, not definitive rejection.
 * If the host cannot supply these semantics, OMIT this port. Neither functions supplied
 * by untrusted callers nor JSON booleans/tokens/digests are a host capability negotiation.
 * reconcile is read-only and returns only an exact original operation's observed outcome.
 */
export type RetentionArchivePort = {
	withSubjectGuard<T>(
		subject: RetentionSubject,
		action: (invoke: (request: RetentionArchiveRequest) => Promise<unknown>) => Promise<T>
	): Promise<T>;
	reconcile(request: RetentionArchiveRequest): Promise<unknown | null>;
};
export type RetentionDependencies = {
	scope: RetentionScope; persistence: RetentionPersistencePort; observations: RetentionObservationPort;
	artifacts: RetentionArtifactPort; archive?: RetentionArchivePort; clock?: () => string;
};
