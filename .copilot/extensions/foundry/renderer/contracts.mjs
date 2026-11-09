/** Wire readers expose only the fields this read-only board consumes. */
const FoundryWire = (() => {
	/** @template T @typedef {import("../data.mjs").Decoder<T>} Decoder */
	/** @param {unknown} value @returns {Record<string, unknown>} */
	function record(value) {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid board object");
		return /** @type {Record<string, unknown>} */ (value);
	}
	/** @param {unknown} value */
	function text(value) {
		if (typeof value !== "string") throw new TypeError("Invalid board text");
		return value;
	}
	/** @param {unknown} value */
	function number(value) {
		if (typeof value !== "number") throw new TypeError("Invalid board number");
		return value;
	}
	/** @param {unknown} value */
	function boolean(value) {
		if (typeof value !== "boolean") throw new TypeError("Invalid board flag");
		return value;
	}
	/** @template T @param {Decoder<T>} read @returns {Decoder<T | undefined>} */
	const optional = (read) => (value) => value === undefined ? undefined : read(value);
	/** @template T @param {Decoder<T>} read @returns {Decoder<T | null>} */
	const nullable = (read) => (value) => value === null ? null : read(value);
	/** @template T @param {Decoder<T>} read @returns {Decoder<T[]>} */
	const array = (read) => (value) => {
		if (!Array.isArray(value)) throw new TypeError("Invalid board list");
		return value.map((/** @type {unknown} */ entry) => read(entry));
	};
	/** @template {Record<string, Decoder<unknown>>} T @param {T} fields @returns {Decoder<import("../data.mjs").Decoded<T>>} */
	const object = (fields) => (value) => {
		const input = record(value);
		const checked = Object.fromEntries(Object.entries(fields).map(([key, read]) => [key, read(input[key])]));
		// The field readers, not the incoming JSON, establish this mapped-key type.
		return /** @type {import("../data.mjs").Decoded<T>} */ (checked);
	};
	const strings = array(text);
	const reference = object({ id: text, revision: number });
	const source = object({ kind: text, ref: text, actor: text, at: text, judgmentId: optional(text) });
	const evaluation = object({
		modality: text, procedure: object({ ref: text, digest: text }),
		environment: text, workload: text, maxAgeSeconds: number, independent: boolean, preservation: boolean,
	});
	const evidence = object({
		id: text, type: text, summary: text, source: nullable(text), outcome: text, producer: text, trust: text,
	});
	const attempt = object({
		id: text, status: text, sessionId: nullable(text), reservationId: text, baseBranch: text,
		branch: nullable(text), commit: nullable(text), prUrl: nullable(text), resultSummary: nullable(text),
		error: nullable(text), reservedAt: text, startedAt: nullable(text), cancelRequestedAt: nullable(text), completedAt: nullable(text),
		scopeOverride: nullable(object({ approvedBy: text, reason: text })),
		integrationRequired: array(object({ taskId: text, attemptId: text })), evidence: array(evidence),
	});
	const task = object({
		id: text, title: text, description: text, kind: text, status: text,
		dependsOn: strings, expectedFiles: strings, deliveryRequirement: text, attempts: array(attempt),
	});
	const plan = object({
		id: text, title: text, objective: text, revision: number, status: text,
		repository: object({ baseBranch: text }), updatedAt: text,
		planning: nullable(object({ runId: text })),
		factory: optional(nullable(object({ candidateId: nullable(text) }))),
		tasks: array(task), verification: object({
			status: text, runId: nullable(text), inputDigest: nullable(text), summary: nullable(text),
			evidence: strings, missingEvidence: strings, correctionTaskIds: strings,
		}),
		cancellation: nullable(object({ reason: text, requiredAttemptIds: strings, verificationReservationId: nullable(text), verificationRunId: nullable(text) })),
		activity: array(object({ event: text, revision: number, at: text })),
	});
	/** @param {unknown} value */
	const recoveryAction = (value) => {
		const input = record(value);
		return { ...input, kind: text(input.kind), taskId: optional(text)(input.taskId) };
	};
	const projection = object({
		progress: object({ done: number, total: number, percent: number, attempts: number }),
		scheduling: object({ readyTaskIds: strings }), actions: array(recoveryAction),
		nextAction: object({ kind: text }), factoryHold: optional(object({ reason: text, blocksAllExecution: optional(boolean) })),
		dependencyWaits: array(object({ taskId: text, dependencies: array(object({ taskId: text, status: text })) })),
	});
	const limits = object({
		maxAiCredits: optional(number), timeoutSeconds: optional(number),
		maxTotalSubagents: optional(number), maxConcurrentSubagents: optional(number),
	});
	/** @param {unknown} value */
	const opaque = (value) => value;
	const workflowFields = {
		runId: text, workflowName: text, revision: number, status: text, observedAt: optional(number),
		currentPhase: optional(nullable(object({ id: text, ordinal: nullable(number) }))), liveAgentCount: optional(number),
		consumed: optional(object({ nanoAiu: opaque, activeMs: opaque, subagents: opaque })),
		approved: optional(nullable(limits)), declaredLimits: optional(limits),
		terminal: optional(nullable(object({
			error: optional(text), pauseInfo: optional(nullable(object({ type: text, key: optional(text) }))),
			failure: optional(object({ type: text })),
		}))),
	};
	const workflow = object({ ...workflowFields, actions: strings });
	/** @param {unknown} value */
	function workflows(value) {
		const input = record(value);
		if (input.state === "unavailable") return { state: /** @type {const} */ ("unavailable"), error: text(input.error) };
		if (input.state !== "available") throw new TypeError("Invalid workflow listing state");
		return {
			state: /** @type {const} */ ("available"), runs: array(workflow)(input.runs),
			omittedOlder: optional(number)(input.omittedOlder), warning: optional(nullable(text))(input.warning),
		};
	}
	const workflowDetail = object({
		...workflowFields, observedAt: number, declaredLimits: limits,
		phases: array(object({ title: text, status: text, accumulatedActiveMs: number, currentActiveMs: number, liveAgentCount: number, totalAgentCount: number })),
		agents: array(object({ label: text, status: text, resolvedModel: optional(text), requestedModel: optional(text), activeMs: number, activity: optional(text) })),
		progress: object({
			records: array(object({ seq: number, attempt: number, text })),
			revision: number, oldestSeq: nullable(number), hasMoreOlder: boolean,
		}),
	});
	const artifact = object({ kind: optional(text), ref: text, digest: text });
	const selection = object({ kind: text, actor: text, reason: text });
	const candidate = object({
		id: text, unitId: text, mode: text, isCurrent: boolean, selection: nullable(selection),
		contractRevision: number, contractDigest: text, createdAt: text, actor: text, incumbentId: nullable(text),
		delivery: nullable(object({ commit: text })), binding: nullable(object({ owner: text, planId: text })),
		renewalSignalIds: optional(strings), retirementHolds: optional(array(object({ planId: text, owner: text }))), retirementHoldCount: optional(number),
		evaluationWork: optional(array(object({ planId: text, active: boolean, completion: optional(nullable(object({ disposition: optional(text) }))) }))),
		contextDigest: text, context: object({
			independence: object({ method: text, reason: text }), generation: array(artifact), comparisonOnly: array(artifact),
		}),
		assurance: object({ ready: boolean, missing: strings }),
		evidence: array(object({
			id: text, evaluation: reference, outcome: text, trust: text, publicationDisposition: optional(text),
			source, recordedAt: text, environment: text, workload: text, report: text,
		})),
		evidenceTruncated: optional(boolean), evidenceCount: optional(number),
	});
	const factoryFields = {
		revision: number, observedAt: optional(text), repository: optional(object({ commonDirectory: text })),
		storage: optional(object({
			version: number, hotEvents: number, archiveSegments: number,
			transfers: array(object({ id: text, status: text, cursor: number, revision: number })),
		})),
		synchronization: optional(object({ owned: boolean, pending: strings })),
		pendingHuman: optional(array(object({ evaluation: reference, definition: object({ procedure: object({ ref: text }) }) }))),
		renewalNeeds: optional(array(object({ candidateId: text, scope: text, affectedUnitIds: strings, uncertainUnitIds: strings }))),
		truncated: optional((/** @type {unknown} */ value) => Object.fromEntries(Object.entries(record(value)).map(([key, value]) => [key, boolean(value)]))),
		units: array(object({
			id: text, name: text, purpose: text, revision: number, acceptedUnitRevision: optional(nullable(number)), currentCandidateId: optional(nullable(text)),
			boundary: object({ owns: strings, exposes: strings, consumes: strings, preserves: strings }),
			dependencies: strings, relationshipCoverage: text,
		})),
		contracts: array(object({
			unitName: optional(text), unitId: text, revision: number, current: optional(boolean), digest: text,
			previousDigest: nullable(text), obligations: array(reference), evaluations: array(reference), decisionId: text,
		})),
		decisions: array(object({
			id: text, actor: text, at: text, reason: text,
			resolutions: optional(array(object({ knowledge: reference, reason: text }))),
		})),
		knowledge: array(object({
			id: text, revision: number, authority: text, kind: text, statement: text, uncertainty: nullable(text),
			source, links: array(object({ relation: text, target: reference })), evaluation: optional(nullable(evaluation)),
		})),
		candidates: array(candidate),
		renewals: array(object({
			id: text, signalId: text, status: text, affectedUnitIds: strings, uncertainUnitIds: strings, localization: text,
			decisionIds: optional(strings), candidateIds: optional(strings), pendingUnitIds: optional(strings), proposal: text,
		})),
		signals: array(object({ id: text, summary: text, source: object({ ref: text, actor: text, at: text }) })),
		retirements: array(object({ type: text, id: text, revision: optional(number), summary: text, actor: text, reason: text, at: text, retention: text })),
		compactions: optional(array(object({ id: text, actor: text, reason: text, at: text, retention: text }))),
	};
	/** @param {unknown} value */
	function factory(value) {
		const input = record(value);
		if (input.state === "unavailable") return { state: /** @type {const} */ ("unavailable"), error: text(input.error) };
		if (input.state !== "available") throw new TypeError("Invalid factory listing state");
		return { state: /** @type {const} */ ("available"), ...object(factoryFields)(input) };
	}
	const snapshot = object({
		plan: nullable(plan), projection: nullable(projection), workflows: optional(workflows), factory: optional(nullable(factory)),
		bindingId: optional(text), interactions: optional(object({ native: boolean, readOnly: optional(boolean) })),
	});
	/** @param {unknown} error */
	const errorMessage = (error) => error instanceof Error ? error.message
		: error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : String(error);
	return { snapshot, workflowDetail, record, errorMessage };
})();

export { FoundryWire };
