/** Minimal offline declarations for the Copilot extension APIs used in this repository. */
declare module "@github/copilot-sdk/extension" {
	export function defineFactory(definition: {
		meta: {
			name: string;
			description: string;
			phases: Array<{ title: string; detail?: string }>;
			limits?: Record<string, number>;
		};
		run: (context: any) => Promise<any>;
	}): any;

	export function joinSession(config?: {
		factories?: any[];
		tools?: any[];
		hooks?: Record<string, any>;
		canvases?: any[];
	}): Promise<import("@github/copilot-sdk").CopilotSession>;
}

declare module "@github/copilot-sdk" {
	export interface CopilotSession {
		readonly workspacePath?: string;
		readonly factory: any;
		readonly rpc: any;
		log(message: string, options?: Record<string, any>): Promise<void>;
	}
}
