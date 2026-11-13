import type { JsonValue } from "./json.js";
import type { KnowledgeRef } from "./factory.js";
import type { DatabaseSync } from "node:sqlite";

export type AdmissionIdentity = {
	repositoryId: string; owner: string; planId: string; taskId: string; reservationId: string;
};
export type AttemptIdentity = AdmissionIdentity & { attemptId: string };
export type BootstrapBase = { repositoryId: string; branch: string; commit: string };
export type ArtifactIdentity = {
	repositoryId: string; commit: string; path: string; mode: "100644" | "100755"; digest: string;
};
export type EvaluatorBinding = KnowledgeRef & {
	procedureDigest: string; requirements: KnowledgeRef[]; independent: boolean;
	modality: "implementation-test" | "boundary" | "operational" | "human";
};
export type GoverningBindings = {
	authority: "discovery-only" | "accepted-contract";
	repositoryId: string; unit: KnowledgeRef; contract: { revision: number; digest: string } | null;
	requirements: KnowledgeRef[]; evaluators: EvaluatorBinding[]; visualEvaluation: KnowledgeRef | null;
};
export type PackageInput = { producer: string; output: string; destination: string };
export type PackageOutput = { id: string; path: string };
export type WorkPackage = {
	id: string; title: string; expectedFiles: string[]; inputs: PackageInput[]; outputs: PackageOutput[];
	requirements: KnowledgeRef[]; evaluators: KnowledgeRef[];
};
export type PackageDecomposition = {
	format: "foundry-packages-v1"; bindings: GoverningBindings; packages: WorkPackage[]; target: string;
};
export type ProducerDelivery = {
	packageId: string; attempt: AttemptIdentity; commit: string;
	outputs: { id: string; artifact: ArtifactIdentity }[];
};
export type ResolvedInput = PackageInput & { artifact: ArtifactIdentity };
export type ReservedInputs = {
	format: "foundry-reserved-inputs-v1"; consumer: AttemptIdentity; bootstrap: BootstrapBase;
	deliveries: ProducerDelivery[]; inputs: ResolvedInput[]; digest: string;
};
export type ConsumerEntry = {
	attempt: AttemptIdentity; sessionId: string; worktreePath: string;
	attachedRevision: number; handoffReceiptId: string; inputDigest: string;
};
export type DependencyObservation = {
	authority: "observation-only"; repositoryId: string; owner: string; planId: string; taskId: string;
	revision: number; source: string; capturedAt: string; validUntil: string; complete: boolean;
	status: "available" | "unavailable" | "unknown"; commit: string | null;
};
export type ResourceClaim = {
	id: string; kind: "worktree-build" | "foreground-input" | "shared-write" | "exact-package";
	scope: string; mode: "shared" | "exclusive"; capacity: number; units: number;
};
export type TeamClaim = { id: string; capacity: number; units: number };
export type Fence = { admission: AdmissionIdentity; revision: number; epoch: number };
export type EffectKind = "creation" | "attachment" | "handoff" | "workflow";
export type EffectReceipt = {
	id: string; attempt: AttemptIdentity; kind: EffectKind; epoch: number; payloadDigest: string;
	state: "intent" | "in-flight" | "succeeded" | "definitive-failure" | "uncertain" | "cancelled-before-start";
	sessionId: string | null; runId: string | null; source: string; at: string;
};
export type CancellationObligation = {
	attempt: AttemptIdentity; sessionId: string | null; runIds: string[]; pendingEffectIds: string[];
	disposition: "unresolved" | "no-session-created" | "session-terminated";
	inventory: { complete: boolean; capturedAt: string; source: string } | null;
	terminatedRunIds: string[];
};
export type DeliveryReceipt = {
	attempt: AttemptIdentity; sessionId: string; commit: string; planRevision: number;
	source: string; terminalRunIds: string[];
};
export type AdmissionRecord = {
	format: "foundry-admission-v1"; identity: AdmissionIdentity; revision: number; epoch: number;
	phase: "claim-held" | "reserved" | "cancelling" | "settled" | "released";
	attempt: AttemptIdentity | null; resources: ResourceClaim[]; team: TeamClaim | null;
	obligations: CancellationObligation[]; receipts: EffectReceipt[]; delivery: DeliveryReceipt | null;
	reservationFailure: { source: string; at: string } | null;
};
export type ParallelHistory = {
	format: "foundry-parallel-history-v1"; authority: "history-only";
	admissions: AdmissionRecord[]; observations: DependencyObservation[];
};

/** Callbacks execute synchronously inside the admission owner's anchored writer transaction.
 * The journal cannot use this handle to allocate or release claims. Native calls run outside it.
 */
