import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { preparedDispatch, waitTask } from "./attempts.mjs";
import { compileDefinition } from "./compiler.mjs";
import { decodeDirection, directionRecord, itemRecord, squadRecord } from "./direction.mjs";
import { compileFactoryContext, templateChecks } from "./factory.mjs";
import { admitFactoryJob, completionStatus, freeJobs } from "./jobs.mjs";
import { contracts, inputs as productInputs } from "./lineage.mjs";
import { createUnit, notifyCoordination } from "./organization.mjs";
import { budgetAvailable } from "./policy.mjs";
import { cancelTask, createGoal, createTask, replaceInputs } from "./tasks.mjs";
import { wake } from "./wakes.mjs";
import { FoundryError, array, choice, closedFields, containsPath, decodeLimits, decodeScope, digest, json, narrowScope, natural, positive, record, resourcePath, strings, text } from "./values.mjs";

/** @typedef {import("./database.mjs").Transaction} Tx */
/** @typedef {import("./model.d.ts").FactoryControl} Factory */
/** @typedef {import("./model.d.ts").Squad} Squad */
/** @typedef {import("./model.d.ts").BacklogItem} Item */
/** @typedef {import("./model.d.ts").Task} Task */
/** @typedef {{path:string,sha256:string,content:string} & ({source:"policy",commit?:never}|{source:"git",commit:string})} ObservationSource */
/** @typedef {{squad:Squad,item?:never,duplicateOf?:never,state?:never}|{item:Item,squad?:never,duplicateOf?:never,state?:never}|{duplicateOf:string,state:Item["state"],squad?:never,item?:never}} ObservationResult */
/** @param {string} kind @param {...string} parts */
const key = (kind, ...parts) => `${kind}:${digest(parts)}`;
const byFactory = "WHERE json_extract(document,'$.factoryId')=?";
/** @param {Tx} tx @param {string} id */
function latest(tx, id) { return tx.list("directions", byFactory, [id]).at(-1); }
/** @param {Tx} tx @param {Squad} squad @param {string} reason */
function trigger(tx, squad, reason) {
	squad.generation++;
	squad.reason = reason;
	tx.put("squads", squad);
	notifyCoordination(tx, tx.get("tasks", squad.taskId), reason);
}

/** @param {Tx} tx @param {Factory} factory @param {string} actor @returns {{tasks:Task[],replay:boolean}} */
export function activateSubscriptions(tx, factory, actor) {
	const policy = record(factory.definition);
	const prior = latest(tx, factory.id);
	if (prior) {
		const squads = tx.list("squads", byFactory, [factory.id]);
		for (const squad of squads) trigger(tx, squad, `activation:${factory.generation}`);
		return { tasks: squads.map(squad => tx.get("tasks", squad.taskId)), replay: true };
	}
	const direction = decodeDirection(policy.direction);
	tx.put("directions", directionRecord({ id: key("direction", factory.id, String(direction.revision)), factoryId: factory.id, direction, source: factory.source.sha256 }));
	const goalPolicy = record(policy.goal);
	const goal = createGoal(tx, { id: key("subscriptions", factory.id), title: `Squad discovery: ${factory.id}`,
		scope: decodeScope(goalPolicy.scope), limits: decodeLimits(goalPolicy.limits ?? {}), source: factory.source,
		...(goalPolicy.projectId ? { projectId: text(goalPolicy.projectId, "project") } : {}) }, actor);
	const tasks = [];
	for (const charter of array(policy.charters, record)) {
		if (!strings(charter.outcomes ?? []).length) continue;
		const name = text(charter.name, "charter");
		const id = key("squad", factory.id, name);
		const templates = strings(charter.taskIds);
		const scope = decodeScope(charter.scope);
		const unit = createUnit(tx, { goalId: goal.id, name, kind: "squad", context: strings(charter.context) }, actor);
		const task = createTask(tx, { goalId: goal.id, id: `${id}:lead`, unitId: unit.id, role: "coordinator",
			title: `${name} discovery`, assignment: `Own ${name}'s backlog for ${factory.id}. Read foundry_get_context for current direction and evidence. Use foundry_inspect_evidence and foundry_observe_work to record a specific gap, bounded question, or evidenced no-gap disposition. Pull the highest eligible item with foundry_pull_work, and split independently testable outputs when justified. Charter membership alone grants no execution authority.`,
			workType: text(scope.workTypes[0], "charter work type"), scope,
			dispatch: { generator: false, context: strings(charter.context), ...(charter.agent ? { agent: text(charter.agent, "agent") } : {}) } }, actor, true);
		tx.put("squads", squadRecord({ id, factoryId: factory.id, name, taskId: task.id, goalId: goal.id, outcomes: charter.outcomes,
			templates, scope, revision: direction.revision, generation: 1, handled: 0, questions: 0, discoveryLimit: charter.discoveryLimit, reason: "initial-direction" }));
		tasks.push(task);
	}
	return { tasks, replay: false };
}

