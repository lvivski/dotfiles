import path from "node:path";
import { readBoolean, readJsonValue } from "../data.mjs";
import { stableStringify } from "../digest.mjs";
import { fail, list, object, text, timestamp } from "../factory/fields.mjs";
import { assertInputCoverage, attemptIdentity, commitId, packageInput, reservedInputs } from "../plan/parallel-contracts.mjs";
import { DispatchNativeError } from "./admission.mjs";

/** @typedef {import("../types/parallel.js").AttemptIdentity} Attempt */
/** @typedef {import("../types/json.js").JsonValue} Json */
/** @typedef {ReturnType<typeof dispatchReservation>} Reservation */
/** @typedef {ReturnType<typeof createdChild>} Child */
/** @typedef {import("./admission.mjs").NativeResult} NativeResult */

/** Closed prepared handoff supplied by T-003/T-007, never accepted from imported history.
 * The resolver seals the descriptor into the prompt before reservation delivery; dispatch
 * forwards that prompt, rather than appending content after the reserved digest is pinned.
 * @param {unknown} value */
export function dispatchReservation(value) {
	object(value, ["attempt", "projectId", "baseBranch", "baseCommit", "initialization", "delegationPrompt", "inputs", "requiredInputs"], "dispatch reservation");
	const attempt = attemptIdentity(value.attempt);
	const baseBranch = text(value.baseBranch, "reserved base", 512), baseCommit = commitId(value.baseCommit);
	object(value.initialization, ["acknowledgement", "kickoff"], "setup initialization");
	object(value.initialization.kickoff, ["prompt", "mode"], "setup kickoff");
	if (value.initialization.kickoff.mode !== "interactive") fail("dispatch_setup_invalid", "Setup must use the returned interactive kickoff");
	const initialization = {
		acknowledgement: text(value.initialization.acknowledgement, "setup acknowledgement", 1024),
		kickoff: { mode: /** @type {const} */ ("interactive"), prompt: text(value.initialization.kickoff.prompt, "setup prompt", 16000) },
	};
	if (initialization.acknowledgement !== `Foundry setup ready: ${attempt.planId}/${attempt.taskId}/${attempt.attemptId}`) {
		fail("dispatch_setup_invalid", "Setup acknowledgement belongs to another attempt");
	}
	const delegationPrompt = text(value.delegationPrompt, "unchanged delegation", 2_000_000);
	const requiredInputs = list(value.requiredInputs, "complete required inputs", 128).map(packageInput);
	const inputs = value.inputs === null ? null : reservedInputs(value.inputs);
	if (inputs) {
		assertInputCoverage(inputs, requiredInputs);
		if (stableStringify(inputs.consumer) !== stableStringify(attempt) || inputs.bootstrap.branch !== baseBranch || inputs.bootstrap.commit !== baseCommit
			|| !delegationPrompt.includes(stableStringify(inputs))) fail("dispatch_inputs_changed", "Reserved handoff must contain the complete immutable input descriptor");
	} else if (requiredInputs.length) fail("dispatch_inputs_missing", "Package inputs require the complete reserved descriptor");
	return { attempt, projectId: text(value.projectId, "App project", 512), baseBranch, baseCommit, initialization, delegationPrompt, inputs, requiredInputs };
}

/** @param {unknown} value */
export function createdChild(value) {
	object(value, ["sessionId", "projectId", "creatorSessionId", "worktreePath", "branch"], "created child");
	const worktreePath = text(value.worktreePath, "created worktree", 4096);
	if (!path.isAbsolute(worktreePath) || path.normalize(worktreePath) !== worktreePath) fail("dispatch_child_invalid", "App must return a canonical absolute worktree");
	return {
		sessionId: text(value.sessionId, "created session", 512), projectId: text(value.projectId, "created project", 512),
		creatorSessionId: text(value.creatorSessionId, "creator session", 512), worktreePath, branch: text(value.branch, "created branch", 512),
	};
}

