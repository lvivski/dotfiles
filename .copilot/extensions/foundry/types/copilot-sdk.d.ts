/** Minimal offline declarations for the Copilot extension APIs used by Foundry. */
declare module "@github/copilot-sdk/extension" {
	import type {
		CopilotSession,
		JsonValue,
		Tool,
		WorkflowDefinition,
		WorkflowJsonSchema,
		WorkflowMeta,
	} from "@github/copilot-sdk";

	export class CanvasError extends Error {
		readonly code: string;
		constructor(code: string, message: string);
	}

	export interface Canvas {
		readonly declaration: {
			id: string;
			displayName: string;
			description: string;
		};
	}

	export interface CanvasContext {
		instanceId: string;
		input?: JsonValue;
	}

	export function createCanvas(options: {
		id: string;
		displayName: string;
		description: string;
		inputSchema?: Record<string, any>;
		actions?: Array<{
			name: string;
			description?: string;
			inputSchema?: Record<string, any>;
			handler: (context: CanvasContext) => unknown | Promise<unknown>;
		}>;
		open: (context: CanvasContext) => unknown | Promise<unknown>;
		onClose?: (context: CanvasContext) => void | Promise<void>;
	}): Canvas;

	export interface WorkflowContext<TArgs extends JsonValue = JsonValue> {
		args: TArgs;
		readonly runId: string;
		readonly signal: AbortSignal;
		agent(
			prompt: string,
			options?: {
				label?: string;
				schema?: WorkflowJsonSchema;
				model?: string;
				reasoningEffort?: string;
				contextTier?: "default" | "long_context";
				agent?: string;
			},
		): Promise<unknown>;
		/** Ordinary thunk failures resolve to null; cancellation and runtime failures reject. */
		parallel<T>(
			thunks: Array<() => T | Promise<T>>,
		): Promise<Array<T | null>>;
		/** Ordinary stage failures resolve that item to null and skip its remaining stages. */
		pipeline(
			items: unknown[],
			...stages: Array<
				(previous: unknown, original: unknown, index: number) => unknown | Promise<unknown>
			>
		): Promise<unknown[]>;
		phase(title: string): void;
		log(message: string): void;
		/** Nested workflows are not supported; this method rejects. */
		workflow(name: string, args?: JsonValue): Promise<JsonValue | void>;
		readonly session: CopilotSession;
		step(
			key: string,
			producer: () => JsonValue | Promise<JsonValue>,
			options?: { volatile?: boolean },
		): Promise<JsonValue>;
		pause(key: string): Promise<void>;
	}

	type DeepReadonly<T> = T extends (infer U)[] ? readonly DeepReadonly<U>[]
		: T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

	const workflowHandleBrand: unique symbol;

	export interface WorkflowHandle<TArgs extends JsonValue = JsonValue, TResult extends JsonValue | void = JsonValue | void> {
		readonly meta: DeepReadonly<WorkflowMeta>;
		readonly [workflowHandleBrand]: { readonly args: TArgs; readonly result: TResult };
	}

	export function defineWorkflow<
		TArgs extends JsonValue = JsonValue,
		TResult extends JsonValue | void = JsonValue | void,
	>(definition: WorkflowDefinition<TArgs, TResult>): WorkflowHandle<TArgs, TResult>;

	export function joinSession(config?: {
		workflows?: WorkflowHandle[];
		tools?: Tool[];
		hooks?: Record<string, any>;
		canvases?: Canvas[];
	}): Promise<CopilotSession>;
}

declare module "@github/copilot-sdk" {
	export type { WorkflowContext, WorkflowHandle } from "@github/copilot-sdk/extension";

	export type JsonValue = null | boolean | number | string | JsonValue[]
		| { [key: string]: JsonValue };

	export type ToolTelemetry = Record<string, Record<string, JsonValue> | undefined>;

	export interface ToolResultObject {
		textResultForLlm: string;
		resultType: "success" | "failure" | "rejected" | "denied" | "timeout";
		error?: string;
		sessionLog?: string;
		toolTelemetry?: ToolTelemetry;
		toolReferences?: string[];
		binaryResultsForLlm?: Array<{
			data: string;
			mimeType: string;
			type: "image" | "resource";
			description?: string;
		}>;
	}

	export interface ToolInvocation {
		sessionId: string;
		toolCallId: string;
		toolName: string;
		arguments: unknown;
		signal?: AbortSignal;
	}

	export type ToolHandler<TArgs = unknown> = (
		args: TArgs,
		invocation: ToolInvocation,
	) => unknown | Promise<unknown>;

	/** Foundry uses raw JSON schemas, not the SDK's optional Zod schema support. */
	export interface Tool<TArgs = unknown> {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
		handler?: ToolHandler<TArgs>;
		skipPermission?: boolean;
	}

	export type WorkflowJsonSchema = { [key: string]: JsonValue };

	export interface WorkflowLimits {
		maxConcurrentSubagents?: number;
		maxTotalSubagents?: number;
		maxAiCredits?: number;
		timeoutSeconds?: number;
	}