/** @param {Tx} tx @param {string} squadId @param {number} revision @param {string} actor @param {number} [activation]
 * @returns {{squad:Squad,factory:Factory,task:Task,attempt:import("./model.d.ts").Attempt}} */
export function requireSquad(tx, squadId, revision, actor, activation) {
	const squad = tx.get("squads", squadId);
	const factory = tx.get("factory_controls", squad.factoryId);
	const task = tx.get("tasks", squad.taskId);
	const attempt = task.currentAttemptId ? tx.get("attempts", task.currentAttemptId) : undefined;
	if (task.owner !== actor || attempt?.nativeId !== actor || attempt.taskVersion !== task.version || attempt.supersededBy
		|| !["waiting", "running"].includes(attempt.state) || !["waiting", "running"].includes(task.state)
		|| tx.db.prepare("SELECT 1 FROM local_attempts WHERE attempt_id=?").get(attempt.id)) {
		throw new FoundryError("unbound_squad", "Only the charter's current native coordinator can admit, pull or decompose its work");
	}
	if (factory.state !== "active" || factory.pausedWorkers.includes(actor)) throw new FoundryError("factory_paused", "The factory or squad owner is paused");
	if (activation !== factory.generation) throw new FoundryError("stale_activation", "Read the current factory generation before changing its backlog");
	if (squad.revision !== revision) throw new FoundryError("stale_direction", "Reassess against the active direction");
	if (task.waiting?.kind === "input" || !budgetAvailable(tx, tx.get("goals", squad.goalId))) throw new FoundryError("squad_held", "Resolve the squad's actual input or budget hold first");
	return { squad, factory, task, attempt };
}
/** @param {Tx} tx @param {Record<string,unknown>} input @param {string} actor */
function bound(tx, input, actor) {
	return requireSquad(tx, text(input.squadId, "squad"), positive(input.revision, "direction revision"), actor, positive(input.activation, "activation"));
}
/** @param {Factory} factory @param {Squad} squad */
function charter(factory, squad) {
	const entry = array(record(factory.definition).charters, record).find(row => row.name === squad.name);
	if (!entry) throw new FoundryError("charter_missing", "Subscription no longer matches pinned policy");
	return entry;
}

/** Repository evidence is data, never a command. Read by immutable blob ID, not through the working tree.
 * @param {Tx} tx @param {Factory} factory @param {Squad} squad @param {unknown} name @param {unknown} [commit] @returns {ObservationSource} */
