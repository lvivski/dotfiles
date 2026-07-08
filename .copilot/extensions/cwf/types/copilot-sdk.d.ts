/**
 * Minimal ambient declarations for the Copilot CLI extension SDK so `checkJs` can resolve the
 * `@github/copilot-sdk/*` imports offline. The real, richly-typed definitions ship inside the
 * `copilot` binary's pkg cache (`.../copilot-sdk/*.d.ts`) and are used by the editor at author time;
 * these shims keep a repo-only `tsc --checkJs` from failing on an unresolved module.
 */
declare module "@github/copilot-sdk/extension" {
	/** Join the current foreground session, optionally contributing tools/commands/canvases/hooks. */
	export function joinSession(config?: any): Promise<any>;
	/** (Experimental) Declare an extension-owned canvas (a web UI panel) with `open`/`actions` handlers. */
	export function createCanvas(options: any): any;
}

declare module "@github/copilot-sdk/session.js" {
	/** The live session handle (`log`, `send`, `on`, `rpc`, …). */
	export type CopilotSession = any;
}
