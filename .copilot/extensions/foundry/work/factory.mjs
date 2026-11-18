import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { deliveryPolicy } from "./landing.mjs";
import { compileCheck, compileDefinition } from "./compiler.mjs";
import { decodeDirection } from "./direction.mjs";
import { contracts, validateContracts } from "./lineage.mjs";
import { FoundryError, array, choice, closedFields, decodeLimits, decodeScope, digest, json, narrowScope, natural, positive, record, resourcePath, strings, text } from "./values.mjs";

/** @param {Record<string,unknown>} definition @param {"native"|"stop-hook"} mechanism
 * @returns {{maximumJobs:number,blocks?:number,settingOrigins:NonNullable<import("./model.d.ts").FactoryControl["settingOrigins"]>}} */
function resolveFactorySettings(definition, mechanism) {
	const maximumJobs = definition.maximumJobs === undefined ? 1 : positive(definition.maximumJobs, "maximum concurrent jobs");
	if (maximumJobs > 1 && definition.source === undefined && definition.direction === undefined) {
		throw new FoundryError("factory_capacity_scope", "maximumJobs above 1 requires multi-job source intake; leads and subtasks execute in parallel within one job");
	}
	if (mechanism === "native" && definition.blocks !== undefined) {
		throw new FoundryError("continuation_setting_conflict", "blocks applies only to stop-hook continuation; omit it for native factories");
	}
	return {
		maximumJobs,
		...(mechanism === "native" ? {} : { blocks: definition.blocks === undefined ? 3 : positive(definition.blocks, "stop-hook continuation blocks") }),
		settingOrigins: {
			maximumJobs: definition.maximumJobs === undefined ? "default" : "policy",
			...(mechanism === "native" ? {} : { blocks: definition.blocks === undefined ? "default" : "policy" }),
		},
	};
}

/** @param {import("./model.d.ts").FactoryControl} factory */
export function factorySettings(factory) {
	const limits = decodeLimits(record(record(factory.definition).goal).limits ?? {});
	return {
		maximumJobs: { value: factory.maximumJobs, origin: factory.settingOrigins?.maximumJobs ?? "unrecorded" },
		...(factory.mechanism === "native" ? {} : { blocks: {
			value: positive(factory.blocks, "stop-hook continuation blocks"), origin: factory.settingOrigins?.blocks ?? "unrecorded",
		} }),
		perJobLimits: Object.fromEntries(Object.entries(limits).map(([name, value]) => [name, { value, origin: "policy" }])),
	};
}

/** @param {Record<string, unknown>} input @param {string[]} fields */
function closed(input, fields) {
	closedFields(input, fields, "factory");
}