function readObservation(tx, factory, squad, name, commit) {
	const pathname = resourcePath(name);
	const declared = array(charter(factory, squad).knowledgeFiles ?? [], record).find(file => file.path === pathname);
	if (declared && commit === undefined) {
		const captured = record(record(record(factory.definition).captured)[pathname]);
		return { path: pathname, sha256: text(captured.sha256, "pinned digest"), content: text(captured.content, "pinned bytes"), source: "policy" };
	}
	if (!squad.scope.paths.some(root => containsPath(root, pathname))) throw new FoundryError("evidence_scope", "Inspect only charter sources or committed files in charter scope");
	const git = (/** @type {string[]} */ args) => execFileSync("git", ["-C", tx.cwd, "--literal-pathspecs", ...args], { maxBuffer: 1024 * 1024 });
	const ref = commit === undefined ? "HEAD" : text(commit, "commit");
	if (ref !== "HEAD" && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(ref)) throw new FoundryError("invalid_revision", "Use an actual commit object id");
	const revision = git(["rev-parse", "--verify", `${ref}^{commit}`]).toString().trim();
	const entry = git(["ls-tree", "--full-tree", "-z", revision, "--", pathname]).toString().split("\t")[0];
	const blob = /^100(?:644|755) blob ([a-f0-9]+)$/u.exec(entry)?.[1];
	if (!blob) throw new FoundryError("evidence_missing", "Expected an exact regular committed file, not a link, tree, or missing path");
	if (Number(git(["cat-file", "-s", blob]).toString()) > 128 * 1024) throw new FoundryError("evidence_size", "Use a bounded evidence artifact of at most 128 KiB");
	const bytes = git(["cat-file", "blob", blob]);
	return { path: pathname, commit: revision, sha256: createHash("sha256").update(bytes).digest("hex"), content: bytes.toString("utf8"), source: "git" };
}
/** @param {Tx} tx @param {Record<string,unknown>} input @param {string} actor @returns {ObservationSource} */
export function inspect(tx, input, actor) {
	const { squad, factory } = bound(tx, input, actor);
	return readObservation(tx, factory, squad, input.path, input.commit);
}
/** @param {Tx} tx @param {Factory} factory @param {Squad} squad @param {unknown} evidence */
function pin(tx, factory, squad, evidence) {
	return array(evidence, value => {
		const ref = record(value);
		if (ref.resultId !== undefined) {
			closedFields(ref, ["resultId"], "result evidence");
			const result = tx.get("results", text(ref.resultId, "result"));
			const task = tx.get("tasks", tx.get("attempts", result.attemptId).taskId);
			if (tx.optional("goal_completions", task.goalId)?.factoryId !== factory.id
				|| tx.db.prepare("SELECT promoted FROM outcomes WHERE result_id=?").get(result.id)?.promoted !== 1) {
				throw new FoundryError("unverified_observation", "Use a promoted result from this factory");
			}
			return json({ resultId: result.id, version: digest(json(result)) });
		}
		closedFields(ref, ["path", "sha256", "commit"], "file evidence");
		const { content: _content, ...observed } = readObservation(tx, factory, squad, ref.path, ref.commit);
		if (observed.sha256 !== ref.sha256) throw new FoundryError("unverified_observation", "Evidence no longer matches the specified bytes");
		return json(observed);
	});
}