export type FencedTransaction = { db: DatabaseSync; admission: AdmissionRecord; fence: Fence };
export type AdmissionPort = {
	read(identity: AdmissionIdentity): AdmissionRecord | null;
	claim(input: { identity: AdmissionIdentity; expectedRevision: number; resources: ResourceClaim[]; team: TeamClaim | null }): AdmissionRecord;
	bindReservation(fence: Fence, attempt: AttemptIdentity): AdmissionRecord;
	withFence<T>(fence: Fence, operation: (transaction: FencedTransaction) => T): T;
	cancel(fence: Fence): AdmissionRecord;
	settle(fence: Fence, obligations: CancellationObligation[]): AdmissionRecord;
	deliver(fence: Fence, receipt: DeliveryReceipt): AdmissionRecord;
	release(fence: Fence): AdmissionRecord;
};
export type DispatchJournalPort = {
	read(attempt: AttemptIdentity): EffectReceipt[];
	intent(transaction: FencedTransaction, receipt: EffectReceipt): EffectReceipt;
	start(transaction: FencedTransaction, receiptId: string): EffectReceipt;
	recordOutcome(transaction: FencedTransaction, receipt: EffectReceipt): EffectReceipt;
};
export type InputPort = {
	resolve(attempt: AttemptIdentity, bootstrap: BootstrapBase, inputs: PackageInput[]): ReservedInputs;
	materialize(descriptor: ReservedInputs, entry: ConsumerEntry): Promise<ArtifactIdentity[]>;
};
export type OfferedToolExecutor = {
	execute(input: { name: string; arguments: JsonValue; toolCallId?: string }): Promise<unknown>;
};

export type ParallelReservation = {
	attempt: AttemptIdentity; projectId: string; baseBranch: string; baseCommit: string;
	initialization: { acknowledgement: string; kickoff: { mode: "interactive"; prompt: string } };
	delegationPrompt: string; inputs: ReservedInputs | null; requiredInputs: PackageInput[];
};
export type ParallelChild = {
	sessionId: string; projectId: string; creatorSessionId: string; worktreePath: string; branch: string;
};
export type ParallelNativeResult = { value: unknown; raw: JsonValue; source: string };
export type ParallelSetup = { sessionId: string; message: string; at: string; source: string };
export type ParallelChildObservation = {
	child: ParallelChild; capturedAt: string; source: string; complete: boolean; aliases: string[];
	baseBranch: string; baseCommit: string; head: string; clean: boolean;
};
/** Current, scoped contributor evidence; this cannot authorize independent reviewers. */
export type ParallelContributors = {
	complete: boolean; source: string; capturedAt: string; commit: string; authors: string[];
};

/** Trusted constructor port, never a tool argument or a grant inferred from tool metadata.
 * Each callback must read the supported host route's actual current identity/evidence.
 * Omitting a decoder or observer holds the operation that requires it.
 */
export type ParallelHost = { state: "unavailable"; reason: string } | {
	state: "available";
	session: {
		workspacePath: string; sessionId: string; projectId: string;
		inWorkflow: boolean; agentId?: string;
	};
	executor: OfferedToolExecutor;
	offered: ReadonlySet<string>;
	availability(name: string): "supported" | "unavailable" | "unproven";
	taskPolicies(plan: import("./plan.js").FoundryPlan): Record<string, import("../plan/admission.mjs").TaskAdmission>;
	decodeCreated?: (value: unknown) => ParallelChild;
	decodeHandoff?: (value: unknown) => { sessionId: string; accepted: boolean };
	observeSetup?: (child: ParallelChild, reservation: ParallelReservation) => Promise<ParallelSetup>;
	observeChild?: (input: {
		child: ParallelChild; detail: ParallelNativeResult; inventory: ParallelNativeResult; after: string;
	}) => Promise<ParallelChildObservation>;
	reconcile?: (receipt: EffectReceipt, payload: JsonValue) => Promise<ParallelNativeResult | null>;
	observeRecovery?: (input: { identity: AdmissionIdentity; after: string }) => Promise<import("../inventory.mjs").RecoveryInventory>;
	observeOutcomes?: (input: { identity: AdmissionIdentity; receipts: EffectReceipt[] }) => Promise<EffectReceipt[]>;
	readReviews?: (input: { plan: import("./plan.js").FoundryPlan; taskId: string }) => Promise<import("../analysis/assurance.mjs").ReviewObligation[]>;
	readContributors?: (input: { plan: import("./plan.js").FoundryPlan; taskId: string }) => Promise<ParallelContributors>;
};