/** @param {string} directory @param {string} filename */
export function readFactory(directory, filename) {
	const root = realpathSync(directory);
	const resolved = realpathSync(path.resolve(root, filename));
	const relative = path.relative(root, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative) || !relative.startsWith(`.foundry${path.sep}`)) {
		throw new FoundryError("factory_scope", "Factory definitions must be repository-owned .foundry files");
	}
	const content = readFileSync(resolved, "utf8");
	const definition = record(/** @type {unknown} */ (JSON.parse(content)));
	closed(definition, ["format", "version", "id", "mechanism", "maximumJobs", "blocks", "unchangedFailures",
		"aggregateRepairs", "completionTaskId", "goal", "source", "charters", "grains", "direction", "delivery", "requiredProducts"]);
	if (definition.format !== "foundry-factory" || definition.version !== 2) {
		throw new FoundryError("unsupported_factory", "Expected a foundry-factory version 2 definition");
	}
	const goal = record(definition.goal);
	if (definition.delivery !== undefined) deliveryPolicy(definition.delivery);
	const direction = definition.direction === undefined ? undefined : decodeDirection(definition.direction);
	if (direction && !decodeScope(goal.scope).delegation) throw new FoundryError("delegation_forbidden", "Squad discovery requires scoped delegation");
	const mechanism = choice(definition.mechanism, ["native", "stop-hook"], "continuation mechanism");
	if (record(goal.scope).mode !== (mechanism === "native" ? "autopilot" : "interactive")) {
		throw new FoundryError("continuation_conflict", "Native continuation requires autopilot workers; exclusive stop-hook continuation requires interactive workers");
	}
	const source = definition.source === undefined ? undefined : record(definition.source);
	if (source) {
		closed(source, ["kind", "repository", "actors", "maximumEvents"]);
		if (source.kind !== "github-issue") throw new FoundryError("unsupported_source", "Only verified GitHub issue ingress is supported");
		if (!/^[\w.-]+\/[\w.-]+$/u.test(text(source.repository, "source repository")) || !strings(source.actors).length) {
			throw new FoundryError("invalid_source", "A source needs an owner/repository and trusted actor logins");
		}
		if (source.maximumEvents !== undefined && positive(source.maximumEvents, "events per intake page") > 100) {
			throw new FoundryError("source_page_limit", "GitHub issue pages support at most 100 events per observation");
		}
	}
	const settings = resolveFactorySettings(definition, mechanism);
	const tasks = array(goal.tasks, record);
	const ids = new Set(tasks.map(task => text(task.id, "template task id")));
	if (ids.size !== tasks.length) throw new FoundryError("duplicate_template", "Factory task template identities must be unique");
	/** @type {Record<string,{sha256:string,content:string}>} */
	const captured = {};
	/** @param {unknown} value */
	const capture = value => {
		const input = record(value);
		closed(input, ["path", "sha256"]);
		const name = resourcePath(input.path);
		const filename = realpathSync(path.resolve(root, name));
		const relative = path.relative(root, filename);
		if (path.isAbsolute(relative) || relative.startsWith("..") || relative.split(path.sep)[0] === ".git") {
			throw new FoundryError("source_scope", "Captured source artifacts must stay within the repository outside .git");
		}
		const bytes = readFileSync(filename);
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		if (sha256 !== text(input.sha256, "source hash")) throw new FoundryError("source_hash_mismatch", `Source artifact changed: ${name}`);
		captured[name] = { sha256, content: bytes.toString("utf8") };
		return { path: name, sha256 };
	};
	const charters = array(definition.charters ?? [], value => {
		const charter = record(value);
		closed(charter, ["name", "taskIds", "agent", "context", "knowledgeFiles", ...(direction ? ["outcomes", "scope", "discoveryLimit"] : [])]);
		const taskIds = strings(charter.taskIds);
		if (taskIds.some(id => !ids.has(id))) throw new FoundryError("unknown_template", "Charters must reference actual task templates");
		const outcomes = strings(charter.outcomes ?? []);
		// Subscriptions are durable. A later direction may suspend an outcome
		// without modifying charter authority or waking its dormant lead.
		const scope = outcomes.length ? narrowScope(decodeScope(goal.scope), record(charter.scope)) : undefined;
		if (scope && (!scope.paths.length || !scope.workTypes.length || !taskIds.length)) throw new FoundryError("empty_charter", "Subscriptions require a scope and checked producer templates");
		for (const task of tasks.filter(task => scope && taskIds.includes(text(task.id, "template")))) {
			const checks = array(task.checks ?? [], compileCheck);
			const boundary = narrowScope(scope ?? decodeScope(goal.scope), task.scope);
			if (task.role === "coordinator" || task.parentId !== undefined || array(task.inputs ?? [], record).length
				|| !checks.length || checks.some(check => check.origin === "derived" || !check.artifactFiles?.length)
				|| !(boundary.workTypes.includes("*") || boundary.workTypes.includes(text(task.workType, "work type")))) {
				throw new FoundryError("invalid_template", "A discovery template is an independent producer with protected artifact-bound checks inside its charter");
			}
		}
		return { name: text(charter.name, "charter name"), taskIds, context: strings(charter.context),
			...(scope ? { outcomes, scope, discoveryLimit: natural(charter.discoveryLimit, "bounded questions per revision") } : {}),
			knowledgeFiles: array(charter.knowledgeFiles ?? [], capture),
			...(charter.agent === undefined ? {} : { agent: text(charter.agent, "native agent reference") }) };
	});
	if (direction && (!charters.some(charter => charter.outcomes?.length) || new Set(charters.map(charter => charter.name)).size !== charters.length)) {
		throw new FoundryError("invalid_charter", "Direction requires distinct charters and at least one outcome subscription");
	}
	if (direction) compileDefinition(goal);
	if (definition.requiredProducts !== undefined) {
		if (!direction || source) throw new FoundryError("invalid_product_contract", "Product lineage requires charter-bound item admission, not source-template ingress");
		validateContracts(contracts(definition.requiredProducts), new Set(charters.filter(charter => charter.outcomes?.length).flatMap(charter => charter.taskIds)));
	}
	const grains = array(definition.grains ?? [], value => {
		const grain = record(value);
		closed(grain, ["id", "taskIds", "generators", "baseBranch", "specification", "evaluators", "boundary", "context"]);
		const taskIds = strings(grain.taskIds);
		const generators = strings(grain.generators);
		if (taskIds.some(id => !ids.has(id)) || generators.some(id => !taskIds.includes(id))) {
			throw new FoundryError("unknown_template", "Grain and generator references must identify actual task templates");
		}
		if (!Array.isArray(grain.evaluators) || !grain.evaluators.length || !Array.isArray(grain.boundary) || !grain.boundary.length) {
			throw new FoundryError("grain_contract_incomplete", "A grain requires independent evaluators and a conserved boundary");
		}
		const baseReference = text(grain.baseBranch, "explicit implementation-free base ref");
		const baseBranch = execFileSync("git", ["-C", root, "rev-parse", "--verify", "--end-of-options", `${baseReference}^{commit}`], { encoding: "utf8" }).trim();
		const specification = capture(grain.specification);
		const evaluators = array(grain.evaluators, capture);
		const boundary = array(grain.boundary, capture);
		for (const file of [specification, ...evaluators, ...boundary]) {
			const bytes = execFileSync("git", ["-C", root, "show", `${baseBranch}:${file.path}`]);
			if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
				throw new FoundryError("grain_base_mismatch", `The implementation-free base does not conserve declared ${file.path}`);
			}
		}
		return { id: text(grain.id, "grain id"), taskIds, generators, baseReference, baseBranch,
			specification, evaluators, boundary, context: strings(grain.context) };
	});
	for (const id of ids) {
		if (grains.filter(grain => grain.taskIds.includes(id)).length > 1
			|| new Set(charters.filter(charter => charter.taskIds.includes(id)).flatMap(charter => charter.agent === undefined ? [] : [charter.agent])).size > 1) {
			throw new FoundryError("ambiguous_template_context", "Each task must have one grain and at most one distinct declared native agent");
		}
	}
	const snapshot = json({ ...definition, ...settings, charters, grains, captured });
	return { definition: snapshot, goal, ...(direction && !source ? {} : { completionTaskId: text(definition.completionTaskId, "completion task") }),
		source: { reference: relative, sha256: createHash("sha256").update(content).digest("hex") },
		control: {
			id: text(definition.id, "factory id"), mechanism, ...settings,
			...(definition.unchangedFailures === undefined ? {} : { unchangedFailures: positive(definition.unchangedFailures, "unchanged failures") }),
			...(definition.aggregateRepairs === undefined ? {} : { aggregateRepairs: natural(definition.aggregateRepairs, "aggregate repairs") }),
		},
	};
}