/** @param {Tx} tx @param {Record<string,unknown>} input @param {string} actor @returns {ObservationResult} */
export function observe(tx, input, actor) {
	const { squad, factory, task, attempt } = bound(tx, input, actor);
	const entry = record(input.observation);
	const kind = choice(entry.kind, ["no-gap", "gap", "question", "advisory"], "observation kind");
	const evidence = pin(tx, factory, squad, entry.evidence ?? []);
	const gap = text(entry.gap, "specific observation or question");
	if (kind === "no-gap") {
		closedFields(entry, ["kind", "gap", "evidence"], "no-gap observation");
		if (positive(input.generation, "observed generation") !== squad.generation) throw new FoundryError("stale_generation", "New evidence arrived; do not clear a newer discovery turn");
		if (!evidence.length) throw new FoundryError("unverified_observation", "Record the source checked before sleeping");
		squad.reason = `${gap} (${JSON.stringify(evidence)})`;
		squad.handled = squad.generation;
		tx.put("squads", squad);
		const otherWork = task.coordination?.causes.some(cause => !/^(?:admission$|admitted:|accepted:|signal:|activation:|direction:)/u.test(cause));
		waitTask(tx, task.id, actor, { kind: "events", reason: squad.reason }, { attemptId: attempt.id, ...(otherWork ? {} : { handledGeneration: task.coordination?.generation }) });
		return { squad };
	}
	closedFields(entry, ["kind", "gapKey", "outcome", "template", "title", "gap", "improvement", "stop", "evidence", "scope", "dependencies", "predecessor", "severity", "cost", "sources"], "work observation");
	const outcome = text(entry.outcome, "outcome"), template = text(entry.template, "acceptance template");
	const gapKey = text(entry.gapKey, "stable gap identity").trim().normalize("NFKC").toLowerCase();
	const predecessor = entry.predecessor === undefined ? undefined : tx.get("backlog_items", text(entry.predecessor, "predecessor"));
	if (predecessor && (predecessor.factoryId !== factory.id || predecessor.state !== "accepted")) throw new FoundryError("successor_unverified", "Link successors to an actually accepted item");
	const sources = Object.fromEntries(Object.entries(record(entry.sources ?? {})).map(([output, id]) => [output, text(id, "source item")]));
	productInputs(tx, factory.id, template, sources);
	const dependencies = [...new Set([...strings(entry.dependencies ?? []), ...Object.values(sources)])];
	for (const id of dependencies) {
		const other = tx.get("backlog_items", id);
		if (other.factoryId !== factory.id || ["retired", "proposal"].includes(other.state)) throw new FoundryError("invalid_dependency", "Depend only on real, non-retired work inside this factory");
	}
	let scope = squad.scope;
	let reason;
	try { scope = narrowScope(squad.scope, entry.scope); }
	catch (error) { if (!(error instanceof FoundryError) || error.code !== "scope_widening") throw error; reason = error.message; }
	const direction = latest(tx, factory.id);
	if (!squad.outcomes.includes(outcome) || !direction?.outcomes.some(item => item.id === outcome) || !squad.templates.includes(template)) reason = "Outside this charter's current outcomes or acceptance templates";
	if (kind === "gap" && !evidence.length) reason = "No verified observation";
	if (kind === "advisory") reason = "Advisory only";
	if (!reason) {
		const row = array(record(record(factory.definition).goal).tasks, record).find(row => row.id === template);
		const governing = narrowScope(squad.scope, row?.scope);
		if (!scope.paths.every(p => governing.paths.some(root => containsPath(root, p))) && entry.scope !== undefined) reason = "Requested write boundary is outside the accepted template";
		else if (entry.scope === undefined) scope = governing;
		if (!scope.workTypes.includes("*") && !scope.workTypes.includes(text(row?.workType, "template work type"))
			|| templateChecks(record(factory.definition), template, row?.checks).some(check => check.artifactFiles?.some(p => !scope.paths.some(root => containsPath(root, p))))) {
			reason = "Requested scope cannot deliver this template's required artifact";
		}
	}
	let id = key(reason ? "proposal" : "item", factory.id, outcome, gapKey, ...(reason ? [squad.id, String(squad.revision)] : []));
	let existing = tx.optional("backlog_items", id);
	if (existing?.state === "retired" && existing.revision < squad.revision && !reason) {
		const related = tx.list("backlog_items", `${byFactory} AND json_extract(document,'$.outcome')=? AND json_extract(document,'$.gapKey')=?`, [factory.id, outcome, gapKey]);
		existing = related.find(item => !["proposal", "retired"].includes(item.state));
		id = key("item", factory.id, outcome, gapKey, String(squad.revision));
	}
	const observation = json({ actor, squad: squad.id, revision: squad.revision, gap, kind, evidence, requestedScope: entry.scope ?? null });
	if (existing) {
		if (!existing.observations.some(prior => digest(prior) === digest(observation))) {
			existing.observations.push(observation);
			tx.put("backlog_items", existing);
		}
		return { duplicateOf: existing.id, state: existing.state };
	}
	if (!reason && kind === "question" && squad.questions >= squad.discoveryLimit) throw new FoundryError("discovery_exhausted", "This revision's bounded question allowance is exhausted");
	const item = itemRecord({ id, factoryId: factory.id, squad: squad.id, outcome, gapKey, kind, state: reason ? "proposal" : "queued",
		revision: squad.revision, currentRevision: squad.revision, template, title: entry.title, gap, improvement: entry.improvement, stop: entry.stop,
		evidence, observations: [observation], scope, dependencies, sources, predecessor: predecessor?.id, severity: entry.severity ?? 0, cost: entry.cost ?? 1, owner: actor,
		createdAt: tx.timestamp(), reason, splits: [] });
	tx.put("backlog_items", item);
	if (!reason) {
		if (kind === "question") squad.questions++;
		trigger(tx, squad, `admitted:${item.id}`);
	}
	return { item };
}

