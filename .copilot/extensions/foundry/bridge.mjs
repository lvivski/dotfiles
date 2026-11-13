import { createAuthority } from "./bridge/authority.mjs";
import { createDispatchBridge } from "./bridge/dispatch.mjs";
import { createEvidenceBridge, validatePackageAssurance } from "./bridge/evidence.mjs";
import { createBoundPlans } from "./bridge/planning.mjs";
import { createSynchronization } from "./bridge/synchronization.mjs";
import { validateFactoryLearning } from "./plan/schemas/factory.mjs";
import { createHash } from "node:crypto";
import { isRecord, parseJson } from "./data.mjs";
import { stableStringify } from "./digest.mjs";
import { git, requireCommit } from "./evidence/git.mjs";
import { checkEvaluator } from "./evidence/bundles.mjs";
import { fail, object, strings, text, timestamp } from "./factory/fields.mjs";
import { repositoryPath } from "./factory/procedures.mjs";
import { canonicalBindings, compilePackageGraph, readPackageDecomposition } from "./plan/packages.mjs";
import { createPackageInputs } from "./bridge/package-inputs.mjs";
import { latestSuccessfulAttempt } from "./plan/queries.mjs";
import { artifactIdentity, consumerEntry, reservedInputs } from "./plan/parallel-contracts.mjs";
import { buildAssuranceSubject } from "./analysis/assurance.mjs";

/** @typedef {import("./types/plan.js").FoundryPlan} FoundryPlan */
/** @typedef {import("./types/parallel.js").ReservedInputs} ReservedInputs */
/** @typedef {{admission: ReturnType<typeof import("./storage/admission.mjs").createAdmissionStore>,
 * journal: ReturnType<typeof import("./storage/dispatch.mjs").createDispatchJournal>}} PackageStorage */
/** @typedef {{complete: boolean, source: string, capturedAt: string, commit: string, authors: string[]}} PackageContributors */

/**
 * @param {{workspace: () => string, storeFor: () => ReturnType<typeof import("./storage.mjs").createPlanStore>,
 * notify: (event: import("./types/plan.js").ChangeEvent) => void, storageRoot?: string, clock?: () => Date|string|number}} options
 */
