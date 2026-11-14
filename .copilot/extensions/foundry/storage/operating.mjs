import { analysisInputDigest, stableStringify } from "../digest.mjs";
import { operatingAuthority, operatingHistory, operatingPublication } from "../plan/schemas/operating.mjs";
import { readPlan, serializePlan } from "./documents.mjs";
import { storageError } from "./errors.mjs";
import { consumeOperatingPermit } from "../factory/operating.mjs";

/** @typedef {import("../types/operating.js").OperatingPublication} Publication */
/** @param {string} code @param {string} message @returns {never} */
function fail(code, message) { throw storageError(code, message); }

/** No schema/table/authority is added. The plan document is the existing immutable
 * outbox; local-only markers cannot enter through create, import or generic mutate.
 * @param {{transaction: ReturnType<typeof import("./database.mjs").createArtifactDatabase>["transaction"],
 * owner: string, now: () => string,
 * readDelegation: (db: import("node:sqlite").DatabaseSync, id: string) => import("../types/plan.js").ApprovalDelegation | null}} options
 * @returns {import("../types/operating.js").OperatingPersistencePort} */
export function createOperatingPersistence({ transaction, owner, now, readDelegation }) {
	return Object.freeze({
		commit(rawPublication, rawAuthority, native, permit) {
			const publication = operatingPublication(rawPublication);
			const authority = operatingAuthority(rawAuthority);
			consumeOperatingPermit(permit, publication, authority);
			return transaction(db => {
				const plan = readPlan(db, authority.planId);
				const binding = authority.binding;
				const identity = authority.fence.admission;
				const attempt = plan.tasks.find(task => task.id === authority.taskId)?.attempts.at(-1);
				if (plan.revision !== authority.expectedPlanRevision) fail("revision_conflict", "Owner plan changed before operating authorization");
				if (plan.factory?.owner !== owner || identity.owner !== owner
					|| plan.factory.repositoryId !== identity.repositoryId || identity.repositoryId !== publication.batch.snapshot.repositoryId
					|| identity.planId !== plan.id || identity.taskId !== authority.taskId
					|| plan.status !== "running" || plan.cancellation !== null || !plan.gates.planApprovedAt
					|| attempt?.status !== "running" || attempt.id !== authority.attemptId
					|| attempt.reservationId !== identity.reservationId || !attempt.sessionId
					|| !binding || binding.owner !== owner || binding.sessionId !== attempt.sessionId
					|| binding.planId !== plan.id || binding.taskId !== authority.taskId || binding.attemptId !== attempt.id) {
					fail("operating_authority_changed", "Operating mutation requires the exact current approved owner, task, attempt and native binding");
				}
				if (publication.planId !== plan.id || publication.planRevision !== plan.revision
					|| publication.taskId !== authority.taskId || publication.attemptId !== attempt.id
					|| publication.reservationId !== attempt.reservationId || publication.sessionId !== attempt.sessionId
					|| publication.ownerDigest !== analysisInputDigest(owner)) {
					fail("operating_authority_changed", "Publication attribution does not match the transactionally re-read owner");
				}
				const prior = plan.operating ?? { version: 1, publications: [], local: [] };
				if (prior.publications.some(entry => entry.batch.id === publication.batch.id)) {
					fail("operating_publication_conflict", "A committed publication must reconcile its exact history, not authorize again");
				}
				const delegation = authority.delegationId ? readDelegation(db, authority.delegationId) : null;
				if (authority.delegationId && (!delegation || delegation.revocation || delegation.scope.owner !== owner
					|| delegation.scope.repositoryId !== plan.factory.repositoryId)) {
					fail("operating_delegation_unavailable", "An absent, foreign or revoked grant cannot authorize a new operating mutation");
				}
				if (!native || typeof native.assertAuthority !== "function" || native.assertAuthority.constructor?.name === "AsyncFunction") {
					fail("operating_authority_unavailable", "A synchronous trusted action-time native ownership check is required");
				}
				const observed = structuredClone({ plan, authority, delegation, publication });
				const before = stableStringify(observed);
				const result = native.assertAuthority(observed.plan, observed.authority, observed.delegation, observed.publication);
				if (result !== undefined || stableStringify(observed) !== before) fail("operating_authority_invalid", "Native checking cannot rewrite or asynchronously authorize the candidate");
				const operating = operatingHistory({
					version: 1, publications: [...prior.publications, publication],
					local: [...prior.local, { digest: publication.digest, references: authority.references, binding }],
				});
				const persisted = serializePlan({ ...plan, operating, revision: plan.revision + 1, updatedAt: now() }, "candidate_invalid");
				const changed = db.prepare("UPDATE plans SET revision=?, document=? WHERE id=? AND revision=?")
					.run(persisted.plan.revision, persisted.document, plan.id, plan.revision);
				if (changed.changes !== 1) fail("revision_conflict", "Owner plan changed during operating authorization");
				return publication;
			}, { write: true });
		},
		require(planId, digest) {
			return transaction(db => {
				const history = readPlan(db, planId).operating;
				const publication = history?.publications.find(entry => entry.digest === digest);
				if (!publication || !history?.local.some(entry => entry.digest === digest)
					|| publication.ownerDigest !== analysisInputDigest(owner)) {
					fail("operating_authorization_missing", "Imported history is not an owner-local authorization commit");
				}
				return operatingPublication(publication);
			});
		},
	});
}
