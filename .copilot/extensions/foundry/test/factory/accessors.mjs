import assert from "node:assert/strict";
import { arrayOf, isOneOf, parseJson, readNumber, readRecord, readString, recordOf } from "../../data.mjs";
import { FACTORY_ACTIONS } from "../../factory/storage.mjs";

/** @param {ReturnType<typeof import("../../factory.mjs").createFactoryService>} service */
export function factoryMutator(service) {
	/** @type {{[A in import("../../types/factory.js").FactoryCommand]: (input: Record<string, unknown>) => import("../../types/factory.js").FactoryMutationResult<A>}} */
	const methods = service;
	/** @template {import("../../types/factory.js").FactoryCommand} A
	 * @param {A} action @param {Record<string, unknown>} input @returns {import("../../types/factory.js").FactoryMutationResult<A>}
	 */
	return (action, input) => methods[action]({ expectedRevision: service.snapshot().revision, ...input });
}

/** Read logical exports without claiming that their action payloads have been replayed.
 * @param {string} source @returns {import("../../types/factory.js").FactoryDocument} */
export function factoryDocument(source) {
	/** @param {unknown} value @returns {import("../../types/factory.js").FactoryAction} */
	const action = (value) => {
		assert.ok(isOneOf(value, FACTORY_ACTIONS));
		return value;
	};
	return recordOf({
		format: readString, repository: recordOf({ id: readString, commonDirectory: readString }), revision: readNumber,
		events: arrayOf(recordOf({ revision: readNumber, at: readString, action, input: readRecord })),
	})(parseJson(source));
}