/** @param {Tx} tx @param {Squad} squad */
function ranked(tx, squad) {
	const priorities = new Map(latest(tx, squad.factoryId)?.outcomes.map(outcome => [outcome.id, outcome.priority]));
	return tx.list("backlog_items", "WHERE state='queued' AND json_extract(document,'$.squad')=?", [squad.id])
		.filter(item => item.currentRevision === squad.revision && item.dependencies.every(id => tx.get("backlog_items", id).state === "accepted"))
		.sort((a, b) => (priorities.get(a.outcome) ?? Infinity) - (priorities.get(b.outcome) ?? Infinity)
			|| b.severity - a.severity || a.cost - b.cost || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** When squads contend for the last whole-job slots, older eligible queue heads
 * take precedence. No reservation is made on behalf of another owner.
 * @param {Tx} tx @param {Factory} factory */
function pullWindow(tx, factory) {
	const slots = freeJobs(tx, factory);
	const contenders = tx.list("squads", byFactory, [factory.id]).flatMap(squad => {
		const lead = tx.get("tasks", squad.taskId);
		const attempt = lead.currentAttemptId && tx.get("attempts", lead.currentAttemptId);
		if (!attempt || attempt.nativeId !== lead.owner || attempt.taskVersion !== lead.version || !["waiting", "running"].includes(attempt.state)
			|| lead.waiting?.kind === "input" || factory.pausedWorkers.includes(lead.owner) || !budgetAvailable(tx, tx.get("goals", squad.goalId))) return [];
		const head = ranked(tx, squad)[0];
		return head ? [head] : [];
	}).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
	return { slots, eligible: contenders.slice(0, slots).map(item => item.id) };
}
/** @param {Factory} factory @param {Squad} squad @param {Item} item @param {string} templateId */
function templateFor(factory, squad, item, templateId) {
	if (!squad.templates.includes(templateId)) throw new FoundryError("unknown_template", "Producer template is not in this charter");
	const policy = record(factory.definition);
	const row = array(record(policy.goal).tasks, record).find(task => task.id === templateId);
	if (!row) throw new FoundryError("unknown_template", "Producer template absent from activation");
	return { workType: text(row.workType, "work type"), title: text(row.title, "template title"), assignment: text(row.assignment, "template assignment"),
		scope: templateId === item.template ? item.scope : narrowScope(item.scope, row.scope), checks: templateChecks(policy, templateId, row.checks), dispatch: compileFactoryContext(factory.definition, factory.source, templateId) };
}

/** @param {Tx} tx @param {Record<string,unknown>} input @param {string} actor
 * @returns {{item:Item,replay:true,tasks?:never}|{item:Item,replay:false,tasks:Task[]}} */
export function pull(tx, input, actor) {
	const { squad, factory } = bound(tx, input, actor);
	const itemId = text(input.itemId, "observed highest ready item");
	const item = tx.get("backlog_items", itemId);
	if (item.squad !== squad.id) throw new FoundryError("foreign_item", "Cannot pull another squad's queue");
	if (item.goalId) return { item, replay: true };
	if (ranked(tx, squad)[0]?.id !== itemId) throw new FoundryError("not_highest_ready", "Pull the current highest-ranked unblocked item");
	const window = pullWindow(tx, factory);
	if (!window.slots) throw new FoundryError("factory_capacity", "Wait for a bounded job to seal and settle");
	if (!window.eligible.includes(itemId)) throw new FoundryError("older_squad_ready", "Another squad has an older eligible queue head for the remaining capacity");
	const policy = record(record(factory.definition).goal);
	const goalId = key("job", item.id), finalId = `${goalId}:acceptance`;
	const producer = templateFor(factory, squad, item, item.template);
	const deliverable = contracts(record(factory.definition).requiredProducts).find(rule => rule.producer === item.template)?.output ?? "product";
	const inputs = productInputs(tx, factory.id, item.template, item.sources, true);
	const direction = latest(tx, factory.id);
	const source = { reference: `${factory.source.reference}#${item.id}`, sha256: digest(json({ item, policy: factory.source.sha256, direction: direction?.source })) };
	const compiled = compileDefinition({ title: item.title, id: goalId, scope: narrowScope(item.scope, { restrictions: direction?.constraints }),
		projectId: policy.projectId, limits: policy.limits,
		tasks: [{ id: finalId, title: item.title, assignment: `${producer.assignment}\nItem ${item.id}: ${item.gap}\nExpected: ${item.improvement}\nStop: ${item.stop}\nPinned evidence: ${JSON.stringify(item.evidence)}\nPublish output: ${deliverable}.`,
			workType: producer.workType, scope: producer.scope, checks: producer.checks, inputs }] }, source);
	const job = admitFactoryJob(tx, compiled.goal, compiled.tasks.map(task => ({ ...task, dispatch: producer.dispatch, deliverable })),
		factory.id, finalId, actor, factory.generation, false, [], item);
	item.state = "pulled"; item.goalId = job.goal.id;
	tx.put("backlog_items", item);
	return { item, tasks: job.tasks, replay: false };
}

/** @param {Tx} tx @param {Record<string,unknown>} input @param {string} actor @returns {{split:Item["splits"][number],replay:boolean}} */
export function split(tx, input, actor) {
	const { squad, factory } = bound(tx, input, actor);
	const item = tx.get("backlog_items", text(input.itemId, "item"));
	if (item.squad !== squad.id || item.state !== "pulled" || !item.goalId) throw new FoundryError("foreign_item", "Only this squad's active pulled item can be split");
	const completion = tx.get("goal_completions", item.goalId);
	const final = tx.get("tasks", completion.taskId);
	const id = text(input.splitId, "stable split identity");
	const plan = record(input.plan);
	closedFields(plan, ["specification", "boundary", "examples", "negativeCases", "producers", "requires"], "local plan");
	const hash = digest(json(plan));
	const previous = item.splits.find(split => split.id === id);
	if (previous) {
		if (previous.hash !== hash) throw new FoundryError("split_conflict", "A split identity cannot change its spec or graph");
		return { split: previous, replay: true };
	}
	if (final.version !== positive(input.expectedVersion, "acceptance version") || final.state !== "ready") throw new FoundryError("split_conflict", "Split only before the current acceptance execution is reserved");
	const specification = text(plan.specification, "behavior specification"), boundary = text(plan.boundary, "observable boundary");
	const examples = strings(plan.examples), negatives = strings(plan.negativeCases);
	if (!examples.length || !negatives.length) throw new FoundryError("invalid_spec", "Provide both examples and distinguishing negative cases");
	const nodes = array(plan.producers, record);
	const descriptors = new Map(nodes.map(node => {
		closedFields(node, ["id", "template", "title", "output", "purpose", "stop", "scope", "inputs"], "atomic producer");
		const nodeId = text(node.id, "local producer id");
		return [nodeId, { id: key("producer", item.id, id, nodeId), output: text(node.output, "named output") }];
	}));
	if (!nodes.length || descriptors.size !== nodes.length) throw new FoundryError("invalid_plan", "A split needs distinct independently checkable producer identities");
	/** @param {unknown} value */
	const edge = value => {
		const row = record(value), local = text(row.taskId, "producer"), output = text(row.output, "required output");
		const node = descriptors.get(local);
		if (node?.output === output) return { taskId: node.id, output };
		const older = item.splits.some(split => split.taskIds.includes(local)) ? tx.get("tasks", local) : undefined;
		if (older?.deliverable === output) return { taskId: local, output };
		throw new FoundryError("missing_output", "A dependency must name a declared producer and its exact output inside this item");
	};
	const tasks = nodes.map(row => {
		const template = text(row.template, "governing template"), producer = templateFor(factory, squad, item, template);
		const node = descriptors.get(text(row.id, "local producer id"));
		if (!node) throw new FoundryError("invalid_plan", "Missing producer");
		return { id: node.id, title: text(row.title, "atomic outcome"), workType: producer.workType, scope: narrowScope(producer.scope, row.scope),
			checks: producer.checks, inputs: array(row.inputs ?? [], edge),
			assignment: `${producer.assignment}\nSpecification ${hash}: ${specification}\nBoundary: ${boundary}\nExamples: ${JSON.stringify(examples)}\nCounterexamples: ${JSON.stringify(negatives)}\nPurpose: ${text(row.purpose, "product or consumer purpose")}\nPublish: ${node.output}\nStop: ${text(row.stop, "stop condition")}`,
			dispatch: producer.dispatch, deliverable: node.output };
	});
	const required = array(plan.requires, edge);
	const reachable = new Set(required.map(input => input.taskId));
	for (const id of reachable) for (const input of tasks.find(task => task.id === id)?.inputs ?? []) reachable.add(input.taskId);
	if (tasks.some(task => !reachable.has(task.id))) throw new FoundryError("unused_producer", "No speculative leaves: each output must reach product acceptance");
	const compiled = compileDefinition({ title: item.title, scope: tx.get("goals", item.goalId).scope, tasks: tasks.map(({ dispatch, deliverable, ...task }) => task) });
	for (const task of compiled.tasks) {
		const descriptor = tasks.find(node => node.id === task.id);
		if (!descriptor) throw new FoundryError("invalid_plan", "Missing compiled producer");
		createTask(tx, { ...task, dispatch: descriptor.dispatch, deliverable: descriptor.deliverable, goalId: item.goalId }, actor, true);
	}
	const inputs = [...final.inputs, ...required.filter(next => !final.inputs.some(old => old.taskId === next.taskId && old.output === next.output))];
	replaceInputs(tx, final, inputs, actor);
	completion.requiredInputs = inputs;
	tx.put("goal_completions", completion);
	const split = { id, hash, plan: json(plan), taskIds: tasks.map(task => task.id) };
	item.splits.push(split);
	tx.put("backlog_items", item);
	return { split, replay: false };
}

/** @param {Tx} tx @param {string} factoryId @param {number} revision @param {unknown} value @param {string} source @param {string} actor
 * @returns {import("./model.d.ts").DirectionRecord} */
export function reviseDirection(tx, factoryId, revision, value, source, actor) {
	const factory = tx.get("factory_controls", factoryId), prior = latest(tx, factoryId), next = decodeDirection(value);
	if (factory.owner !== actor || factory.state !== "active") throw new FoundryError("forbidden", "Only the active factory owner may apply operator direction");
	if (!prior || prior.revision !== revision || next.revision !== revision + 1) throw new FoundryError("stale_direction", "Direction must advance exactly one revision from the expected snapshot");
	const squads = tx.list("squads", byFactory, [factoryId]);
	if (next.outcomes.some(outcome => !squads.some(squad => squad.outcomes.includes(outcome.id)))) throw new FoundryError("uncharted_outcome", "Changing charter authority requires a new factory definition");
	const direction = directionRecord({ factoryId, id: key("direction", factoryId, String(next.revision)), direction: next, source });
	tx.put("directions", direction);
	for (const item of tx.list("backlog_items", byFactory, [factoryId])) {
		if (!["queued", "pulled"].includes(item.state)) continue;
		const previous = prior.outcomes.find(outcome => outcome.id === item.outcome), current = next.outcomes.find(outcome => outcome.id === item.outcome);
		if (!current || previous?.success !== current.success || previous.title !== current.title
			|| digest(prior.constraints) !== digest(next.constraints) || digest(prior.nonGoals) !== digest(next.nonGoals)) {
			item.state = "retired"; item.reason = "Outcome or constraints superseded; reassess under the new direction";
			tx.put("backlog_items", item);
			if (item.goalId) for (const task of tx.list("tasks", "WHERE goal_id=? AND parent_id IS NULL", [item.goalId])) cancelTask(tx, task.id, actor);
			continue;
		} else item.currentRevision = next.revision;
		tx.put("backlog_items", item);
	}
	for (const squad of squads) {
		squad.revision = next.revision; squad.questions = 0;
		trigger(tx, squad, `direction:${next.revision}`);
	}
	return direction;
}

/** @param {Tx} tx @param {string} goalId @param {string} resultId @returns {void} */
export function accepted(tx, goalId, resultId) {
	const item = tx.list("backlog_items", "WHERE goal_id=? AND state='pulled'", [goalId])[0];
	if (!item || !tx.get("goal_completions", goalId).closed) return;
	item.state = "accepted"; item.resultId = resultId;
	tx.put("backlog_items", item);
	const squad = tx.get("squads", item.squad);
	trigger(tx, squad, `accepted:${item.id}`);
	wake(tx, tx.get("tasks", squad.taskId).owner, squad.goalId, `output:${tx.get("goal_completions", goalId).taskId}`);
	recycleCapacity(tx, goalId);
}

/** Issue the queue-opening trigger once, only when this job really releases
 * capacity: acceptance may precede the last native command or claim settlement.
 * @param {Tx} tx @param {string} goalId @returns {void} */
export function recycleCapacity(tx, goalId) {
	const item = tx.list("backlog_items", "WHERE goal_id=? AND json_extract(document,'$.capacityReleased')=0", [goalId])[0];
	if (!item) return;
	const completion = tx.get("goal_completions", goalId);
	const status = completionStatus(tx, completion);
	if (!status.settled || !status.delivered && !status.cancelled) return;
	item.capacityReleased = true;
	if (status.cancelled && item.state === "pulled") { item.state = "retired"; item.reason = "Bounded job cancelled"; }
	tx.put("backlog_items", item);
	for (const id of new Set(tx.list("backlog_items", `${byFactory} AND state='queued'`, [item.factoryId]).map(other => other.squad))) {
		const squad = tx.get("squads", id);
		if (!ranked(tx, squad).length) continue;
		trigger(tx, squad, `queue-opening:${item.id}`);
		if (status.delivered) wake(tx, tx.get("tasks", squad.taskId).owner, squad.goalId, `output:${completion.taskId}`);
	}
}

/** A published final product is evidence for its own squad and releases a whole-job slot
 * for squads with actual queued work. This is not a blanket cross-goal wake route.
 * @param {Tx} tx @param {string} taskId @param {string} goalId @returns {string[]} */
export function successorOwners(tx, taskId, goalId) {
	const task = tx.get("tasks", taskId);
	const item = tx.list("backlog_items", "WHERE goal_id=? AND state='accepted'", [task.goalId])[0];
	if (!item || tx.get("goal_completions", task.goalId).taskId !== taskId) return [];
	return tx.list("squads", "WHERE goal_id=?", [goalId]).filter(squad => squad.factoryId === item.factoryId
		&& (squad.id === item.squad || ranked(tx, squad).length)).map(squad => tx.get("tasks", squad.taskId).owner);
}

/** @param {Tx} tx @param {import("./model.d.ts").Signal} signal @returns {void} */
export function signalDiscovery(tx, signal) {
	const unitTask = signal.unitId ? tx.list("tasks", "WHERE json_extract(document,'$.unitId')=? AND json_extract(document,'$.role')='coordinator'", [signal.unitId])[0] : undefined;
	const squad = tx.list("squads", "WHERE task_id=?", [signal.taskId ?? unitTask?.id ?? ""])[0];
	if (squad) trigger(tx, squad, `signal:${signal.id}`);
}

/** @param {Tx} tx @param {string} [actor] @param {string} [goalId] @returns {import("./model.d.ts").BacklogView} */
export function views(tx, actor, goalId) {
	const candidates = tx.list("squads");
	const jobItem = goalId ? tx.list("backlog_items", "WHERE goal_id=?", [goalId])[0] : undefined;
	const local = candidates.filter(squad => {
		const factory = tx.get("factory_controls", squad.factoryId);
		return (!actor || factory.owner === actor || tx.get("tasks", squad.taskId).owner === actor)
			&& (!goalId || squad.goalId === goalId || jobItem?.squad === squad.id);
	});
	const ids = new Set(local.map(squad => squad.factoryId));
	const squads = local.map(squad => {
		const task = tx.get("tasks", squad.taskId), factory = tx.get("factory_controls", squad.factoryId);
		const entries = ranked(tx, squad);
		const active = factory.state === "active" && !factory.pausedWorkers.includes(task.owner);
		const bound = task.currentAttemptId ? tx.get("attempts", task.currentAttemptId).nativeId === task.owner : false;
		const relevant = latest(tx, factory.id)?.outcomes.some(outcome => squad.outcomes.includes(outcome.id));
		const rules = contracts(record(factory.definition).requiredProducts).filter(rule => squad.templates.includes(rule.consumer));
		return { ...squad, owner: task.owner, bound, activation: factory.generation, active,
			requiredProducts: rules.map(rule => ({ ...rule, sources: tx.list("backlog_items", `${byFactory} AND json_extract(document,'$.template')=? AND state NOT IN ('proposal','retired')`, [factory.id, rule.producer])
				.map(item => ({ itemId: item.id, title: item.title, state: item.state, resultId: item.resultId })) })),
			pinned: factory.pin,
			knowledgeFiles: array(charter(factory, squad).knowledgeFiles ?? [], record),
			readyItems: entries.map(item => item.id), pullable: active && entries.length ? pullWindow(tx, factory).eligible.includes(entries[0].id) : false,
			needsDiscovery: Boolean(relevant && active && squad.generation > squad.handled),
			dispatch: Boolean(relevant && active && !bound && (task.state === "ready" || preparedDispatch(tx, task))) };
	});
	const mine = new Set(squads.map(squad => squad.id));
	return { directions: [...ids].map(id => latest(tx, id)).filter(value => value !== undefined), squads,
		items: tx.list("backlog_items").filter(item => mine.has(item.squad)) };
}
