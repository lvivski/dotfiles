import { setTimeout as delay } from "node:timers/promises";

/** @typedef {{scope:"session"|"run", message:string}} PermissionBlock */
/** @type {PermissionBlock} */
const unresolved = { scope: "run", message: "Copilot has not resolved this session's managed tool permissions. Wait for the settings to load." };
/** @type {PermissionBlock} */
const unavailable = { scope: "run", message: "Copilot could not confirm this session's tool permission settings. Check Tool permissions in the session." };

/** Share only an in-flight read, never a successful permission decision.
 * @param {()=>Promise<{failClosed:boolean,permissionsContext?:{failClosed:boolean},bypassPermissionsDisabled?:boolean}>} settings
 * @param {()=>Promise<{mode:string}>} permissions
 * @param {number} [timeoutMs] */
export function permissionCheck(settings, permissions, timeoutMs = 5000) {
	/** @type {Promise<PermissionBlock|null>|undefined} */ let pending;
	return () => pending ??= bounded().finally(() => { pending = undefined; });

	async function bounded() {
		const timer = new AbortController();
		try {
			return await Promise.race([inspect(), delay(timeoutMs, unresolved, { signal: timer.signal })]);
		} catch {
			// A missing RPC or rejected read is not permission. Do not copy raw policy diagnostics.
			return unavailable;
		} finally { timer.abort(); }
	}
	/** @returns {Promise<PermissionBlock|null>} */
	async function inspect() {
		const [policy, permission] = await Promise.all([settings(), permissions()]);
		if (policy?.failClosed !== false || (policy.permissionsContext !== undefined && policy.permissionsContext?.failClosed !== false))
			return unresolved;
		if (permission?.mode === "manual")
			return { scope: "session", message: "This session uses manual tool approvals. To run Foundry, select Assisted if your policy allows it." };
		if (permission?.mode === "assisted" || (permission?.mode === "allow-all" && policy.bypassPermissionsDisabled === false))
			return null;
		if (permission?.mode === "allow-all" && policy.bypassPermissionsDisabled === true)
			return { scope: "run", message: "Managed policy restricts this session's selected tool permission mode. Check Tool permissions for a permitted mode such as Assisted." };
		return unavailable;
	}
}
