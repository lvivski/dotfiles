/** Minimal offline declarations for the Copilot extension APIs used by Foundry. */
declare module "@github/copilot-sdk/extension" {
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
		input?: Record<string, any>;
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

	export interface FactoryContext {
		readonly args: any;
		readonly runId: string;
		readonly signal: AbortSignal;
		agent(
			prompt: string,
			options?: {
				label?: string;
				schema?: Record<string, any>;
				model?: string;
				reasoningEffort?: string;
				contextTier?: "default" | "long_context";
				agent?: string;
			},
		): Promise<any | null>;
		/** Ordinary thunk failures resolve to null; cancellation and runtime failures reject. */
		parallel<T>(
			thunks: Array<() => T | Promise<T>>,
		): Promise<Array<T | null>>;
		/** Ordinary stage failures resolve that item to null and skip its remaining stages. */
		pipeline(
			items: any[],
			...stages: Array<
				(previous: any, original: any, index: number) => any | Promise<any>
			>
		): Promise<any[]>;
		phase(title: string): void;
		log(message: string): void;
		factory(name: string, args?: any): Promise<any>;
		readonly session: import("@github/copilot-sdk").CopilotSession;
		step(
			key: string,
			producer: () => any | Promise<any>,
			options?: { volatile?: boolean },
		): Promise<any>;
	}

	export interface FactoryHandle {
		readonly meta: {
			readonly name: string;
			readonly description: string;
			readonly phases: ReadonlyArray<{ title: string; detail?: string }>;
			readonly argsSchema?: Readonly<Record<string, any>>;
			readonly limits?: Readonly<Record<string, number>>;
		};
	}

	export function defineFactory(definition: {
		meta: {
			name: string;
			description: string;
			phases: Array<{ title: string; detail?: string }>;
			argsSchema?: Record<string, any>;
			limits?: Record<string, number>;
		};
		run: (context: FactoryContext) => Promise<any>;
	}): FactoryHandle;

	export function joinSession(config?: {
		factories?: FactoryHandle[];
		tools?: any[];
		hooks?: Record<string, any>;
		canvases?: Canvas[];
	}): Promise<import("@github/copilot-sdk").CopilotSession>;
}

declare module "@github/copilot-sdk" {
	export type FactoryRunStatus =
		| "pending"
		| "running"
		| "completed"
		| "halted"
		| "cancelled"
		| "error";

	export type JsonValue = null | boolean | number | string | JsonValue[]
		| { [key: string]: JsonValue };

	/** Native envelope. Failure variants are opaque to this inspection boundary. */
	export interface FactoryRunResult {
		runId: string;
		attempt?: number;
		status: FactoryRunStatus;
		result?: JsonValue;
		error?: string;
		failure?: unknown;
		reason?: string;
		snapshot?: JsonValue;
	}

	/** Fields consumed from native summaries; other observability fields are omitted here. */
	export interface FactoryRunSummary {
		runId: string;
		factoryName: string;
		status: FactoryRunStatus;
		createdAt: number;
	}

	export interface FactoryListRunsOptions {
		/** Exclusive forward cursor. */
		afterSeq?: number;
		/** Exclusive backward cursor. */
		beforeSeq?: number;
		/** Maximum terminal runs, default 200 and capped at 500. */
		limit?: number;
	}

	export interface FactoryRunsPage {
		/** Summaries in durable creation order, including active runs. */
		runs: FactoryRunSummary[];
		/** Terminal-window cursors, null when the terminal window is empty. */
		oldestSeq?: number | null;
		newestSeq?: number | null;
		/** Whether newer terminal runs exist. */
		hasMoreNewer?: boolean;
		/** Number of older terminal runs; omission is not evidence of zero. */
		omittedOlder?: number;
	}

	export interface SessionFactoryApi {
		getRun(runId: string): Promise<FactoryRunResult>;
		getRunDetail(runId: string): Promise<any>;
		getRunProgress(runId: string, options?: Record<string, any>): Promise<any>;
		listRuns(): Promise<FactoryRunSummary[]>;
		listRuns(options: FactoryListRunsOptions): Promise<FactoryRunsPage>;
		/** Returns the terminal envelope, not a cancellation acknowledgement. */
		cancel(runId: string): Promise<FactoryRunResult>;
		waitForRun(runId: string, options?: { signal?: AbortSignal }): Promise<FactoryRunResult>;
	}

	export interface CopilotSession {
		readonly workspacePath?: string;
		readonly factory: SessionFactoryApi;
		readonly rpc: any;
		log(message: string, options?: Record<string, any>): Promise<void>;
	}
}
