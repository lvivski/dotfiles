import { createPlanStore } from "../storage.mjs";
import { FoundryStorageError } from "../storage/errors.mjs";

/**
 * @param {() => string | undefined} getWorkspacePath
 */
export function createSessionStorage(getWorkspacePath) {

	/** @type {Map<string, ReturnType<typeof createPlanStore>>} */
	const stores = new Map();

	/**
	 * Resolves the current session workspace or fails closed.
	 *
	 * @returns {string}
	 */
	const workspace = () => {
		const workspacePath = getWorkspacePath();
		if (typeof workspacePath !== "string" || workspacePath.length === 0) {
			throw new FoundryStorageError(
				"workspace_unavailable",
				"Foundry requires a Copilot session workspace",
			);
		}
		return workspacePath;
	};

	/**
	 * Returns the cached plan store for a session workspace.
	 *
	 * @param {string} [workspacePath]
	 * @returns {ReturnType<typeof createPlanStore>}
	 */
	const storeFor = (workspacePath = workspace()) => {
		let store = stores.get(workspacePath);
		if (!store) {
			store = createPlanStore({ workspacePath });
			stores.set(workspacePath, store);
		}
		return store;
	};
	return { workspace, storeFor };
}
