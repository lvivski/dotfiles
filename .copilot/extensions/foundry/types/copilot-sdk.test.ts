// Compile-only contract regressions, checked by the extension's jsconfig.
import type {
	CopilotSession,
	SessionWorkflowApi,
	ToolResultObject,
	WorkflowContext,
	WorkflowHandle,
	WorkflowRunResult,
} from "@github/copilot-sdk";

const telemetry: ToolResultObject["toolTelemetry"] = { foundry: { outcome: "success" } };
// @ts-expect-error Telemetry values are namespaced maps, not flat strings.
const flatTelemetry: ToolResultObject["toolTelemetry"] = { extension: "foundry" };
// @ts-expect-error Telemetry must be JSON-serializable.
const invalidTelemetry: ToolResultObject["toolTelemetry"] = { foundry: { outcome: () => "success" } };

declare const api: SessionWorkflowApi;
declare const detail: Awaited<ReturnType<SessionWorkflowApi["getRunDetail"]>>;
declare const progress: Awaited<ReturnType<SessionWorkflowApi["getRunProgress"]>>;

const canResume: boolean = detail.canResume;
const revision: number = progress.revision;
const completedAt: number | null = detail.completedAt;
const recordKind: "log" | "phase" = progress.records[0].kind;
const settled: Promise<WorkflowRunResult> = api.waitForRun("run", { signal: new AbortController().signal });
const pausedRun: Promise<WorkflowRunResult> = api.pause("run");
const resumedRun: Promise<WorkflowRunResult> = api.resume("run", { notifyOnComplete: true, logPhaseNames: true });
// @ts-expect-error Waiting accepts a host AbortSignal, not model-supplied text.
api.waitForRun("run", { signal: "cancel" });
declare const session: CopilotSession;
const unsubscribe: () => void = session.on("workflow.run_updated", (event) => {
	const nativeRevision: number = event.data.revision;
	const runId: string = event.data.runId;
	// @ts-expect-error Invalidation hints are not workflow state snapshots.
	event.data.status;
});
// @ts-expect-error Native detail uses workflowName.
detail.factoryName;
// @ts-expect-error Native progress is a page, not a run envelope.
progress.status;
// @ts-expect-error Progress cursors are numeric.
api.getRunProgress("run", { beforeSeq: "1" });

const userPause: WorkflowRunResult["pauseInfo"] = { type: "user" };
const checkpoint: WorkflowRunResult["pauseInfo"] = { type: "checkpoint", key: "review-ready" };
// @ts-expect-error A checkpoint pause needs its stable key.
const invalidCheckpoint: WorkflowRunResult["pauseInfo"] = { type: "checkpoint" };
const limitFailure: WorkflowRunResult["failure"] = {
	type: "workflow_limit_reached",
	runId: "run",
	kind: "maxAiCredits",
	value: 10,
	suggestedValue: 20,
};
// @ts-expect-error Concurrency applies backpressure, not a cumulative-limit failure.
const invalidLimit: WorkflowRunResult["failure"] = { type: "workflow_limit_reached", runId: "run", kind: "maxConcurrentSubagents", value: 2 };
// @ts-expect-error Workflow failure variants are discriminated.
const invalidFailure: WorkflowRunResult["failure"] = { type: "unknown_failure", runId: "run" };

declare const context: WorkflowContext;
declare const agentResult: Awaited<ReturnType<WorkflowContext["agent"]>>;
const pause: Promise<void> = context.pause("review-ready");
// @ts-expect-error Agent results are unknown until narrowed.
agentResult.passed;
// @ts-expect-error Journaled steps cannot return undefined.
context.step("invalid", () => undefined);

declare const handle: WorkflowHandle;
// @ts-expect-error Registered workflow metadata is deeply immutable.
handle.meta.phases.push({ title: "another" });
