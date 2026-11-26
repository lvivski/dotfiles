import { setTimeout as delay } from "node:timers/promises";
import { fail } from "./values.mjs";

/** @typedef {{scope:"session"|"run", message:string}} PermissionBlock */
/** @typedef {"manual"|"assisted"|"allow-all"|"unknown"} PermissionMode */
/** @type {PermissionBlock} */
const unresolved = { scope: "run", message: "Copilot has not resolved this session's managed tool permissions. Wait for the settings to load." };
/** @type {PermissionBlock} */
const unavailable = { scope: "run", message: "Copilot could not confirm this session's tool permission settings. Check Tool permissions in the session." };

/** Share only an in-flight read, never a successful permission decision.
 * @param {()=>Promise<{failClosed:boolean,permissionsContext?:{failClosed:boolean},bypassPermissionsDisabled?:boolean}>} settings
 * @param {()=>Promise<{mode:string}>} permissions
 * @param {number} [timeoutMs] */
export function permissionCheck(settings, permissions, timeoutMs = 5000) {
	/** @type {ReturnType<typeof bounded>|undefined} */ let pending;
	const read = () => pending ??= bounded().finally(() => { pending = undefined; });
	return {
		async blocker() { return (await read()).block; },
		async snapshot() {
			const { policy, mode, block } = await read();
			return { policy, mode, ready: !block, ...(block && {reason:block.message}) };
		},
		/** @param {()=>Promise<string>} executionMode */
		async autoConfirm(executionMode) {
			const state = await read(), mode = await executionMode();
			if (mode !== "interactive" && mode !== "autopilot") fail("unsupported_mode", "The owner session is no longer in an executable mode.");
			if (state.block) fail("permissions_unready", state.block.message);
			return mode === "autopilot" || state.mode === "allow-all";
		},
	};

	async function bounded() {
		const timer = new AbortController();
		const deadline = delay(timeoutMs, undefined, { signal: timer.signal });
		/** Preserve the other reading when an RPC rejects or times out. Never return raw policy diagnostics.
		 * @template T @param {()=>Promise<T>} get */
		const sample = get => Promise.race([Promise.resolve().then(get).catch(() => undefined), deadline]);
		try {
			const [settingsResult, permission] = await Promise.all([sample(settings), sample(permissions)]);
			const policy = !settingsResult ? "unknown" : settingsResult.failClosed !== false ||
				(settingsResult.permissionsContext !== undefined && settingsResult.permissionsContext?.failClosed !== false) ? "unresolved" : "resolved";
			/** @type {PermissionMode} */
			const mode = permission?.mode === "manual" || permission?.mode === "assisted" || permission?.mode === "allow-all" ? permission.mode : "unknown";
			return { policy, mode, block: blocker(policy, mode, settingsResult?.bypassPermissionsDisabled) };
		} finally { timer.abort(); }
	}
}

/** @param {"unknown"|"resolved"|"unresolved"} policy @param {PermissionMode} mode @param {boolean|undefined} restricted @returns {PermissionBlock|null} */
function blocker(policy, mode, restricted) {
	if (policy === "unresolved") return unresolved;
	if (policy !== "resolved") return unavailable;
	if (mode === "manual")
		return { scope: "session", message: "This session uses manual tool approvals. To run Foundry, select Assisted if your policy allows it." };
	if (mode === "assisted" || (mode === "allow-all" && restricted === false)) return null;
	if (mode === "allow-all" && restricted === true)
		return { scope: "run", message: "Managed policy restricts this session's selected tool permission mode. Check Tool permissions for a permitted mode such as Assisted." };
	return unavailable;
}