export function createFactoryBridge({ workspace, storeFor, notify, storageRoot, clock }) {

	const { factoryFor, requireOwner, stateFor, context } = createAuthority({ workspace, storageRoot, clock });
	const { createBoundDraft, createPlan, createEvaluationPlan } = createBoundPlans({ workspace, storeFor, notify, factoryFor, context });
	const { validateReports, verificationContext, verificationGate, inspectPlan } = createEvidenceBridge(stateFor, workspace);
	const { prompt, requireRetry, activateEvaluation } = createDispatchBridge(stateFor, context);
	const { preflight, sync, captureRejectedReport } = createSynchronization(stateFor, activateEvaluation,
		(planId, decisionId, digest) => storeFor().requireTechnicalAuthorization(planId, decisionId, digest));

	/** The owner-bound immutable blueprint, not caller prose, supplies the manifest digest.
	 * @param {FoundryPlan} value */
	function packageContext(value) {
		const { plan, factory, state } = stateFor(value);
		const framed = plan.tasks.filter(task => task.kind === "implement" && task.description.includes("\n[foundry-package-v1]\n"));
		if (!framed.length) return null;
		if (!plan.factory.candidateId) fail("parallel_context_required", "Executable package recovery requires a sealed candidate");
		const generation = factory.generation(plan.factory.candidateId);
		const governing = canonicalBindings({
			authority: "accepted-contract", repositoryId: factory.repository.id,
			unit: { id: generation.unit.id, revision: generation.unit.revision },
			contract: { revision: generation.contract.revision, digest: generation.contract.digest },
			requirements: generation.obligations.map(({ id, revision }) => ({ id, revision })),
			evaluators: generation.evaluations.map(({ id, revision, evaluation }) => ({
				id, revision, procedureDigest: evaluation.procedure.digest, requirements: evaluation.obligations,
				independent: evaluation.independent, modality: evaluation.modality,
			})),
			visualEvaluation: generation.unit.visualEvaluation ?? null,
		});
		const description = framed[0].description, marker = "\n[foundry-package-v1]\n";
		const manifest = parseJson(description.slice(description.lastIndexOf(marker) + marker.length, -"\n[/foundry-package-v1]".length));
		if (!isRecord(manifest)) fail("parallel_package_manifest_missing", "Sealed package manifest is missing");
		const decomposition = readPackageDecomposition(plan.tasks, { governing, digest: text(manifest.digest, "decomposition digest", 64) });
		const { taskIds } = compilePackageGraph(decomposition, governing);
		const candidate = state.candidates.find(entry => entry.id === plan.factory.candidateId);
		if (!candidate) fail("factory_candidate_missing", "Package candidate is unavailable");
		const protectedPaths = generation.evaluations.flatMap(({ evaluation }) => {
			checkEvaluator(plan.repository.workingDirectory, evaluation);
			return evaluation.procedure.bundle ? [evaluation.procedure.bundle.root, ...evaluation.procedure.bundle.support] : [];
		});
		const comparisonOnlyPaths = candidate.context.comparisonOnly.flatMap(({ ref }) =>
			/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("/") ? [] : [repositoryPath(ref, "comparison-only path")]);
		const listed = git(plan.repository.workingDirectory, ["worktree", "list", "--porcelain", "-z"]);
		if (listed.error || listed.status !== 0) fail("parallel_worktree_path", "Cannot establish the primary repository worktree");
		const primary = listed.stdout.toString("utf8").split("\0").find(line => line.startsWith("worktree "))?.slice(9);
		if (!primary) fail("parallel_worktree_path", "Primary worktree identity is missing");
		return {
			decomposition, taskIds, governing, definitions: generation.evaluations,
			policy: {
				protectedPaths: [...new Set(protectedPaths)], comparisonOnlyPaths,
				comparisonOnlyDigests: [...new Set(candidate.context.comparisonOnly.map(entry => entry.digest))],
				forbiddenWorktreePaths: [primary],
			},
		};
	}

	/** Current owner-local plan, admission and native journal are the only identity readers.
	 * Imported reports and caller-supplied paths cannot establish consumer authority.
	 * @param {FoundryPlan} plan @param {PackageStorage} storage */
	function packageInputs(plan, { admission, journal }) {
		const recovered = packageContext(plan);
		if (!recovered) return null;
		const { decomposition, taskIds, policy } = recovered;
		const scope = stateFor(plan).plan.factory;
		/** @param {string} taskId */
		const declaration = taskId => decomposition.packages.find(pkg => taskIds[pkg.id] === taskId);
		const fresh = () => {
			const current = storeFor().readCurrent(plan.id);
			stateFor(current);
			if (stableStringify(current.factory) !== stableStringify(scope)) fail("parallel_binding_mismatch", "The package plan's authority changed");
			return current;
		};
		/** @param {import("./types/plan.js").FoundryAttempt} attempt @param {string} taskId */
		const identity = (attempt, taskId) => ({
			repositoryId: scope.repositoryId, owner: scope.owner, planId: plan.id, taskId, reservationId: attempt.reservationId,
		});
		/** @param {import("./types/parallel.js").AttemptIdentity} attempt */
		function receipts(attempt) {
			const { attemptId, ...key } = attempt;
			const record = admission.read(key);
			if (!record || stableStringify(record.attempt) !== stableStringify(attempt)) return null;
			const stored = journal.read(attempt);
			const ordered = (/** @type {import("./types/parallel.js").EffectReceipt[]} */ entries) => [...entries].sort((a, b) => a.id.localeCompare(b.id));
			if (stableStringify(ordered(record.receipts)) !== stableStringify(ordered(stored))) fail("dispatch_journal_mismatch", "Input authority requires matching admission and journal receipts");
			return record;
		}
		/** @param {string} taskId */
		function ownedDelivery(taskId) {
			const current = fresh(), pkg = declaration(taskId);
			const task = current.tasks.find(entry => entry.id === taskId);
			const attempt = task && latestSuccessfulAttempt(task);
			if (!pkg || !attempt?.commit || !attempt.sessionId || task?.status !== "done") return null;
			const key = { ...identity(attempt, taskId), attemptId: attempt.id }, record = receipts(key);
			const receipt = record?.delivery;
			const completionRevision = current.activity.findLast(entry => entry.event === `task-done:${taskId}:${attempt.id}`)?.revision;
			if (!record || !["settled", "released"].includes(record.phase) || !receipt
				|| receipt.commit !== attempt.commit || receipt.sessionId !== attempt.sessionId || receipt.planRevision !== completionRevision) return null;
			const attachment = journal.payload(key, "attachment");
			const handoff = record.receipts.find(entry => entry.kind === "handoff");
			if (!isRecord(attachment) || !isRecord(attachment.child) || attachment.child.sessionId !== attempt.sessionId
				|| handoff?.state !== "succeeded" || handoff.sessionId !== attempt.sessionId) return null;
			const commit = requireCommit(plan.repository.workingDirectory, attempt.commit);
			const outputs = [];
			for (const output of pkg.outputs) {
				const result = git(plan.repository.workingDirectory, ["ls-tree", "-z", "--full-tree", commit, "--", output.path]);
				const rows = result.stdout?.toString("utf8").split("\0").filter(Boolean) ?? [];
				if (result.error || result.status !== 0) fail("parallel_output_unavailable", "Declared output Git evidence is unavailable");
				if (!rows.length) return null;
				const row = rows.length === 1 && /^(100644|100755) blob ([a-f0-9]{40,64})\t(.+)$/.exec(rows[0]);
				if (!row || row[3] !== output.path) fail("parallel_output_unavailable", "Declared output is not an immutable regular Git blob");
				const bytes = git(plan.repository.workingDirectory, ["cat-file", "blob", row[2]]);
				if (bytes.error || bytes.status !== 0) fail("parallel_output_unavailable", "Declared output bytes are unavailable");
				outputs.push({
					id: output.id,
					artifact: artifactIdentity({
						repositoryId: scope.repositoryId, commit, path: output.path,
						mode: row[1],
						digest: createHash("sha256").update(bytes.stdout).digest("hex"),
					}),
				});
			}
			return {
				receipt, delivery: { packageId: pkg.id, attempt: key, commit, outputs },
				worktreePath: text(attachment.child.worktreePath, "producer worktree", 4096),
			};
		}
		/** @param {ReservedInputs} descriptor */
		function entry(descriptor) {
			const current = fresh(), consumer = descriptor.consumer;
			if (consumer.owner !== scope.owner || consumer.repositoryId !== scope.repositoryId || consumer.planId !== plan.id) return null;
			const attempt = current.tasks.find(task => task.id === consumer.taskId)?.attempts.at(-1);
			if (current.status !== "running" || attempt?.status !== "running" || attempt.id !== consumer.attemptId
				|| attempt.reservationId !== consumer.reservationId || !attempt.sessionId) return null;
			const record = receipts(consumer);
			if (record?.phase !== "reserved") return null;
			const attached = record.receipts.find(receipt => receipt.kind === "attachment");
			const handedOff = record.receipts.find(receipt => receipt.kind === "handoff");
			if (attached?.state !== "succeeded" || handedOff?.state !== "succeeded"
				|| attached.sessionId !== attempt.sessionId || handedOff.sessionId !== attempt.sessionId) return null;
			const creation = journal.payload(consumer, "creation"), attachment = journal.payload(consumer, "attachment"), handoff = journal.payload(consumer, "handoff");
			if (!isRecord(creation) || !isRecord(creation.reservation) || !isRecord(attachment) || !isRecord(attachment.child)
				|| !isRecord(handoff) || !isRecord(handoff.child)) return null;
			if (stableStringify(creation.reservation.inputs) !== stableStringify(descriptor)
				|| stableStringify(handoff.inputs) !== stableStringify(descriptor)
				|| handoff.delegationPrompt !== creation.reservation.delegationPrompt
				|| stableStringify(attachment.child) !== stableStringify(handoff.child)
				|| attachment.child.sessionId !== attempt.sessionId || attachment.child.branch !== attempt.branch
				|| attachment.baseCommit !== descriptor.bootstrap.commit) return null;
			const attachedRevision = current.activity.findLast(item => item.event === `task-attached:${consumer.taskId}:${consumer.attemptId}`)?.revision;
			if (!attachedRevision) return null;
			return consumerEntry({
				attempt: consumer, sessionId: attempt.sessionId, worktreePath: attachment.child.worktreePath,
				attachedRevision, handoffReceiptId: handedOff.id, inputDigest: descriptor.digest,
			}, descriptor);
		}
		const inputs = createPackageInputs({
			repositoryPath: plan.repository.workingDirectory, repositoryId: scope.repositoryId, owner: scope.owner,
			planId: plan.id, decomposition, taskIds, policy,
			readOwnedDelivery: query => ownedDelivery(query.taskId), readAuthorizedConsumerEntry: entry,
		});
		return {
			inputs, entry,
			/** @param {string} taskId */
			required: taskId => declaration(taskId)?.inputs ?? [],
			/** @param {string} taskId */
			delivery: taskId => ownedDelivery(taskId)?.delivery ?? null,
		};
	}

	/** Review authorizations come from a current trusted native reader, never from report fields.
	 * @param {FoundryPlan} plan @param {string} taskId @param {PackageStorage} storage
	 * @param {import("./analysis/assurance.mjs").ReviewObligation[]} reviews @param {PackageContributors} contributors */
	function packageSubject(plan, taskId, storage, reviews, contributors) {
		const current = storeFor().readCurrent(plan.id), context = packageContext(current);
		const owned = packageInputs(current, storage);
		const delivered = owned?.delivery(taskId);
		if (!context || !owned || !delivered) fail("parallel_assurance_delivery", "Package assurance requires a current owner-local successful native delivery");
		object(contributors, ["complete", "source", "capturedAt", "commit", "authors"], "current contributing authors");
		if (contributors.complete !== true || contributors.commit !== delivered.commit) {
			fail("parallel_authorship_incomplete", "Every contributing native author must be captured for this exact delivered commit");
		}
		text(contributors.source, "contributor source", 4096);
		const observed = timestamp(contributors.capturedAt, "contributor capture");
		const now = clock ? new Date(clock()).toISOString() : new Date().toISOString();
		if (observed > now) fail("parallel_authorship_stale", "Future-dated authorship cannot authorize independent review");
		const creation = storage.journal.payload(delivered.attempt, "creation");
		if (!isRecord(creation) || !isRecord(creation.reservation)) fail("parallel_assurance_inputs", "The immutable creation reservation is unavailable");
		const retained = reservedInputs(creation.reservation.inputs);
		const inputs = owned.inputs.resolve(delivered.attempt, retained.bootstrap, owned.required(taskId));
		if (stableStringify(inputs) !== stableStringify(retained)) fail("parallel_input_substitution", "Current producer receipts differ from the sealed reservation");
		const authors = new Set(strings(contributors.authors, "all contributing authors", 128, 1)), seen = new Set();
		/** @param {string} packageId */
		const visit = packageId => {
			if (seen.has(packageId)) return;
			seen.add(packageId);
			const pkg = context.decomposition.packages.find(entry => entry.id === packageId);
			const packageTaskId = context.taskIds[packageId], delivery = owned.delivery(packageTaskId);
			const author = current.tasks.find(task => task.id === packageTaskId)?.attempts.find(attempt => attempt.id === delivery?.attempt.attemptId)?.sessionId;
			if (!pkg || !delivery || !author) fail("parallel_assurance_authors", "Every contributing native producer must retain its owned successful delivery");
			authors.add(author);
			pkg.inputs.forEach(input => visit(input.producer));
		};
		visit(delivered.packageId);
		const producer = current.tasks.find(task => task.id === taskId)?.attempts.find(attempt => attempt.id === delivered.attempt.attemptId)?.sessionId;
		if (!producer) fail("parallel_assurance_authors", "The delivered package producer is unavailable");
		return buildAssuranceSubject({
			decomposition: context.decomposition, governing: context.governing, packageId: delivered.packageId,
			inputs, delivery: delivered, producer, authors: [...authors], definitions: context.definitions, reviews,
		});
	}

	/** @param {FoundryPlan} plan @param {string} taskId @param {PackageStorage} storage
	 * @param {import("./analysis/assurance.mjs").ReviewObligation[]} reviews @param {unknown} report @param {PackageContributors} contributors */
	function assessPackage(plan, taskId, storage, reviews, report, contributors) {
		const subject = packageSubject(plan, taskId, storage, reviews, contributors);
		const at = clock ? new Date(clock()).toISOString() : new Date().toISOString();
		return { subject, assessment: validatePackageAssurance(plan.repository.workingDirectory, subject, report, at) };
	}

	return {
		factoryFor, requireOwner, requireRetry, context, createBoundDraft, createPlan, createEvaluationPlan, sync, preflight,
		prompt, inspectPlan, validateReports, verificationGate, verificationContext, activateEvaluation,
		captureRejectedReport,
		packageContext, packageInputs, packageSubject, assessPackage,
		/** @param {unknown} value */
		validateLearning: (value) => { validateFactoryLearning(value); },
	};
}
