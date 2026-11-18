import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assignmentPrompt, attemptToken } from "./prompt.mjs";
import { FoundryError, choice, decodeCandidate, digest, json, nativeSessionName, record, text } from "./values.mjs";
import { readCandidate, verifyCandidate } from "./artifacts.mjs";
import { workspaceFor } from "./surfaces.mjs";

/** @typedef {ReturnType<typeof import("./store.mjs").openWorkStore>} Store */
/** @typedef {import("./model.js").Attempt} Attempt */
/** @typedef {import("./model.js").Effect} Effect */
/** @typedef {import("./model.js").Evidence} Evidence */

/** @param {string} value @returns {string} */
export const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
/** @param {string} value @returns {string} */
export const toolName = value => value.split(".").at(-1) ?? value;
export const runner = fileURLToPath(new URL("./runner.mjs", import.meta.url));

/** @param {Store} store @param {string} effectId @returns {string} */
export const checkReceiptPath = (store, effectId) => path.join(path.dirname(store.databasePath), "evidence",
	`check-${createHash("sha256").update(effectId).digest("hex")}.json`);

/** @param {Store} store @param {string} taskId @param {string} actor @returns {import("./model.d.ts").DispatchCall} */
export function prepareDispatch(store, taskId, actor) {
	const attempt = store.prepareAttempt(taskId, actor);
	const prepared = store.effectsForAttempt(attempt.id).find(effect => effect.kind === "create" && effect.state === "prepared");
	if (prepared) return { taskId, attemptId: attempt.id, token: attempt.token, effectId: prepared.id,
		tool: "create_session", arguments: prepared.request };
	const task = store.getTask(taskId);
	const goal = store.getGoal(task.goalId);
	const snapshot = store.contextSnapshot(actor, goal.id, task.id);
	const source = task.dispatch;
	const baseBranch = attempt.startCommit ?? source?.baseBranch;
	const context = source?.generator ? source.context : [
		...snapshot.units.filter(unit => unit.id === task.unitId).flatMap(unit => unit.context),
		...snapshot.collaborations.filter(item => item.producerTaskId === task.id).map(item =>
			`Accepted collaboration ${item.id}: publish the named output "${item.output}" for consumer ${item.consumerTaskId}. Its ${item.required ? "required" : "optional"} delivery remains your accountable coordinator's commitment; publishing alone does not grant source-task mutation rights. Notify your coordinator to fulfill the actual immutable output.`),
		...snapshot.lessons.filter(lesson => lesson.workType === task.workType).map(lesson => lesson.summary),
		...(source?.context ?? []),
	];
	const arguments_ = json({
		name: nativeSessionName(`${task.title.slice(0, 30)} ${attempt.token.slice(0, 8)}`),
		...(goal.projectId === undefined ? {} : { project_id: goal.projectId }),
		workspace_type: workspaceFor(task, baseBranch),
		...(baseBranch === undefined ? {} : { base_branch: baseBranch }),
		coordinate_with_creator: true,
		notify_on_idle: "once",
		kickoff: { mode: task.scope.mode, prompt: assignmentPrompt(goal, task, attempt, context),
			...(source?.agent === undefined ? {} : { agent: source.agent }) },
	});
	const effect = store.recordEffect({
		id: `create:${attempt.id}`, attemptId: attempt.id, kind: "create", state: "prepared", request: arguments_,
	}, actor);
	return { taskId, attemptId: attempt.id, token: attempt.token, effectId: effect.id, tool: "create_session", arguments: arguments_ };
}