	export interface WorkflowMeta {
		name: string;
		description: string;
		phases: Array<{ title: string; detail?: string }>;
		argsSchema?: WorkflowJsonSchema;
		limits?: WorkflowLimits;
	}

	export interface WorkflowDefinition<TArgs extends JsonValue = JsonValue, TResult extends JsonValue | void = JsonValue | void> {
		meta: WorkflowMeta;
		run(context: import("@github/copilot-sdk/extension").WorkflowContext<TArgs>): Promise<TResult>;
	}

	export type WorkflowRunStatus =
		| "pending"
		| "running"
		| "completed"
		| "halted"
		| "paused"
		| "cancelled"
		| "error";

	export interface WorkflowRunResult {
		runId: string;
		attempt?: number;
		status: WorkflowRunStatus;
		result?: JsonValue;
		error?: string;
		failure?:
			| {
				type: "workflow_limit_reached";
				runId: string;
				kind: "maxTotalSubagents" | "timeoutSeconds" | "maxAiCredits";
				value: number;
				suggestedValue?: number;
			}
			| { type: "workflow_resume_declined"; runId: string; reason: string }
			| {
				type: "workflow_durable_failure";
				runId: string;
				code: string;
				operation: "createRun" | "markRunStarted" | "finishRun" | "reserveAgent"
					| "releaseAgent" | "chargeCredit" | "addElapsed" | "reconcileCreditTotal"
					| "journalGet" | "journalPut" | "refreshLease";
			}
			| { type: "workflow_accounting_incomplete"; runId: string; drainedNanoAiu: number }
			| { type: "workflow_provider_disconnected"; runId: string };
		reason?: string;
		snapshot?: JsonValue;
		pauseInfo?: { type: "user" } | { type: "checkpoint"; key: string };
	}

	/** Native identity and recovery fields; unrelated observability fields are omitted. */
	export interface WorkflowRunSummary {
		runId: string;
		workflowName: string;
		status: WorkflowRunStatus;
		revision: number;
		createdAt: number;
		completedAt: number | null;
		canResume: boolean;
		currentPhase: { title: string } | null;
		liveAgentCount: number;
		totalSpawnedAgentCount: number;
		terminal: {
			reason?: string;
			error?: string;
			failure?: WorkflowRunResult["failure"];
			pauseInfo: WorkflowRunResult["pauseInfo"] | null;
		} | null;
	}

	export interface WorkflowProgressLine {
		seq: number;
		attempt: number;
		phaseId: string | null;
		recordedAt: number;
		kind: "log" | "phase";
		text: string;
	}

	export interface WorkflowProgressPage {
		records: WorkflowProgressLine[];
		oldestSeq: number | null;
		newestSeq: number | null;
		hasMoreOlder: boolean;
		hasMoreNewer: boolean;
		revision: number;
	}

	export interface WorkflowRunDetail extends WorkflowRunSummary {
		progress: WorkflowProgressPage;
	}

	export interface WorkflowListRunsOptions {
		/** Exclusive forward cursor. */
		afterSeq?: number;
		/** Exclusive backward cursor. */
		beforeSeq?: number;
		/** Maximum terminal runs, default 200 and capped at 500. */
		limit?: number;
	}

	export interface WorkflowRunsPage {
		/** Summaries in durable creation order, including active runs. */
		runs: WorkflowRunSummary[];
		/** Terminal-window cursors, null when the terminal window is empty. */
		oldestSeq?: number | null;
		newestSeq?: number | null;
		/** Whether newer terminal runs exist. */
		hasMoreNewer?: boolean;
		/** Number of older terminal runs; omission is not evidence of zero. */
		omittedOlder?: number;
	}

	export interface SessionWorkflowApi {
		getRun(runId: string): Promise<WorkflowRunResult>;
		getRunDetail(runId: string): Promise<WorkflowRunDetail>;
		getRunProgress(runId: string, options?: {
			phaseId?: string;
			afterSeq?: number;
			beforeSeq?: number;
			limit?: number;
		}): Promise<WorkflowProgressPage>;
		listRuns(): Promise<WorkflowRunSummary[]>;
		listRuns(options: WorkflowListRunsOptions): Promise<WorkflowRunsPage>;
		/** Returns the terminal envelope, not a cancellation acknowledgement. */
		cancel(runId: string): Promise<WorkflowRunResult>;
		pause(runId: string): Promise<WorkflowRunResult>;
		resume(runId: string, options?: {
			limits?: WorkflowLimits;
			notifyOnComplete?: boolean;
			logPhaseNames?: boolean;
		}): Promise<WorkflowRunResult>;
		waitForRun(runId: string, options?: { signal?: AbortSignal }): Promise<WorkflowRunResult>;
	}

	export interface CopilotSession {
		readonly workspacePath?: string;
		readonly workflow: SessionWorkflowApi;
		readonly rpc: any;
		on(type: "workflow.run_updated", handler: (event: {
			data: { runId: string; revision: number };
		}) => void): () => void;
		log(message: string, options?: Record<string, any>): Promise<void>;
	}
}
