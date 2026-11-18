import { readCandidate } from "./artifacts.mjs";
import { FoundryError, array, closedFields, record, text } from "./values.mjs";

/** @typedef {import("./database.mjs").Transaction} Tx */
/** @typedef {import("./model.d.ts").BacklogItem} Item */
/** @typedef {import("./model.d.ts").ProductRule} ProductRule */
/** @typedef {import("./model.d.ts").PinnedInput} PinnedInput */
/** @param {unknown} value @returns {ProductRule[]} */
export function contracts(value) {
	return array(value ?? [], entry => {
		const row = record(entry);
		closedFields(row, ["consumer", "producer", "output"], "required product");
		return { consumer: text(row.consumer, "consumer template"), producer: text(row.producer, "producer template"), output: text(row.output, "required published output") };
	});
}
/** @param {ProductRule[]} rules @param {Set<string>} templates @returns {void} */
export function validateContracts(rules, templates) {
	const visits = new Set(), done = new Set(), edges = new Set(), outputs = new Map();
	for (const { consumer, producer, output } of rules) {
		const edge = JSON.stringify([consumer, output]);
		if (!templates.has(consumer) || !templates.has(producer) || edges.has(edge) || outputs.has(producer) && outputs.get(producer) !== output) {
			throw new FoundryError("invalid_product_contract", "Each input requires one chartered producer template with one declared output");
		}
		edges.add(edge); outputs.set(producer, output);
	}
	/** @param {string} id */
	function walk(id) {
		if (visits.has(id)) throw new FoundryError("dependency_cycle", "Required product templates contain a cycle");
		if (done.has(id)) return;
		visits.add(id);
		for (const rule of rules.filter(rule => rule.consumer === id)) walk(rule.producer);
		visits.delete(id); done.add(id);
	}
	for (const id of templates) walk(id);
}
/** @param {Tx} tx @param {Item} item @param {string} output @returns {PinnedInput} */
function published(tx, item, output) {
	if (item.state !== "accepted" || !item.goalId || !item.resultId) throw new FoundryError("product_unpublished", "Bind an accepted canonical producer item");
	const completion = tx.get("goal_completions", item.goalId), result = tx.get("results", item.resultId);
	const producer = tx.get("tasks", completion.taskId), attempt = tx.get("attempts", result.attemptId);
	const actual = result.outputs.find(value => value.name === output && ["artifact", "code"].includes(value.kind));
	if (!completion.closed || !completion.accepted || attempt.taskId !== producer.id || attempt.id !== producer.currentAttemptId
		|| result.state !== "done" || tx.db.prepare("SELECT promoted FROM outcomes WHERE result_id=?").get(result.id)?.promoted !== 1
		|| producer.deliverable !== output || !actual || !readCandidate(actual.reference, actual.version, tx.databasePath)) {
		throw new FoundryError("product_unpublished", "Required product needs its exact promoted, evaluated output from its own sealed final task");
	}
	return { taskId: producer.id, output, version: actual.version };
}
/** @param {Tx} tx @param {string} factoryId @param {string} template @param {Record<string,string>} sources @param {boolean} [resolve] @returns {PinnedInput[]} */
export function inputs(tx, factoryId, template, sources, resolve = false) {
	const rules = contracts(record(tx.get("factory_controls", factoryId).definition).requiredProducts).filter(rule => rule.consumer === template);
	if (Object.keys(sources).length !== rules.length || rules.some(rule => !Object.hasOwn(sources, rule.output))) {
		throw new FoundryError("required_products", "Name a source item for every required product, and no unrelated product");
	}
	return rules.flatMap(rule => {
		const source = tx.get("backlog_items", sources[rule.output]);
		if (source.template !== rule.producer || source.factoryId !== factoryId || ["retired", "proposal"].includes(source.state)) {
			throw new FoundryError("wrong_product_source", "Required product must originate with the policy's producer template in this factory");
		}
		return resolve ? [published(tx, source, rule.output)] : [];
	});
}

/** Check the evaluated bytes, not a local ref or the presence of dependency metadata.
 * @param {Tx} tx @param {import("./model.d.ts").Task} task @param {import("./model.d.ts").Result} result @returns {void} */
export function verifyConservation(tx, task, result) {
	const item = tx.list("backlog_items", "WHERE goal_id=?", [task.goalId])[0];
	if (!item || !Object.keys(item.sources).length || tx.get("goal_completions", task.goalId).taskId !== task.id) return;
	const products = inputs(tx, item.factoryId, item.template, item.sources, true);
	const joined = result.outputs.find(output => output.name === task.deliverable && ["artifact", "code"].includes(output.kind));
	const candidate = joined && readCandidate(joined.reference, joined.version, tx.databasePath);
	const attempt = tx.get("attempts", result.attemptId);
	if (!candidate) throw new FoundryError("product_lineage_mismatch", "Publish the actual evaluated joined bundle");
	for (const expected of products) {
		const output = tx.get("tasks", expected.taskId).outputs.find(output => output.name === expected.output && output.version === expected.version);
		const source = output && readCandidate(output.reference, output.version, tx.databasePath);
		if (!attempt.inputs.some(input => input.taskId === expected.taskId && input.output === expected.output && input.version === expected.version)
			|| !source?.files.length || source.files.some(file => !candidate.files.some(entry =>
				entry.path === file.path && entry.sha256 === file.sha256 && entry.mode === file.mode))) {
			throw new FoundryError("product_lineage_mismatch", `Joined product must conserve every evaluated path, byte and mode of ${expected.output} at ${expected.version}`);
		}
	}
}