/** @param {Store} store @param {string} attemptId @param {string} checkId @param {string} directory @param {string} actor */
export function prepareCheck(store, attemptId, checkId, directory, actor) {
	const attempt = store.getAttempt(attemptId);
	const check = attempt.checks.find(item => item.id === checkId);
	if (!check || !check.command) throw new FoundryError("invalid_check", "This check has no assigned executable procedure");
	const effectId = `check:${randomUUID()}`;
	const command = ["node", runner, directory, attemptId, checkId, effectId].map(quote).join(" ");
	const effect = store.recordEffect({
		id: effectId, attemptId, kind: "command", state: "prepared",
		request: json({ command, shellId: effectId, checkId, checkVersion: check.version,
			receipt: checkReceiptPath(store, effectId) }),
	}, actor);
	return { effectId: effect.id, tool: "bash", arguments: {
		command, shellId: effectId, initial_wait: 120, description: `Evaluate ${check.id}`.slice(0, 100),
	} };
}
/** @param {Store} store @param {string} attemptId @param {string} command @param {string} actor */
export function prepareCommand(store, attemptId, command, actor) {
	const attempt = store.getAttempt(attemptId);
	if (attempt.nativeId !== actor || !attempt.slot || attempt.state !== "running") {
		throw new FoundryError("foreign_execution", "A command needs this caller's actually executing attempt");
	}
	const effectId = `command:${randomUUID()}`;
	store.recordEffect({ id: effectId, attemptId, kind: "command", state: "prepared", request: { command, shellId: effectId } }, actor);
	return { effectId, tool: "bash", arguments: { command, shellId: effectId, description: "Execute recorded work" } };
}
/** @param {Effect} effect @returns {unknown} */
export function effectShell(effect) {
	const result = effect.result === undefined ? undefined : record(effect.result);
	return record(effect.request).shellId ?? result?.shellId;
}

/** @param {Record<string, unknown>} event @returns {string|undefined} */
export function continuedShell(event) {
	const telemetry = record(event.toolTelemetry ?? {});
	const properties = record(telemetry.properties ?? {});
	if (event.success !== true || event.shellExecution !== undefined
		|| properties.shell_error_category !== "command_timeout" || properties.is_timeout !== "true") return;
	const shellId = record(telemetry.restrictedProperties ?? {}).shell_id;
	if (typeof shellId === "string" && shellId.length > 0) return shellId;
	// Older hosts omit the generated shell ID from telemetry, but append it to the native timeout result.
	const content = record(event.result ?? {}).content;
	if (typeof content !== "string") return;
	const footer = /(?:^|\n)<command with shellId: ([^<>\s]+) is still running after \d+ seconds\. The command is still running([^\n]*)>\n?$/.exec(content);
	if (!footer) return;
	const notice = " You will be automatically notified when it completes; if you need the command to complete end your response with no tool calls to wait for the notification";
	if (footer[2] === `.${notice}. Use stop_bash to stop it.`
		|| footer[2] === ` but hasn't produced output yet.${notice}, or use stop_bash to stop it.`) return footer[1];
}

/** @param {unknown} value @returns {Record<string, unknown> | undefined} */
export function nativeObject(value) {
	const envelope = record(value);
	if (envelope.structuredContent !== undefined) return record(envelope.structuredContent);
	if (typeof envelope.textResultForLlm === "string") {
		const content = envelope.textResultForLlm.trim();
		if (!content.startsWith("{")) return undefined;
		return record(/** @type {unknown} */ (JSON.parse(content)));
	}
	return envelope;
}

/** @param {Store} store @param {unknown} args @returns {Attempt|undefined} */
function creationAttempt(store, args) {
	const value = record(args);
	const kickoff = value.kickoff === undefined ? undefined : record(value.kickoff);
	if (!kickoff || typeof kickoff.prompt !== "string") return undefined;
	const token = attemptToken(kickoff.prompt);
	return token ? store.attemptByToken(token) : undefined;
}

