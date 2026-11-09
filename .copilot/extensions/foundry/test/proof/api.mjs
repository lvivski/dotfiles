/** @template T, R @param {import("./types.js").AdmissionPolicy<T, R>} policy */
export function createAdmissionApi(policy) {
	return Object.freeze({
		/** @param {T} tasks @param {number} capacity */
		schedule(tasks, capacity) {
			return policy.schedule(tasks, capacity);
		},
	});
}
