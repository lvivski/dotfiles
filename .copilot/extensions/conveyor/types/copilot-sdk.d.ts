/** Minimal offline declarations for the Copilot extension and Factory APIs used by Conveyor. */
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
	}): Promise<import("@github/copilot-sdk").CopilotSession>;
}

declare module "@github/copilot-sdk" {
	export interface CopilotSession {
		readonly factory: {
			run(factory: any, options?: {
				args?: any;
				limits?: Record<string, number>;
			}): Promise<any>;
		};
		readonly rpc: {
			workspaces?: {
				getWorkspace(): Promise<{ workspace?: { cwd?: string } }>;
			};
		};
	}
}