/** @param {Store} store @param {string} name @param {unknown} args @param {string} actor @param {string|undefined} callId @returns {void} */
export function observePre(store, name, args, actor, callId) {
	if (["apply_patch", "edit", "create", "write_file", "str_replace_editor"].includes(toolName(name))) {
		store.assertCommandAdmission(actor);
		return;
	}
	if (!["create_session", "bash", "shell", "read_bash", "stop_bash"].includes(toolName(name))) return;
	const value = record(args);
	if (toolName(name) === "read_bash" || toolName(name) === "stop_bash") {
		if (typeof value.shellId !== "string" || !callId) return;
		const effects = store.pendingEffects().filter(effect => effect.kind === "command"
			&& effectShell(effect) === value.shellId && store.getAttempt(effect.attemptId).nativeId === actor);
		if (effects.length !== 1) return;
		const effect = effects[0];
		const previous = effect.result === undefined ? {} : record(effect.result);
		const calls = Array.isArray(previous.followUpCallIds) ? previous.followUpCallIds : [];
		store.recordEffect({ ...effect, result: json({ ...previous, followUpCallIds: [...new Set([...calls, callId])] }) }, actor);
		return;
	}
	if (toolName(name) === "create_session") {
		const attempt = creationAttempt(store, args);
		if (!attempt) return;
		const effect = store.getEffect(`create:${attempt.id}`);
		const { nativeToolCallId: previousCall, ...expected } = effect ? record(effect.request) : {};
		if (!effect || digest(json(args)) !== digest(json(expected))) {
			throw new FoundryError("assignment_changed", "Create the prepared complete assignment with its explicit mode and scope");
		}
		if (effect.result !== undefined && record(effect.result).neverIssued === true) {
			throw new FoundryError("creation_retired", "This definitely unissued creation is retired; read current context before reserving fresh work");
		}
		if (effect.state !== "prepared" && (!callId || previousCall !== callId)) {
			throw new FoundryError("creation_already_issued", "This attempt's creation was already issued; reconcile it without another create");
		}
		store.issueAttempt(attempt.id, actor, effect.id, json({ ...value, nativeToolCallId: callId ?? null }));
		return;
	}
	if (typeof value.command !== "string") return;
	const original = typeof value.shellId === "string" ? store.commandForShell(value.shellId, actor) : undefined;
	if (original?.state === "settled" && original.result !== undefined && record(original.result).neverIssued === true) {
		throw new FoundryError("command_retired", "This definitely unissued command is retired; reserve current work rather than replaying its old arguments");
	}
	const matches = store.pendingEffects().filter(item => item.kind === "command" && item.state === "prepared"
		&& record(item.request).command === value.command);
	const effect = matches.find(item => record(item.request).shellId === value.shellId);
	if (matches.length && !effect) throw new FoundryError("assignment_changed", "Use the prepared command's exact returned shell identity");
	if (effect) {
		if (effect.owner !== actor) throw new FoundryError("foreign_execution", "This prepared command belongs to another actual native worker");
		if (record(effect.request).shellId !== value.shellId) throw new FoundryError("assignment_changed", "Use the assigned command's returned shell identity");
		store.assertCommandAdmission(actor, effect.attemptId);
		store.recordEffect({ ...effect, state: "issued", request: json({ ...record(effect.request), nativeToolCallId: callId ?? null }) }, actor);
		return;
	}
	store.assertCommandAdmission(actor);
	const executing = store.executingAttempts(actor);
	if (executing.length) store.recordEffect({
		id: `command:${callId ?? randomUUID()}`, attemptId: executing[0].id, kind: "command", state: "issued",
		request: json({ ...value, nativeToolCallId: callId ?? null }),
		...(executing.length > 1 ? { relatedAttemptIds: executing.slice(1).map(attempt => attempt.id) } : {}),
	}, actor);
}

/** @param {Store} store @param {Attempt} attempt @param {unknown} result @param {string} actor @returns {Attempt} */
export function captureCreation(store, attempt, result, actor) {
	const value = nativeObject(result);
	const receipt = record(result);
	const effect = store.getEffect(`create:${attempt.id}`);
	const name = effect ? record(effect.request).name : undefined;
	const content = typeof receipt.textResultForLlm === "string" ? receipt.textResultForLlm : "";
	const prefix = `Created session '${typeof name === "string" ? nativeSessionName(name) : name}' (id: `;
	const printedId = content.startsWith(prefix)
		? content.slice(prefix.length).match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/u)?.[1] : undefined;
	const id = value?.project_session_id ?? value?.session_id ?? value?.id ?? printedId;
	if (typeof id !== "string" || !id) {
		store.recordEffect({
			id: `create:${attempt.id}`, attemptId: attempt.id, kind: "create", state: "uncertain",
			request: effect?.request ?? null,
			result: json(result),
		}, actor);
		throw new FoundryError("creation_identity_pending", "The native creation was issued; retain this attempt and reconcile its actual returned session identity without creating another child");
	}
	const current = store.getAttempt(attempt.id);
	if (current.nativeId === id) return current;
	const bound = store.bindAttempt(attempt.id, id, actor, json(result));
	return bound;
}

