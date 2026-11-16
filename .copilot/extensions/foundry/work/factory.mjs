import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { FoundryError, array, choice, closedFields, decodeInput, decodeSource, digest, json, natural, positive, record, resourcePath, strings, text } from "./values.mjs";

/** @param {unknown} value @returns {import("./model.d.ts").FactoryControl} */
export function decodeFactory(value) {
	const row = record(value);
	const mechanism = choice(row.mechanism, ["native", "stop-hook"], "continuation mechanism");
	const heartbeat = row.heartbeat === undefined ? undefined : record(row.heartbeat);
	const request = heartbeat === undefined ? undefined : record(heartbeat.request);
	const reminders = Object.fromEntries(Object.entries(record(row.reminders)).map(([id, value]) => {
		const reminder = record(value);
		return [id, { marker: text(reminder.marker, "progress marker"), count: natural(reminder.count, "reminder count"),
			generation: natural(reminder.generation, "reminder generation") }];
	}));
	return {
		id: text(row.id, "factory id"), owner: text(row.owner, "factory owner"),
		state: choice(row.state, ["active", "paused"], "factory state"),
		generation: positive(row.generation, "activation generation"),
		mechanism,
		source: decodeSource(row.source), definition: json(row.definition),
		maximumJobs: positive(row.maximumJobs, "maximum concurrent jobs"),
		...(row.blocks === undefined && mechanism === "native" ? {} : { blocks: positive(row.blocks, "stop-hook continuation blocks") }),
		pausedWorkers: strings(row.pausedWorkers), reminders,
		...(row.unchangedFailures === undefined ? {} : { unchangedFailures: positive(row.unchangedFailures, "unchanged failures") }),
		...(row.aggregateRepairs === undefined ? {} : { aggregateRepairs: natural(row.aggregateRepairs, "aggregate repairs") }),
		...(heartbeat === undefined || request === undefined ? {} : { heartbeat: {
			state: choice(heartbeat.state, ["issued", "bound", "uncertain"], "heartbeat state"),
			generation: positive(heartbeat.generation, "heartbeat generation"),
			request: { interval: choice(request.interval, ["minutes"], "heartbeat cadence"),
				every_minutes: positive(request.every_minutes, "heartbeat minutes"), prompt: text(request.prompt, "heartbeat prompt") },
			...(heartbeat.id === undefined ? {} : { id: text(heartbeat.id, "native heartbeat identity") }),
			...(heartbeat.receipt === undefined ? {} : { receipt: json(heartbeat.receipt) }),
		} }),
		...(row.sourceCursor === undefined ? {} : { sourceCursor: text(row.sourceCursor, "native source cursor") }),
		...(row.reason === undefined ? {} : { reason: text(row.reason, "pause reason") }),
	};
}

/** @param {unknown} value @returns {import("./model.d.ts").GoalCompletion} */
export function decodeCompletion(value) {
	const row = record(value);
	if (typeof row.closed !== "boolean") throw new FoundryError("invalid_field", "Completion closure must be boolean");
	const accepted = row.accepted === undefined ? undefined : record(row.accepted);
	return {
		id: text(row.id, "completion id"), goalId: text(row.goalId, "completion goal"), owner: text(row.owner, "completion owner"),
		taskId: text(row.taskId, "completion task"), factoryId: text(row.factoryId, "completion factory"),
		revision: positive(row.revision, "closure revision"), closed: row.closed,
		requiredInputs: array(row.requiredInputs, decodeInput), repairs: natural(row.repairs, "aggregate repairs"),
		...(accepted === undefined ? {} : { accepted: {
			revision: positive(accepted.revision, "accepted closure"),
			tasks: array(accepted.tasks, value => {
				const item = record(value);
				return { id: text(item.id, "required task"), version: positive(item.version, "required version"),
					inputs: array(item.inputs, decodeInput) };
			}),
		} }),
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
		"aggregateRepairs", "completionTaskId", "goal", "source", "charters", "grains"]);
	if (definition.format !== "foundry-factory" || definition.version !== 1) {
		throw new FoundryError("unsupported_factory", "Expected a foundry-factory version 1 definition");
	}
	const goal = record(definition.goal);
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
		closed(charter, ["name", "taskIds", "agent", "context", "knowledgeFiles"]);
		const taskIds = strings(charter.taskIds);
		if (taskIds.some(id => !ids.has(id))) throw new FoundryError("unknown_template", "Charters must reference actual task templates");
		return { name: text(charter.name, "charter name"), taskIds, context: strings(charter.context),
			knowledgeFiles: array(charter.knowledgeFiles ?? [], capture),
			...(charter.agent === undefined ? {} : { agent: text(charter.agent, "native agent reference") }) };
	});
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
	const snapshot = json({ ...definition, charters, grains, captured });
	return { definition: snapshot, goal, completionTaskId: text(definition.completionTaskId, "completion task"),
		source: { reference: relative, sha256: createHash("sha256").update(content).digest("hex") },
		control: {
			id: text(definition.id, "factory id"), mechanism, maximumJobs: positive(definition.maximumJobs, "maximum concurrent jobs"),
			...(definition.blocks === undefined && mechanism === "native" ? {} : { blocks: positive(definition.blocks, "stop-hook continuation blocks") }),
			...(definition.unchangedFailures === undefined ? {} : { unchangedFailures: positive(definition.unchangedFailures, "unchanged failures") }),
			...(definition.aggregateRepairs === undefined ? {} : { aggregateRepairs: natural(definition.aggregateRepairs, "aggregate repairs") }),
		},
	};
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
