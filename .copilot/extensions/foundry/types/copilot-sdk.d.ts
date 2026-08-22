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
	export interface SessionFactoryApi {
		getRun(runId: string): Promise<any>;
		getRunDetail(runId: string): Promise<any>;
		getRunProgress(runId: string, options?: Record<string, any>): Promise<any>;
		listRuns(): Promise<any[]>;
		cancel(runId: string): Promise<any>;
		waitForRun(runId: string, options?: { signal?: AbortSignal }): Promise<any>;
	}

	export interface CopilotSession {
		readonly workspacePath?: string;
		readonly factory: SessionFactoryApi;
		readonly rpc: any;
		log(message: string, options?: Record<string, any>): Promise<void>;
	}
}