/** @param {Store} store @param {unknown} value @param {string} actor @returns {Attempt|undefined} */
export function reconcileDetail(store, value, actor) {
	const detail = nativeObject(value);
	if (!detail || typeof detail.id !== "string" || typeof detail.name !== "string") return;
	const attempt = store.attemptByCreationName(detail.name);
	if (!attempt) return;
	const goal = store.getGoal(store.getTask(attempt.taskId).goalId);
	if (detail.creator_session_id !== attempt.creator
		|| detail.coordinating_creator_session_id !== attempt.creator
		|| (goal.projectId !== undefined && detail.project_id !== goal.projectId)) {
		throw new FoundryError("native_identity_mismatch", "Actual native detail is not this attempt creator's coordinated child");
	}
	if (actor !== attempt.creator && actor !== detail.id && !store.ownsTask(attempt.taskId, actor)) {
		throw new FoundryError("foreign_native_observation", "Only the actual child or its accountable coordinator can reconcile this identity");
	}
	return store.bindAttempt(attempt.id, detail.id, actor === detail.id ? attempt.creator : actor, json(value));
}

/** @param {Store} store @param {string} reference */
function evidenceContent(store, reference) {
	const directory = path.join(path.dirname(store.databasePath), "evidence");
	const metadata = lstatSync(reference);
	if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
		|| path.dirname(realpathSync(reference)) !== realpathSync(directory)) {
		throw new FoundryError("invalid_evidence_reference", "Native evidence must be a contained regular artifact");
	}
	return readFileSync(reference, "utf8");
}

/** @param {Store} store @param {unknown} value @param {boolean} [verifyArtifacts] @returns {(Evidence & {effectId:string,completedAt:string})|undefined} */
export function checkObservation(store, value, verifyArtifacts = true) {
	const output = typeof value === "string" ? value : record(value).textResultForLlm;
	if (typeof output !== "string") return;
	const matches = [...output.matchAll(/FOUNDRY_CHECK_RESULT:([a-zA-Z0-9+/=]+)/gu)];
	const encoded = matches.at(-1)?.[1];
	if (!encoded) return;
	const observation = record(/** @type {unknown} */ (JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))));
	const reference = text(observation.reference, "native evidence reference");
	const content = evidenceContent(store, reference);
	if (createHash("sha256").update(content).digest("hex") !== observation.sha256) throw new FoundryError("evidence_changed", "Native evidence content no longer matches the captured observation");
	const receipt = record(/** @type {unknown} */ (JSON.parse(content)));
	if (receipt.state !== "finished") throw new FoundryError("unsupported_receipt", "Check evidence requires a finished receipt-bound runner result");
	const { state: _state, sha256: _sha, ...raw } = receipt;
	if (digest(json(raw)) !== receipt.sha256) {
		throw new FoundryError("evidence_changed", "Finished runner receipt content changed");
	}
	const effectId = text(raw.effectId, "native check effect");
	if (observation.effectId !== effectId) throw new FoundryError("effect_mismatch", "Native check correlation changed");
	if (record(store.getEffect(effectId).request).receipt !== reference) {
		throw new FoundryError("effect_mismatch", "Runner receipt is not the issued command's recorded file");
	}
	const attemptId = text(observation.attemptId, "evidence attempt");
	const attempt = store.getAttempt(attemptId);
	const check = attempt.checks.find(item => item.id === observation.checkId);
	const request = record(store.getEffect(effectId).request);
	if (!check || check.version !== observation.checkVersion || raw.command !== check.command || raw.oracleCommit !== check.oracleCommit
		|| raw.attemptId !== attemptId || raw.checkId !== check.id || raw.checkVersion !== check.version
		|| request.checkId !== check.id || request.checkVersion !== check.version) {
		throw new FoundryError("evaluator_mismatch", "Captured evidence is not for the assigned evaluator snapshot");
	}
	const passed = raw.exitCode === 0 && raw.error === null;
	if ((raw.inputs !== undefined || check.artifactFiles) && digest(json(raw.inputs)) !== digest(json(attempt.inputs))) {
		throw new FoundryError("input_identity_mismatch", "Captured evidence changed its assigned versioned inputs");
	}
	if (passed && (raw.inputOutputs !== undefined || check.artifactFiles)) {
		const inputs = attempt.inputs.map(input => ({ taskId: input.taskId, output: store.outputForInput(input) }));
		if (digest(json(raw.inputOutputs)) !== digest(json(inputs))) throw new FoundryError("input_identity_mismatch", "Captured evidence does not identify the actual pinned deliveries");
		if (verifyArtifacts) for (const input of inputs) if (input.output) readCandidate(input.output.reference, input.output.version, store.databasePath);
	}
	const candidate = raw.candidate === undefined ? undefined : decodeCandidate(raw.candidate);
	if (passed && check.artifactFiles) {
		if (!candidate || digest(json(candidate.files.map(file => file.path).sort())) !== digest(json(check.artifactFiles))) {
			throw new FoundryError("candidate_not_evaluated", "Passed evidence must identify its exact declared candidate files");
		}
		if (verifyArtifacts) verifyCandidate(candidate, store.databasePath);
	}
	if (observation.outcome !== (passed ? "passed" : "failed")) throw new FoundryError("invalid_evidence_outcome", "Evidence outcome contradicts its raw native result");
	return {
		id: `evidence:${observation.sha256}`, attemptId, checkId: check.id, checkVersion: check.version, effectId,
		completedAt: text(raw.completedAt, "native completion time"),
		outcome: passed ? "passed" : "failed", reference, summary: text(observation.summary, "evidence summary"),
		source: "runner-receipt",
		...(candidate === undefined ? {} : { candidate }),
		...(raw.blocker === undefined || raw.blocker === null ? {} : {
			blocker: choice(raw.blocker, /** @type {const} */ (["input-artifact", "oracle-input"]), "native input blocker"),
		}),
	};
}

