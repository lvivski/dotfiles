/**
 * Minimal ambient declarations for the Copilot CLI extension SDK so `checkJs` can resolve the
 * `@github/copilot-sdk/*` imports offline. The real, richly-typed definitions ship inside the
 * `copilot` binary's pkg cache (`.../copilot-sdk/*.d.ts`) and are used by the editor at author time;
 * these shims keep a repo-only `tsc --checkJs` from failing on an unresolved module.
 */
declare module "@github/copilot-sdk/extension" {
	export interface CanvasAction {
		name: string;
		description?: string;
		inputSchema?: any;
		handler: (context: any) => any;
	}
	export interface CanvasOptions {
		id: string;
		displayName: string;
		description: string;
		inputSchema?: any;
		actions?: CanvasAction[];
		open: (context: any) => any;
		onClose?: (context: any) => any;
	}
	export class CanvasError extends Error {
		readonly code: string;
		constructor(code: string, message: string);
		static noHandler(): CanvasError;
	}
	export class Canvas {
		readonly declaration: any;
		readonly open: (context: any) => any;
		readonly onClose?: (context: any) => any;
	}
	/** Join the current foreground session, optionally contributing tools/commands/canvases/hooks. */
	export function joinSession(config?: any): Promise<any>;
	/** (Experimental) Declare an extension-owned canvas (a web UI panel) with `open`/`actions` handlers. */
	export function createCanvas(options: CanvasOptions): Canvas;
}

declare module "@github/copilot-sdk" {
	export type CopilotSession = any;
	export class CopilotClient {
		constructor(options?: any);
		createSession(config: any): Promise<any>;
		resumeSession(sessionId: string, config: any): Promise<any>;
		stop(): Promise<Error[]>;
		forceStop(): Promise<void>;
	}

	export const RuntimeConnection: {
		forStdio(options?: any): any;
	};
}

declare module "@github/copilot-sdk/session.js" {
	/** The live session handle (`log`, `send`, `on`, `rpc`, …). */
	export type CopilotSession = any;
}