/** @param {Record<string,unknown>} policy @param {string} templateId @param {unknown} checks */
export function templateChecks(policy, templateId, checks) {
	const grain = array(policy.grains ?? [], record).find(grain => strings(grain.taskIds).includes(templateId));
	const conserved = grain ? [record(grain.specification), ...array(grain.evaluators, record), ...array(grain.boundary, record)] : [];
	return array(checks, compileCheck).map(check => {
		if (!conserved.length) return check;
		const { version: _version, ...definition } = check;
		const files = new Map();
		for (const file of [...(check.oracleFiles ?? []), ...conserved]) {
			const name = text(file.path, "conserved input");
			if (files.has(name) && files.get(name).sha256 !== file.sha256) throw new FoundryError("oracle_conflict", `Conserved oracle ${name} has conflicting pinned versions`);
			files.set(name, file);
		}
		return compileCheck({ ...definition, oracleFiles: [...files.values()] });
	});
}

/** @param {import("./model.d.ts").Json} definition @param {{reference:string,sha256:string}} source @param {string} [templateId] @returns {NonNullable<import("./model.d.ts").Task["dispatch"]>} */
export function compileFactoryContext(definition, source, templateId) {
	const policy = record(definition);
	const matches = (/** @type {unknown} */ ids) => templateId !== undefined && strings(ids).includes(templateId);
	const charters = array(policy.charters ?? [], record).filter(charter => matches(charter.taskIds));
	const grain = array(policy.grains ?? [], record).find(grain => matches(grain.taskIds));
	const generator = grain !== undefined && matches(grain.generators);
	const captured = record(policy.captured ?? {});
	const files = generator && grain ? [record(grain.specification)] : charters.flatMap(charter => array(charter.knowledgeFiles ?? [], record));
	const agent = charters.find(charter => charter.agent !== undefined)?.agent;
	return {
		context: [
			`Factory ${text(policy.id, "factory id")}; source ${source.reference}; snapshot ${digest(definition)}.`,
			...(generator && grain ? strings(grain.context) : charters.flatMap(charter => strings(charter.context))),
			...files.map(file => {
				const name = text(file.path, "context file");
				const content = record(captured[name]);
				if (typeof content.content !== "string") throw new FoundryError("invalid_field", "Captured context must be text");
				return `Declared context ${name} (${text(content.sha256, "context version")}):\n${content.content}`;
			}),
		],
		generator,
		...(generator && grain ? { baseBranch: text(grain.baseBranch, "generation base ref") } : {}),
		...(!generator && agent !== undefined ? { agent: text(agent, "native agent") } : {}),
	};
}