/** @param {Store} store @param {string} actor @param {(effect:Effect)=>void} [settled] @param {string} [goalId] @returns {void} */
export function recoverChecks(store, actor, settled, goalId) {
	for (const effect of store.pendingEffects()) {
		if (effect.kind !== "command" || !["issued", "uncertain"].includes(effect.state)
			|| store.getAttempt(effect.attemptId).nativeId !== actor
			|| (goalId !== undefined && store.getTask(store.getAttempt(effect.attemptId).taskId).goalId !== goalId)) continue;
		const reference = record(effect.request).receipt;
		if (typeof reference !== "string" || reference !== checkReceiptPath(store, effect.id) || !existsSync(reference)) continue;
		const content = evidenceContent(store, reference);
		const receipt = record(/** @type {unknown} */ (JSON.parse(content)));
		if (receipt.state === "started") continue;
		if (receipt.state !== "finished") throw new FoundryError("invalid_receipt", "Expected a started or finished runner receipt");
		const { state: _state, sha256: _sha, ...raw } = receipt;
		const observation = {
			effectId: effect.id, attemptId: effect.attemptId, checkId: raw.checkId, checkVersion: raw.checkVersion,
			outcome: raw.exitCode === 0 && raw.error === null ? "passed" : "failed",
			reference, sha256: createHash("sha256").update(content).digest("hex"),
			summary: typeof raw.error === "string" ? raw.error : `Assigned command exited ${raw.exitCode ?? raw.signal}`,
		};
		const evidence = checkObservation(store, {
			textResultForLlm: `FOUNDRY_CHECK_RESULT:${Buffer.from(JSON.stringify(observation)).toString("base64")}`,
		});
		if (!evidence) throw new FoundryError("invalid_receipt", "Finished runner receipt did not yield assigned evidence");
		const completed = store.recordEffect({ ...effect, state: "settled",
			result: json({ ...(effect.result === undefined ? {} : record(effect.result)), runnerReceipt: observation, evidence }) }, actor);
		settled?.(completed);
	}
}