/**
 * App result/observation decoders are host composition ports, not invented SDK schemas.
 * Without those supported observations preflight holds BEFORE creation. Complete listing
 * and fresh detail are passed to the observer; an idle SDK event is never setup evidence.
 * Canonical reservation/child decoding and error classification stay on this native port.
 * @param {{
 * transport: ReturnType<typeof import("./admission.mjs").createOfferedDispatchTransport>,
 * decodeCreated?: (value: unknown) => unknown,
 * decodeRun?: (value: unknown) => unknown,
 * decodeHandoff?: (value: unknown) => unknown,
 * observeSetup?: (child: Child, reservation: Reservation) => Promise<unknown>,
 * observeChild?: (input: {child: Child, detail: NativeResult, inventory: NativeResult, after: string}) => Promise<unknown>,
 * reconcile?: (receipt: import("../types/parallel.js").EffectReceipt, payload: Json) => Promise<NativeResult | null>,
 * }} options */
export function createNativeDispatch(options) {
	const { transport } = options;
	/** @param {Reservation} reservation */
	function checkOwner(reservation) {
		if (reservation.attempt.owner !== transport.owner) fail("dispatch_foreign_plan", "Prepared reservation belongs to another owner");
	}
	/** @param {Reservation} reservation */
	function createArguments(reservation) {
		checkOwner(reservation);
		return {
			project_id: reservation.projectId, base_branch: reservation.baseBranch,
			workspace_type: "worktree", coordinate_with_creator: true, notify_on_idle: "always",
			kickoff: reservation.initialization.kickoff,
		};
	}
	return {
		transport, createArguments, dispatchReservation, createdChild,
		/** @param {unknown} error */
		classifyError(error) {
			return error instanceof DispatchNativeError ? error : null;
		},
		preflight() {
			for (const name of ["create_session", "get_session", "list_sessions_and_chats", "foundry_get_status", "foundry_attach_task", "send_session_message"]) transport.ensure(name);
			if (!options.decodeCreated || !options.decodeHandoff || !options.observeSetup || !options.observeChild) {
				fail("dispatch_observation_unavailable", "Host result/setup/canonical-observation ports are unavailable; invoke bounded coordinator reconciliation");
			}
		},
		/** @param {Reservation} reservation @param {string} [correlation] */
		async create(reservation, correlation) {
			checkOwner(reservation);
			return transport.call("create_session", readJsonValue(createArguments(reservation)), correlation);
		},
		/** @param {unknown} value @param {Reservation} reservation */
		decodeCreated(value, reservation) {
			if (!options.decodeCreated) fail("dispatch_result_unsupported", "No supported App creation-result decoder");
			const child = createdChild(options.decodeCreated(value));
			if (child.projectId !== reservation.projectId || child.creatorSessionId !== transport.sessionId) fail("dispatch_child_mismatch", "Returned child has a different project/creator");
			return child;
		},
		/** Exact setup acknowledgement, followed by newly captured detail/inventory.
		 * @param {Child} child @param {Reservation} reservation @param {string} after */
		async corroborate(child, reservation, after) {
			checkOwner(reservation);
			if (!options.observeSetup || !options.observeChild) fail("dispatch_observation_unavailable", "Setup/canonical observation is unavailable");
			const ack = await options.observeSetup(child, reservation);
			object(ack, ["sessionId", "message", "at", "source"], "actual setup acknowledgement");
			const ackAt = timestamp(ack.at, "acknowledgement time");
			if (ack.sessionId !== child.sessionId || ack.message !== reservation.initialization.acknowledgement || ackAt < after) {
				fail("dispatch_setup_unconfirmed", "Exact post-creation setup acknowledgement is not observed");
			}
			text(ack.source, "acknowledgement source", 4096);
			const detail = await transport.call("get_session", { project_session_id: child.sessionId });
			const inventory = await transport.call("list_sessions_and_chats", {});
			const observed = await options.observeChild({ child, detail, inventory, after: ackAt });
			object(observed, ["child", "capturedAt", "source", "complete", "aliases", "baseBranch", "baseCommit", "head", "clean"], "canonical child observation");
			const canonical = createdChild(observed.child);
			const capturedAt = timestamp(observed.capturedAt, "canonical observation time");
			const aliases = list(observed.aliases, "native aliases", 16).map(item => text(item, "alias", 512));
			if (!readBoolean(observed.complete) || capturedAt < ackAt || capturedAt <= after
				|| canonical.sessionId !== child.sessionId || canonical.projectId !== child.projectId || canonical.creatorSessionId !== child.creatorSessionId
				|| canonical.worktreePath !== child.worktreePath || aliases.length !== 1 || aliases[0] !== child.sessionId) {
				fail("dispatch_inventory_ambiguous", "Incomplete, stale or ambiguous canonical child/project/creator/worktree observation");
			}
			if (observed.baseBranch !== reservation.baseBranch || observed.baseCommit !== reservation.baseCommit
				|| observed.head !== reservation.baseCommit || !readBoolean(observed.clean)) {
				fail("dispatch_bootstrap_drift", "Reserved base or clean setup worktree changed; hold attachment");
			}
			text(observed.source, "canonical observation source", 4096);
			return { child: canonical, acknowledgement: readJsonValue(ack), observation: readJsonValue(observed), detail: detail.raw, inventory: inventory.raw };
		},
		/** @param {Reservation} reservation @param {Child} child @param {string} [correlation] */
		async handoff(reservation, child, correlation) {
			checkOwner(reservation);
			if (child.projectId !== reservation.projectId || child.creatorSessionId !== transport.sessionId
				|| child.sessionId === transport.sessionId) fail("dispatch_child_mismatch", "Warm handoff requires this coordinator's exact attached project/child");
			return transport.call("send_session_message", {
				session_id: child.sessionId, message: reservation.delegationPrompt,
				coordinator_only: true, delivery_mode: "immediate", mode: "autopilot",
			}, correlation);
		},
		/** Acceptance is queue admission, not execution or completion.
		 * @param {unknown} value @param {string} sessionId */
		decodeHandoff(value, sessionId) {
			if (!options.decodeHandoff) fail("dispatch_result_unsupported", "No supported handoff-result decoder");
			const accepted = options.decodeHandoff(value);
			object(accepted, ["sessionId", "accepted"], "handoff admission");
			if (accepted.sessionId !== sessionId || accepted.accepted !== true) fail("dispatch_handoff_unconfirmed", "Native handoff admission is not established");
			return sessionId;
		},
		/** The launchSpec is forwarded verbatim, not reduced to SDK workflow options.
		 * @param {Json} launchSpec @param {string} [correlation] */
		async launch(launchSpec, correlation) {
			object(launchSpec, ["name", "args", "limits"], "prepared launchSpec");
			text(launchSpec.name, "prepared workflow name", 512);
			if (!options.decodeRun) fail("dispatch_result_unsupported", "No supported workflow-result decoder");
			return transport.call("run_dynamic_workflow", launchSpec, correlation);
		},
		/** @param {unknown} value */
		decodeRun(value) {
			if (!options.decodeRun) fail("dispatch_result_unsupported", "No supported workflow-result decoder");
			return text(options.decodeRun(value), "returned native run ID", 512);
		},
		/** Missing/uncertain outcomes are NOT retried, even when inventory happens to be empty.
		 * The host resolver must use an exact owned tool receipt/transcript/run correlation.
		 * @param {import("../types/parallel.js").EffectReceipt} receipt @param {Json} payload */
		async reconcile(receipt, payload) {
			if (receipt.attempt.owner !== transport.owner) fail("dispatch_foreign_plan", "Cannot reconcile a foreign attempt");
			transport.ensure("foundry_get_status");
			return options.reconcile ? options.reconcile(receipt, payload) : null;
		},
	};
}
