import { createPlanStore } from "../storage.mjs";
import { FoundryStorageError } from "../storage/errors.mjs";
import { createRetentionPersistence } from "../storage/retention.mjs";
import { createRetentionOperations } from "./retention.mjs";

/** @typedef {(repositoryPath: string) => (Omit<import("../types/retention.js").RetentionDependencies, "persistence"> &
 * {canonical?: import("../types/retention.js").RetentionCanonicalPort}) | undefined} RetentionBindings */

/**
 * @param {() => string | undefined} getWorkspacePath
 * @param {RetentionBindings} [getRetention]
 */
export function createSessionStorage(getWorkspacePath, getRetention) {

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
	/** @param {string} repositoryPath @param {string} repositoryId */
	function retentionFor(repositoryPath, repositoryId) {
		const binding = getRetention?.(repositoryPath);
		if (!binding?.canonical) {
			throw new FoundryStorageError("retention_persistence_unsupported",
				"Canonical archive transaction/outbox binding is unavailable; dispatch storage cannot substitute for it");
		}
		if (binding.scope.owner !== workspace() || binding.scope.repositoryId !== repositoryId) {
			throw new FoundryStorageError("retention_foreign", "Retention requires the current canonical repository and owner");
		}
		return createRetentionOperations({
			...binding, persistence: createRetentionPersistence({ scope: binding.scope, canonical: binding.canonical }),
		});
	}
	return { workspace, storeFor, retentionFor };
}