/** @param {Store} store @param {string} name @param {unknown} args @param {unknown} result @param {string} actor @param {(effect:Effect)=>void} [settled] */
export function observePost(store, name, args, result, actor, settled) {
	if (!["create_session", "get_session", "bash", "shell", "read_bash", "stop_bash"].includes(toolName(name))) return;
	if (toolName(name) === "create_session") {
		const attempt = creationAttempt(store, args);
		return attempt ? captureCreation(store, attempt, result, actor) : undefined;
	}
	if (toolName(name) === "get_session") return reconcileDetail(store, result, actor);
	if (toolName(name) === "stop_bash") {
		const shellId = record(args).shellId;
		const receipt = record(result);
		const telemetry = receipt.toolTelemetry === undefined ? undefined : record(receipt.toolTelemetry);
		const properties = telemetry?.properties === undefined ? undefined : record(telemetry.properties);
		if (typeof shellId !== "string" || receipt.resultType !== "success" || properties?.shell_status !== "stopped"
			|| receipt.textResultForLlm !== `<command with id: ${shellId} stopped>`) return;
		const effects = store.pendingEffects().filter(effect => effect.kind === "command"
			&& effectShell(effect) === shellId && store.getAttempt(effect.attemptId).nativeId === actor);
		if (effects.length !== 1) return;
		const effect = effects[0];
		const observation = store.recordEffect({ ...effect, state: "settled",
			result: json({ ...(effect.result === undefined ? {} : record(effect.result)), nativeTermination: receipt, stopped: true }) }, actor);
		settled?.(observation);
		return observation;
	}
	const value = record(args);
	const effect = (typeof value.shellId === "string" ? store.commandForShell(value.shellId, actor) : undefined)
		?? store.pendingEffects().find(item => item.kind === "command" && typeof record(item.request).checkId === "string"
			&& record(item.request).command === value.command);
	if (!effect || effect.kind !== "command" || typeof record(effect.request).checkId !== "string") return;
	if (toolName(name) !== "read_bash" && value.command !== record(effect.request).command) return;
	if (store.getAttempt(effect.attemptId).nativeId !== actor
		|| value.shellId !== effectShell(effect)) {
		throw new FoundryError("foreign_execution", "Check output must come from its actual worker and assigned shell");
	}
	const observation = checkObservation(store, result);
	if (!observation) return;
	if (observation.effectId !== effect.id || observation.attemptId !== effect.attemptId) {
		throw new FoundryError("effect_mismatch", "Native check output belongs to another assigned command");
	}
	if (effect.state === "settled") {
		const previousResult = record(effect.result);
		const previous = previousResult.runnerReceipt !== undefined || previousResult.nativeResult === undefined ? record(previousResult.evidence)
			: checkObservation(store, previousResult.nativeResult, false);
		if (!previous || digest(json(previous)) !== digest(json(observation))) {
			throw new FoundryError("evidence_conflict", "The settled command has a different native observation");
		}
		return previous;
	}
	if (!["issued", "uncertain"].includes(effect.state)) throw new FoundryError("unissued_check", "This native command was not issued");
	const completed = store.recordEffect({ ...effect, state: "settled", result: json({ nativeResult: result, evidence: observation }) }, actor);
	settled?.(completed);
	return observation;
}

/** @param {Store} store @param {string} attemptId @returns {Evidence[]} */
export function admittedEvidence(store, attemptId) {
	/** @type {Map<string, Effect>} */
	const sources = new Map();
	for (const effect of store.effectsForAttempt(attemptId).filter(effect => effect.kind === "command" && effect.state === "settled")) {
		const value = record(effect.result);
		for (const item of Array.isArray(value.evidence) ? value.evidence : value.evidence === undefined ? [] : [value.evidence]) {
			sources.set(text(record(item).id, "admitted observation"), effect);
		}
	}
	return store.evidenceForAttempt(attemptId).map(admitted => {
		const effect = sources.get(admitted.id);
		if (!effect) throw new FoundryError("evidence_source_missing", "Admitted evidence has no original settled native effect");
		const value = record(effect.result);
		const result = value.runnerReceipt === undefined ? value.nativeResult : {
			textResultForLlm: `FOUNDRY_CHECK_RESULT:${Buffer.from(JSON.stringify(value.runnerReceipt)).toString("base64")}`,
		};
		const observation = result === undefined ? undefined : checkObservation(store, result, false);
		if (!observation || observation.effectId !== effect.id) {
			throw new FoundryError("evidence_source_missing", "Admitted evidence must retain its original native receipt");
		}
		const { effectId: _effect, completedAt: _time, ...original } = observation;
		if (digest(json(original)) !== digest(json(admitted))) {
			throw new FoundryError("evidence_conflict", "Admitted evidence changed from its original native observation");
		}
		return admitted;
	});
}

