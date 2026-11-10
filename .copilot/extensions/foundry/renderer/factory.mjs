import { addLabeledValue, element, requiredElement } from "./dom.mjs";
/** @typedef {ReturnType<typeof import("./contracts.mjs").FoundryWire.snapshot>} PlanSnapshot */

/** @param {ReturnType<typeof import("./actions.mjs").createActions>["planAction"]} planAction @param {() => number} getPlanRevision */
export function createFactoryView(planAction, getPlanRevision) {
	/** @type {PlanSnapshot["factory"]} */
	let currentFactory = null;

	let factoryFingerprint = "";

	/** @type {Map<string, {row: HTMLDetailsElement, summary: HTMLElement, body: HTMLElement, fingerprint: string}>} */
	const factoryRows = new Map();

	let readOnlyInteractions = false;
	let hasPlan = false;
	function factoryView() {
		if (!currentFactory || currentFactory.state !== "available") throw new Error("Repository authority is unavailable");
		return currentFactory;
	}

	function renderFactory() {
		const fingerprint = JSON.stringify(currentFactory, (key, value) => key === "observedAt" ? undefined : value);
		if (fingerprint === factoryFingerprint) return;
		factoryFingerprint = fingerprint;
		const host = requiredElement("#factory");
		if (!currentFactory || currentFactory.state !== "available") {
			host.replaceChildren(element("p", "muted", currentFactory?.state === "unavailable"
				? `Repository authority unavailable: ${currentFactory.error}`
				: "No factory context. Define a coherent capability before planning; inspection is also available through foundry_get_factory."));
			factoryRows.clear();
			return;
		}
		const factory = currentFactory;
		if (factoryRows.size === 0) host.replaceChildren();
		const info = element("div", "factory-summary");
		info.append(element("p", "muted", `Repository revision ${currentFactory.revision}. Evidence is claimed or independent-claim, never proof of OS isolation.`));
		if (currentFactory.storage) {
			info.append(element("p", "muted", `Storage schema ${currentFactory.storage.version}: ${currentFactory.storage.hotEvents} active event records, ${currentFactory.storage.archiveSegments} retained archive segments. Storage maintenance is not conceptual simplification.`));
			for (const transfer of currentFactory.storage.transfers ?? []) {
				if (transfer.status === "pending") info.append(element("p", "warning", `Import ${transfer.id} is staged at ${transfer.cursor}/${transfer.revision}. It is not authoritative yet; resume it or explicitly abandon it without deleting the received history.`));
			}
		}
		const pending = currentFactory.synchronization?.pending ?? [];
		for (const judgment of currentFactory.pendingHuman ?? []) {
			info.append(element("p", "warning", `Explicit human judgment required for ${judgment.evaluation.id}@${judgment.evaluation.revision}: ${judgment.definition.procedure.ref}. An agent verdict cannot satisfy this rubric.`));
		}
		for (const need of currentFactory.renewalNeeds ?? []) {
			info.append(element("p", "warning",
				`${need.candidateId}: ${need.scope === "current-support" ? "current support needs renewal" : "candidate needs re-evaluation"}. Affected: ${need.affectedUnitIds.join(", ")}.${need.uncertainUnitIds.length ? ` Uncertain: ${need.uncertainUnitIds.join(", ")}.` : ""}`));
		}
		if (pending.length) {
			info.append(element("p", "warning", `Pending synchronization: ${pending.join("; ")}.`));
			if (factory.synchronization?.owned) {
				const sync = document.createElement("button");
				sync.type = "button";
				sync.textContent = "Recover factory evidence";
				sync.addEventListener("click", () => planAction({ action: "sync-factory", revision: getPlanRevision() }, sync,
					() => window.confirm("Recover persisted learning and evidence without approving requirements?") ? {} : null));
				info.append(sync);
			}
		}
		const bounded = Object.entries(currentFactory.truncated ?? {}).filter(([, truncated]) => truncated).map(([name]) => name);
		if (currentFactory.page) {
			const page = currentFactory.page;
			const omitted = Object.entries(page.omittedAfter).filter(([, count]) => count).map(([name, count]) => `${count} ${name}`).join(", ");
			info.append(element("p", "muted", `Inspection snapshot ${page.revision}: at most ${page.limit} records per collection.${omitted ? ` Older records omitted here: ${omitted}.` : ""}`));
		}
		if (bounded.length) info.append(element("p", "warning", `Showing bounded ${bounded.join(", ")}. Use foundry_get_factory filters and page.nextCursor with the same filters and limit for stable older pages; board refreshes show current authority.`));
		/** @type {HTMLElement[]} */
		const rows = [info];
		const seen = new Set();
		/** @param {string} id @param {string} label @param {unknown} value @param {(body: HTMLElement) => void} fill */
		const addRow = (id, label, value, fill) => {
			seen.add(id);
			let view = factoryRows.get(id);
			if (!view) {
				const row = document.createElement("details");
				row.className = "factory-record";
				const summary = element("summary", "", label);
				const body = element("div", "factory-detail");
				row.append(summary, body);
				view = { row, summary, body, fingerprint: "" };
				factoryRows.set(id, view);
			}
			const revision = JSON.stringify(value, (key, entry) => key === "observedAt" ? undefined : entry);
			if (view.fingerprint !== revision) {
				let focused = document.activeElement;
				while (focused && focused !== view.body) focused = focused.parentElement;
				view.summary.textContent = label;
				view.body.replaceChildren();
				fill(view.body);
				if (focused === view.body) view.summary.focus();
				view.fingerprint = revision;
			}
			rows.push(view.row);
		};
		for (const unit of currentFactory.units ?? []) addRow(`unit:${unit.id}`, `${unit.name} - capability`, unit, (body) => {
			body.append(element("p", "", unit.purpose));
			addLabeledValue(body, "Definition / accepted revision", `${unit.revision} / ${unit.acceptedUnitRevision ?? "none"}`);
			addLabeledValue(body, "Current implementation", unit.currentCandidateId ?? "None selected");
			for (const field of /** @type {const} */ (["owns", "exposes", "consumes", "preserves"])) addLabeledValue(body, field, unit.boundary[field].join("; ") || "None declared");
			addLabeledValue(body, "Dependencies", unit.dependencies.join(", ") || "None declared");
			addLabeledValue(body, "Relationship coverage", unit.relationshipCoverage);
		});
		for (const contract of currentFactory.contracts ?? []) addRow(`contract:${contract.unitId}:${contract.revision}`,
			`${contract.unitName ?? contract.unitId} (${contract.unitId}) - contract v${contract.revision} - ${contract.current ? "current accepted" : "historical accepted"}`, contract, (body) => {
				addLabeledValue(body, "Digest", contract.digest);
				addLabeledValue(body, "Previous", contract.previousDigest);
				addLabeledValue(body, "Obligations", contract.obligations.map((ref) => `${ref.id}@${ref.revision}`).join(", "));
				addLabeledValue(body, "Evaluations", contract.evaluations.map((ref) => `${ref.id}@${ref.revision}`).join(", "));
				const decision = factory.decisions.find((entry) => entry.id === contract.decisionId);
				addLabeledValue(body, "Accepted by", decision ? `${decision.actor} at ${decision.at}` : `Decision ${contract.decisionId} (outside bounded view)`);
				addLabeledValue(body, "Reason", decision?.reason);
				for (const resolution of decision?.resolutions ?? []) addLabeledValue(body, `Resolution ${resolution.knowledge.id}@${resolution.knowledge.revision}`, resolution.reason);
			});
		for (const entry of currentFactory.knowledge ?? []) addRow(`knowledge:${entry.id}:${entry.revision}`, `${entry.id}@${entry.revision} - ${entry.authority} ${entry.kind}`, entry, (body) => {
			body.append(element("p", "", entry.statement));
			addLabeledValue(body, "Uncertainty", entry.uncertainty);
			addLabeledValue(body, "Revision status", entry.revisionStatus);
			addLabeledValue(body, "Selected because", entry.selectionReasons?.join("; "));
			addLabeledValue(body, "Superseded by", entry.supersededBy?.map((ref) => `${ref.id}@${ref.revision}`).join(", "));
			if (entry.omittedSuperseders) body.append(element("p", "muted", `${entry.omittedSuperseders} additional superseding references are outside this bounded view.`));
			addLabeledValue(body, "Provenance", `${entry.source.kind}: ${entry.source.ref}; ${entry.source.actor}; ${entry.source.at}`);
			for (const link of entry.links) addLabeledValue(body, link.relation, `${link.target.id}@${link.target.revision}`);
			if (entry.evaluation) {
				const evaluation = entry.evaluation;
				addLabeledValue(body, "Modality", evaluation.modality);
				addLabeledValue(body, "Pinned procedure", `${evaluation.procedure.ref} (${evaluation.procedure.digest})`);
				addLabeledValue(body, "Context", `${evaluation.environment}; ${evaluation.workload}; valid ${evaluation.maxAgeSeconds}s`);
				addLabeledValue(body, "Independent / preservation", `${evaluation.independent} / ${evaluation.preservation}`);
			}
		});
		for (const candidate of currentFactory.candidates ?? []) addRow(`candidate:${candidate.id}`, `${candidate.id} - ${candidate.mode}; ${candidate.isCurrent ? "current" : candidate.selection?.kind ?? "not selected"}; ${candidate.assurance.ready ? "supported" : "assurance gaps"}`, candidate, (body) => {
			addLabeledValue(body, "Pinned contract", `v${candidate.contractRevision} ${candidate.contractDigest}`);
			addLabeledValue(body, "Prepared / author", `${candidate.createdAt}; ${candidate.actor}`);
			addLabeledValue(body, "Incumbent at preparation", candidate.incumbentId ?? "None");
			addLabeledValue(body, "Exact delivery", candidate.delivery?.commit ?? "Missing");
			addLabeledValue(body, "Execution", candidate.binding ? `${candidate.binding.owner}: ${candidate.binding.planId}` : "External or adopted artifact");
			addLabeledValue(body, "Decision", candidate.selection ? `${candidate.selection.actor}: ${candidate.selection.reason}` : "Explicit selection required");
			addLabeledValue(body, "Renewal signals", candidate.renewalSignalIds?.join(", "));
			addLabeledValue(body, "Retirement holds", candidate.retirementHolds?.map((binding) => `${binding.planId} (${binding.owner})`).join("; "));
			if ((candidate.retirementHoldCount ?? 0) > (candidate.retirementHolds?.length ?? 0)) body.append(element("p", "warning", `${candidate.retirementHoldCount} evaluation bindings hold retirement; only a bounded subset is shown.`));
			for (const work of candidate.evaluationWork ?? []) addLabeledValue(body, `Evaluation work ${work.planId}`,
				work.active ? "Active: retirement held" : work.completion?.disposition === "cancelled" ? "Abandoned: hold released"
					: work.completion ? "Completed: hold released" : "Unresolved");
			addLabeledValue(body, "Context identity", candidate.contextDigest);
			addLabeledValue(body, "Independence claim", `${candidate.context.independence.method}: ${candidate.context.independence.reason}`);
			addLabeledValue(body, "Generation inputs", candidate.context.generation.map((artifact) => `${artifact.kind}: ${artifact.ref} (${artifact.digest})`).join("; ") || "None");
			addLabeledValue(body, "Comparison only", candidate.context.comparisonOnly.map((artifact) => `${artifact.ref} (${artifact.digest})`).join("; ") || "None");
			if (candidate.assurance.missing.length) body.append(element("p", "warning", candidate.assurance.missing.join("; ")));
			for (const evidence of candidate.evidence) {
				const report = document.createElement("details");
				report.append(element("summary", "", `${evidence.evaluation.id}@${evidence.evaluation.revision}: ${evidence.outcome} (${evidence.trust})`));
				addLabeledValue(report, "Publication receipt", evidence.id);
				addLabeledValue(report, "Observation disposition", evidence.publicationDisposition);
				addLabeledValue(report, "Provenance", `${evidence.source.ref}; ${evidence.source.actor}`);
				if (evidence.source.kind === "human") addLabeledValue(report, "Claimed judgment source ID", evidence.source.judgmentId ?? "Legacy source reference only");
				addLabeledValue(report, "Observed", evidence.source.at);
				addLabeledValue(report, "Published", evidence.recordedAt);
				addLabeledValue(report, "Context", `${evidence.environment}; ${evidence.workload}`);
				report.append(element("pre", "", evidence.report));
				body.append(report);
			}
			if (candidate.evidenceTruncated) body.append(element("p", "muted", `Showing recent evidence from ${candidate.evidenceCount} retained reports.`));
			if (!candidate.selection && !readOnlyInteractions && hasPlan) {
				const controls = element("div", "card-actions");
				for (const decision of ["accept", "reject"]) {
					const button = document.createElement("button");
					button.type = "button";
					button.textContent = decision === "accept" ? "Select replacement" : "Reject candidate";
					button.disabled = decision === "accept" && !candidate.assurance.ready;
					button.setAttribute("aria-label", `${button.textContent} ${candidate.id}`);
					button.addEventListener("click", () => planAction({
						action: "decide-candidate", revision: getPlanRevision(), factoryRevision: factoryView().revision,
						candidateId: candidate.id, decision, expectedIncumbentId: factoryView().units.find((unit) => unit.id === candidate.unitId)?.currentCandidateId ?? null,
					}, button, () => {
						const actor = window.prompt("Who is making this candidate decision?");
						if (!actor?.trim()) return null;
						const reason = window.prompt("Why select or reject this candidate against the pinned contract?");
						return reason?.trim() && window.confirm(`${decision === "accept" ? "Select" : "Reject"} ${candidate.id}? This does not deploy or delete artifacts.`)
							? { actor: actor.trim(), reason: reason.trim() } : null;
					}));
					controls.append(button);
				}
				body.append(controls);
			}
		});
		for (const renewal of currentFactory.renewals ?? []) addRow(`renewal:${renewal.id}`, `Renewal ${renewal.id} - ${renewal.status}`, renewal, (body) => {
			addLabeledValue(body, "Trigger", renewal.signalId);
			addLabeledValue(body, "Known affected capabilities", renewal.affectedUnitIds.join(", ") || "Unknown");
			addLabeledValue(body, "Uncertain impact", renewal.uncertainUnitIds.join(", ") || "None under declared relationships");
			addLabeledValue(body, "Localization", renewal.localization);
			addLabeledValue(body, "Accepted decisions", renewal.decisionIds?.join(", "));
			addLabeledValue(body, "Candidates", renewal.candidateIds?.join(", "));
			addLabeledValue(body, "Still requiring support", renewal.pendingUnitIds?.join(", "));
			body.append(element("p", "", renewal.proposal));
			const signal = factory.signals.find((entry) => entry.id === renewal.signalId);
			addLabeledValue(body, "Observation", signal?.summary);
			addLabeledValue(body, "Provenance", signal ? `${signal.source.ref}; ${signal.source.actor}; ${signal.source.at}` : null);
		});
		for (const entry of currentFactory.retirements ?? []) addRow(`retired:${entry.type}:${entry.id}:${entry.revision ?? ""}`, `Retired ${entry.type}: ${entry.id}`, entry, (body) => {
			addLabeledValue(body, "Retained lesson", entry.summary);
			addLabeledValue(body, "Decision", `${entry.actor}: ${entry.reason}; ${entry.at}`);
			body.append(element("p", "muted", entry.retention));
		});
		for (const entry of currentFactory.compactions ?? []) addRow(`compaction:${entry.id}`, `Ledger compaction: ${entry.id}`, entry, (body) => {
			addLabeledValue(body, "Decision", `${entry.actor}: ${entry.reason}; ${entry.at}`);
			body.append(element("p", "muted", entry.retention));
		});
		for (const id of factoryRows.keys()) if (!seen.has(id)) factoryRows.delete(id);
		// Reuse existing disclosure nodes so refreshes preserve focus and open state.
		for (const [index, row] of rows.entries()) {
			if (host.children[index] !== row) host.insertBefore(row, host.children[index] ?? null);
		}
		for (const child of [...host.children].slice(rows.length)) child.remove();
	}
	return {
		/** @param {PlanSnapshot["factory"] | null} factory @param {boolean} readOnly @param {boolean} availablePlan */
		update(factory, readOnly, availablePlan) {
			currentFactory = factory;
			readOnlyInteractions = readOnly;
			hasPlan = availablePlan;
			renderFactory();
		},
	};
}