/** @param {Store} store @param {unknown} value @param {string} actor @param {(effect:Effect)=>void} [settled] @param {{effectId:string, receipt:import("./model.js").Json, shellId?:string}} [recovery] @returns {Effect|undefined} */
export function observeCompletion(store, value, actor, settled, recovery) {
	const event = record(value);
	if (typeof event.toolCallId !== "string") return;
	const error = event.error === undefined ? undefined : record(event.error);
	const nativeTelemetry = event.toolTelemetry ?? error?.toolTelemetry;
	const telemetry = nativeTelemetry === undefined ? undefined : record(nativeTelemetry);
	const properties = telemetry?.properties === undefined ? undefined : record(telemetry.properties);
	const identifiers = telemetry?.restrictedProperties === undefined ? undefined : record(telemetry.restrictedProperties);
	const reportedShell = typeof identifiers?.shell_id === "string" ? identifiers.shell_id : undefined;
	let effect = recovery ? store.getEffect(recovery.effectId) : store.effectByNativeCall(event.toolCallId);
	const originalCall = effect && record(effect.request).nativeToolCallId === event.toolCallId;
	const returnedShell = reportedShell ?? recovery?.shellId ?? (originalCall ? continuedShell(event) : undefined);
	if (returnedShell !== undefined) {
		const expectedShell = effect && effectShell(effect);
		if (expectedShell !== undefined && expectedShell !== returnedShell) return;
		if (recovery?.shellId !== undefined && recovery.shellId !== returnedShell) return;
	}
	if (!effect && reportedShell !== undefined && !recovery) {
		const matching = store.pendingEffects().filter(candidate => candidate.kind === "command" && effectShell(candidate) === returnedShell
			&& store.getAttempt(candidate.attemptId).nativeId === actor);
		if (matching.length === 1) effect = matching[0];
	}

	if (effect && effect.kind !== "command") return;
	if (!effect || effect.state === "settled") return;
	if (store.getAttempt(effect.attemptId).nativeId !== actor) throw new FoundryError("foreign_execution", "Only this native command's actual worker can settle it");
	const result = event.result === undefined ? undefined : record(event.result);
	const nativeResult = { resultType: event.success ? "success" : "failure", textResultForLlm: typeof result?.content === "string" ? result.content : "" };
	const assigned = typeof record(effect.request).checkId === "string";
	const evidence = assigned ? checkObservation(store, nativeResult) : undefined;
	if (evidence && evidence.effectId !== effect.id) {
		throw new FoundryError("effect_mismatch", "Native completion belongs to another check operation");
	}
	const shell = event.shellExecution === undefined ? undefined : record(event.shellExecution);
	const stopped = properties?.shell_error_category === "shell_stopped" && properties.shell_operation === "read"
		&& properties.read_target_state === "stopped" && identifiers?.shell_id === effectShell(effect)
		&& store.getAttempt(effect.attemptId).nativeId === actor;
	const state = stopped || evidence || (typeof shell?.exitCode === "number" && (!assigned || shell.exitCode !== 0)) ? "settled" : "uncertain";
	const observation = store.recordEffect({
		...effect, state,
		result: json({ ...(effect.result === undefined ? {} : record(effect.result)), nativeCompletion: event, nativeResult,
			...(recovery === undefined ? {} : { nativeRecovery: recovery.receipt }),
			...(returnedShell === undefined ? {} : { shellId: returnedShell }),
			...(stopped ? { stopped: true } : {}), ...(evidence ? { evidence } : {}) }),
	}, actor);
	if (state === "settled") settled?.(observation);
	return observation;
}

/** @param {Store} store @param {unknown} value @param {string} actor @param {(effect:Effect)=>void} [settled] @returns {Effect|undefined} */
export function observeRefusal(store, value, actor, settled) {
	const receipt = record(value);
	if (!["denied", "rejected"].includes(String(receipt.status)) || receipt.exitCode !== undefined
		|| typeof receipt.toolCallId !== "string") return;
	const effect = store.effectByNativeCall(receipt.toolCallId);
	if (!effect || effect.state === "settled" || record(effect.request).nativeToolCallId !== receipt.toolCallId) return;
	const previous = effect.result === undefined ? {} : record(effect.result);
	const completion = previous.nativeCompletion === undefined ? {} : record(previous.nativeCompletion);
	if (previous.shellId !== undefined || previous.runnerReceipt !== undefined || previous.evidence !== undefined
		|| completion.shellExecution !== undefined) return;
	if (effect.kind === "create") {
		const observation = store.rejectCreation(effect.id, actor, json(receipt));
		settled?.(observation);
		return observation;
	}
	if (effect.kind !== "command" || store.getAttempt(effect.attemptId).nativeId !== actor) return;
	const observation = store.recordEffect({ ...effect, state: "settled",
		result: json({ ...previous, neverIssued: true, nativeRefusal: receipt }) }, actor);
	settled?.(observation);
	return observation;
}
